#!/usr/bin/env node
// 通过 gh-proxy 代理下载 GitHub artifact（本机 hosts 把 api.github.com 指到 127.0.0.1）。
//
// 关键点（踩过的坑）：
//   · artifact 下载会 302 到 objects.githubusercontent.com 或 S3，
//     那些主机必须**裸请求**，带上 Authorization 会被拒。
//   · 只有 api.github.com 的请求才带 token。
//   · gh-proxy 本身只代理 api.github.com 这类路径，重定向目标要直连。
//
// 用法: node getartifact.cjs <artifactId> <outFile>
const fs = require('fs');
const https = require('https');
const { execSync } = require('child_process');

const [, , ARTIFACT_ID, OUT] = process.argv;
if (!ARTIFACT_ID || !OUT) {
  console.error('用法: node getartifact.cjs <artifactId> <outFile>');
  process.exit(2);
}

const out = execSync('git credential fill', {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
});
const TOKEN = out.match(/^password=(.+)$/m)[1].trim();

function follow(url, depth = 0) {
  return new Promise((resolve, reject) => {
    if (depth > 8) return reject(new Error('重定向过多'));
    const u = new URL(url);
    const headers = { 'User-Agent': 'dsh' };
    // 只有 api.github.com 带 token；重定向目标一律裸请求
    if (u.host === 'api.github.com') headers.Authorization = `token ${TOKEN}`;
    if (u.host === 'gh-proxy.com') headers.Authorization = `token ${TOKEN}`;

    https.get({ host: u.host, path: u.pathname + u.search, headers, rejectUnauthorized: false }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(follow(res.headers.location, depth + 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} @ ${u.host}${u.pathname.slice(0, 80)}`));
      }
      const ws = fs.createWriteStream(OUT);
      res.pipe(ws);
      ws.on('finish', () => resolve(OUT));
      ws.on('error', reject);
    }).on('error', reject);
  });
}

const start = `https://gh-proxy.com/https://api.github.com/repos/pucha201/coomiplus-ios-port/actions/artifacts/${ARTIFACT_ID}/zip`;
follow(start)
  .then((p) => {
    const s = fs.statSync(p);
    console.log(`WROTE ${p}  ${s.size} bytes`);
  })
  .catch((e) => { console.error('ERR ' + e.message); process.exit(1); });
