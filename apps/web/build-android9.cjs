#!/usr/bin/env node
/**
 * 安卓 9（32 位）前端构建流水线。
 *
 * 为什么需要三段：
 *
 * 1. `vite build`（COOMI_ANDROID9_COMPAT=1）—— lightningcss 按 Chrome 70 降级。
 *    它能处理 color-mix / inset / clamp / :is，但**碰到 var() 就放弃**。
 *
 * 2. `compat-colormix.py` —— 给 color-mix 里的 var() 补字面量 fallback，
 *    让这些表达式变成 lightningcss 能算的形态。
 *
 * 3. 再跑一次 lightningcss —— 把这批补过的 color-mix 真正算成静态色。
 *    这一步不能用 vite build（会重新产出未补 fallback 的版本），
 *    所以直接调 lightningcss 处理产物。
 *
 * 4. `compat-android9.py` —— 处理 lightningcss 完全不管的那五类：
 *    flex gap / dvh / :has / overflow:clip / aspect-ratio。
 */

const { execFileSync } = require('node:child_process');
const { transform } = require('lightningcss');
const fs = require('node:fs');
const path = require('node:path');

const WEB = __dirname;
const DIST = path.join(WEB, 'dist', 'assets');
const SCRIPTS = path.resolve(WEB, '..', '..', 'scripts');

function run(cmd, args, env = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, {
    cwd: WEB,
    stdio: 'inherit',
    env: { ...process.env, ...env },
    shell: process.platform === 'win32',
  });
}

function runPython(script, args = []) {
  const python = process.platform === 'win32' ? 'python' : 'python3';
  run(python, [path.join(SCRIPTS, script), ...args]);
}

function main() {
  // ── 1. 构建 ──
  console.log('=== 1/4 构建（Chrome 70 目标）===');
  run('npm', ['run', 'build'], { COOMI_ANDROID9_COMPAT: '1' });

  // ── 2. 给 color-mix 补 var fallback ──
  console.log('\n=== 2/4 补 color-mix 的 var fallback ===');
  runPython('compat-colormix.py');

  // ── 3. 用 lightningcss 把补过的 color-mix 算成静态色 ──
  console.log('\n=== 3/4 lightningcss 求值 ===');
  const files = fs.readdirSync(DIST).filter((f) => f.endsWith('.css'));
  let evaluated = 0;
  for (const name of files) {
    const file = path.join(DIST, name);
    const code = fs.readFileSync(file);
    const before = code.toString();
    const result = transform({
      filename: name,
      code,
      targets: { chrome: 70 << 16 },
      minify: true,
    });
    const after = result.code.toString();
    if (after !== before) {
      fs.writeFileSync(file, after);
      evaluated += 1;
    }
  }
  console.log(`  改写了 ${evaluated} 个 CSS 文件`);

  // ── 4. 处理 lightningcss 不管的五类 ──
  console.log('\n=== 4/4 剩余五类降级 ===');
  runPython('compat-android9.py');
}

main();
