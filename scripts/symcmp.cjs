#!/usr/bin/env node
// 从「zip 里套 ipa」的结构直接读主二进制并做符号对照 —— 全程不落地。
//
// 起因：本机把 IPA 解包到磁盘后，.app 里的主二进制会在几十秒内被清理掉，
// 导致后续命令报「路径不存在」，看起来像代码问题。改成纯内存读取。
//
// 用法: node symcmp.cjs <baseline.zip|ipa> <new.zip|ipa>
const fs = require('fs');
const zlib = require('zlib');

/** 从 zip buffer 取出所有条目（只解需要的那几个）。 */
function readZip(buf, pred) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e === -1) throw new Error('不是 zip');
  const cnt = buf.readUInt16LE(e + 10);
  let off = buf.readUInt32LE(e + 16);
  const out = [];
  for (let n = 0; n < cnt; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const m = buf.readUInt16LE(off + 10);
    const cs = buf.readUInt32LE(off + 20);
    const nl = buf.readUInt16LE(off + 28);
    const el = buf.readUInt16LE(off + 30);
    const cl = buf.readUInt16LE(off + 32);
    const lo = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nl).toString('utf8');
    if (pred(name)) {
      const lnl = buf.readUInt16LE(lo + 26);
      const lel = buf.readUInt16LE(lo + 28);
      const ds = lo + 30 + lnl + lel;
      const raw = buf.slice(ds, ds + cs);
      out.push({ name, data: m === 0 ? raw : zlib.inflateRawSync(raw) });
    }
    off += 46 + nl + el + cl;
  }
  return out;
}

/** 逐层剥：zip → ipa → 主二进制。 */
function loadBinary(file) {
  let buf = fs.readFileSync(file);
  const isZip = (b) => b.length > 4 && b.readUInt32LE(0) === 0x04034b50;
  if (!isZip(buf)) return { name: file, data: buf };
  // 第一层：可能是 ipa 本身，也可能是含 ipa 的 zip
  let entries = readZip(buf, () => true);
  if (entries.length === 1 && /\.ipa$/i.test(entries[0].name)) {
    buf = entries[0].data;
    entries = readZip(buf, () => true);
  }
  const bin = entries
    .filter((e) => /^Payload\/[^/]+\.app\/[^/]+$/.test(e.name))
    .filter((e) => !/\.(plist|png|jpg|css|js|html|gz|ttf)$/.test(e.name))
    .sort((a, b) => b.data.length - a.data.length)[0];
  if (!bin) throw new Error('没找到主二进制: ' + file);
  return bin;
}

function count(hay, needle) {
  const n = Buffer.from(needle, 'utf8');
  let c = 0, i = 0;
  for (;;) {
    const j = hay.indexOf(n, i);
    if (j === -1) break;
    c++; i = j + 1;
  }
  return c;
}

const [, , B, N] = process.argv;
const base = loadBinary(B);
const news = loadBinary(N);
console.log(`基线 ${base.name}  ${base.data.length} B`);
console.log(`新版 ${news.name}  ${news.data.length} B`);
console.log(`差额 ${news.data.length - base.data.length} B\n`);

const groups = [
  ['本次新增的符号', [
    'bootWithReport', 'runProbe', 'lastBootReport', 'ISHReportCard',
    'ISHBootReport', 'prepareFailed', 'probeFailed',
  ], 0],
  ['改动前就有的符号（对照）', [
    'ISHBridge', 'EngineController', 'ReadinessChecker',
    'TarGzExtractor', 'coomi_start', 'coomi_version',
  ], 1],
  ['本次新增的中文界面串', [
    'Linux 工作环境就绪', 'boot 返回码', 'iSH 诊断', 'fakefs 已铺好',
  ], 0],
];

for (const [title, list, expectBase] of groups) {
  console.log(`=== ${title} ===`);
  for (const s of list) {
    const a = count(base.data, s);
    const b = count(news.data, s);
    const ok = expectBase === 0 ? (a === 0 && b >= 1) : (a >= 1 && b >= 1);
    console.log(`  ${ok ? '✅' : '❌'} ${s.padEnd(18)} 基线 ${String(a).padStart(4)}   新版 ${String(b).padStart(4)}`);
  }
  console.log('');
}
