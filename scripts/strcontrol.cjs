#!/usr/bin/env node
// 对照实验：同一批字符串在「改动前」与「改动后」的主二进制里各出现几次。
//
// 为什么要做对照而不是只搜新版：
//   只在新版里搜到字符串，可能是巧合（比如别的库也含同样的字）。
//   只有在**基线里为 0、新版里 ≥1**，才能证明这些字符串来自本次改动。
//
// 用法: node strcontrol.cjs <baselineBin> <newBin>
const fs = require('fs');

const [, , BASE, NEW] = process.argv;
if (!BASE || !NEW) {
  console.error('用法: node strcontrol.cjs <baselineBin> <newBin>');
  process.exit(2);
}

/** 在二进制里数某个 UTF-8 子串出现次数（按字节匹配）。 */
function count(haystack, needle) {
  const n = Buffer.from(needle, 'utf8');
  let c = 0;
  let i = 0;
  for (;;) {
    const j = haystack.indexOf(n, i);
    if (j === -1) break;
    c++;
    i = j + 1;
  }
  return c;
}

const base = fs.readFileSync(BASE);
const news = fs.readFileSync(NEW);
console.log(`基线 ${BASE.split(/[\\/]/).pop()}  ${base.length} B`);
console.log(`新版 ${NEW.split(/[\\/]/).pop()}  ${news.length} B`);
console.log(`差额 ${news.length - base.length} B\n`);

// 本次改动新增的界面字符串（应当只在新版出现）
const ADDED = [
  'Linux 工作环境就绪',
  'Linux 工作环境不可用',
  '正在准备 Linux 工作环境',
  'boot 返回码',
  'iSH 诊断',
  'fakefs 已铺好',
  '自检 stdout',
  '自检 stderr',
  '自检退出码',
  '已链接静态库',
  '尚未尝试启动',
  '内核已在运行',
];

// 对照组：改动前后都该存在的字符串（证明搜索方法本身有效）
const CONTROL = [
  'CoomiPlus',
  'http://127.0.0.1',
  'linux-rootfs',
  'coomi-home',
];

console.log('=== 新增字符串（预期：基线 0，新版 ≥1）===');
let addedOk = 0;
let addedBad = [];
for (const s of ADDED) {
  const a = count(base, s);
  const b = count(news, s);
  const mark = a === 0 && b >= 1 ? '✅' : (a === 0 && b === 0 ? '⚠ 两版都没有' : '❓');
  if (a === 0 && b >= 1) addedOk++;
  else addedBad.push({ s, a, b });
  console.log(`  ${mark} ${s.padEnd(24)} 基线 ${String(a).padStart(3)}   新版 ${String(b).padStart(3)}`);
}

console.log('\n=== 对照组（预期：两版都 ≥1，证明搜索方法有效）===');
for (const s of CONTROL) {
  const a = count(base, s);
  const b = count(news, s);
  const mark = a >= 1 && b >= 1 ? '✅' : '❌';
  console.log(`  ${mark} ${s.padEnd(24)} 基线 ${String(a).padStart(3)}   新版 ${String(b).padStart(3)}`);
}

console.log(`\n新增字符串命中：${addedOk}/${ADDED.length}`);
if (addedBad.length) {
  console.log('未命中的（需要单独解释，不能默认它们"被优化掉了"）：');
  for (const x of addedBad) console.log(`  「${x.s}」基线 ${x.a} 新版 ${x.b}`);
}
process.exit(addedOk > 0 ? 0 : 1);
