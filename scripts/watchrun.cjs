#!/usr/bin/env node
// 轮询公开仓的某次 workflow run，直到完成；失败时把关键日志打出来。
//
// 本机 hosts 把 github.com 指到 127.0.0.1（加速器残留），git 协议不可用，
// 所有 GitHub 访问都走 gh-proxy.com 代理 API。
//
// 用法: node watchrun.cjs <runId> [owner/repo]
const https = require('https');
const { execSync } = require('child_process');

const RUN = process.argv[2];
const REPO = process.argv[3] || 'pucha201/coomiplus-ios-port';
if (!RUN) { console.error('用法: node watchrun.cjs <runId> [owner/repo]'); process.exit(2); }

function token() {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
  });
  const m = out.match(/^password=(.+)$/m);
  if (!m) throw new Error('拿不到 GitHub token');
  return m[1].trim();
}
const TOKEN = token();

function api(path) {
  return new Promise((resolve, reject) => {
    https.get({
      host: 'gh-proxy.com',
      path: `/https://api.github.com${path}`,
      headers: {
        Authorization: `token ${TOKEN}`,
        'User-Agent': 'dsh-watch',
        Accept: 'application/vnd.github+json',
      },
      rejectUnauthorized: false,
    }, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          try { resolve(JSON.parse(d)); } catch (e) { reject(e); }
        } else reject(new Error(`HTTP ${res.statusCode}: ${d.slice(0, 300)}`));
      });
    }).on('error', reject);
  });
}

/** 取某个 job 的日志（302 到 blob 存储，必须裸主机不带 Authorization）。 */
function fetchLog(jobId) {
  return new Promise((resolve) => {
    const follow = (url, depth) => {
      if (depth > 6) return resolve(null);
      const u = new URL(url);
      const headers = { 'User-Agent': 'dsh-watch' };
      if (u.host === 'api.github.com') headers.Authorization = `token ${TOKEN}`;
      https.get({
        host: u.host, path: u.pathname + u.search, headers, rejectUnauthorized: false,
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return follow(res.headers.location, depth + 1);
        }
        let d = '';
        res.on('data', (c) => (d += c));
        res.on('end', () => resolve(d));
      }).on('error', () => resolve(null));
    };
    follow(`https://api.github.com/repos/${REPO}/actions/jobs/${jobId}/logs`, 0);
  });
}

(async () => {
  const started = Date.now();
  let last = '';
  for (;;) {
    const jobs = await api(`/repos/${REPO}/actions/runs/${RUN}/jobs`);
    const summary = jobs.jobs
      .map((j) => `${j.name}=${j.status}${j.conclusion ? '/' + j.conclusion : ''}`)
      .join('  ');
    if (summary !== last) {
      const mins = ((Date.now() - started) / 60000).toFixed(1);
      console.log(`[+${mins}m] ${summary}`);
      last = summary;
    }
    if (jobs.jobs.every((j) => j.status === 'completed')) break;
    await new Promise((r) => setTimeout(r, 30000));
  }

  const jobs = await api(`/repos/${REPO}/actions/runs/${RUN}/jobs`);
  const failed = jobs.jobs.filter((j) => j.conclusion === 'failure');
  console.log('=== 结果 ===');
  for (const j of jobs.jobs) {
    const dur = j.started_at && j.completed_at
      ? ((new Date(j.completed_at) - new Date(j.started_at)) / 1000).toFixed(0) + 's'
      : '-';
    console.log(`  ${j.conclusion === 'success' ? '✅' : j.conclusion === 'skipped' ? '⏭' : '❌'} ${j.name}  (${dur}, ${j.steps ? j.steps.length : 0} steps, runner=${j.runner_name || '无'})`);
  }

  for (const j of failed) {
    console.log(`\n=== 失败 job「${j.name}」的关键日志 ===`);
    const log = await fetchLog(j.id);
    if (!log) { console.log('  （取不到日志）'); continue; }
    const lines = log.split('\n');
    const errs = lines.filter((l) => /error:|error C|FAILED|failed|::error::/.test(l));
    for (const l of errs.slice(0, 30)) console.log('  ' + l.trim().slice(0, 220));
    console.log('  --- 末尾 40 行 ---');
    for (const l of lines.slice(-40)) console.log('  ' + l.replace(/\r$/, '').slice(0, 220));
  }
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
