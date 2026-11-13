#!/usr/bin/env node
// IPA 内容清单：结构、资源、体积、异常项。
// 全程内存读取（本机解包到磁盘的 .app 会被清理）。
//
// 用法: node ipainv.cjs <file.ipa|zip含ipa>
const fs = require('fs');
const zlib = require('zlib');

function readZip(buf) {
  let e = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { e = i; break; }
  }
  if (e < 0) throw new Error('不是 zip');
  const cnt = buf.readUInt16LE(e + 10);
  let off = buf.readUInt32LE(e + 16);
  const out = [];
  for (let n = 0; n < cnt; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const m = buf.readUInt16LE(off + 10);
    const cs = buf.readUInt32LE(off + 20);
    const us = buf.readUInt32LE(off + 24);
    const nl = buf.readUInt16LE(off + 28);
    const el = buf.readUInt16LE(off + 30);
    const cl = buf.readUInt16LE(off + 32);
    const lo = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nl).toString('utf8');
    const lnl = buf.readUInt16LE(lo + 26);
    const lel = buf.readUInt16LE(lo + 28);
    const ds = lo + 30 + lnl + lel;
    out.push({ name, comp: cs, size: us, method: m, dataStart: ds, dataEnd: ds + cs });
    off += 46 + nl + el + cl;
  }
  return { entries: out, buf };
}

function extract(z, entry) {
  const raw = z.buf.slice(entry.dataStart, entry.dataEnd);
  return entry.method === 0 ? raw : zlib.inflateRawSync(raw);
}

let z = readZip(fs.readFileSync(process.argv[2]));
// 若外层只有一个 .ipa，钻进去
if (z.entries.length === 1 && /\.ipa$/i.test(z.entries[0].name)) {
  console.log(`外层: ${z.entries[0].name}  ${z.entries[0].size} B`);
  z = readZip(extract(z, z.entries[0]));
}

const entries = z.entries.filter((e) => !e.name.endsWith('/'));
const dirs = z.entries.filter((e) => e.name.endsWith('/'));
console.log(`IPA 条目: ${entries.length} 文件 + ${dirs.length} 目录\n`);

// 按顶层分类
const top = {};
for (const e of entries) {
  const parts = e.name.split('/');
  const k = parts.length > 2 ? parts.slice(0, 3).join('/') : e.name;
  top[k] = (top[k] || 0) + 1;
}
console.log('=== 按路径前缀统计（≥3 个才列出）===');
for (const [k, v] of Object.entries(top).sort((a, b) => b[1] - a[1])) {
  if (v >= 3) console.log(`  ${String(v).padStart(4)}  ${k}`);
}

console.log('\n=== 关键条目 ===');
const want = [
  'Info.plist', 'CoomiIOS', 'PkgInfo', 'linux-rootfs.tar.gz',
  'web/index.html', 'web/assets',
];
for (const w of want) {
  const hit = entries.filter((e) => e.name.endsWith(w) || e.name.includes(w));
  console.log(`  ${hit.length ? '✅' : '❌'} ${w.padEnd(22)} ${hit.length} 项`);
}

console.log('\n=== 异常检查 ===');
const flutter = entries.filter((e) => /flutter|App\.framework|Runner\.app|libapp\.so/i.test(e.name));
console.log(`  ${flutter.length === 0 ? '✅' : '❌'} 无 Flutter 痕迹（${flutter.length} 项）`);
const src = entries.filter((e) => /\.(swift|c|h|rs|ts|vue|map)$/i.test(e.name));
console.log(`  ${src.length === 0 ? '✅' : '⚠'} 无源码残留（${src.length} 项）`);
const dsym = entries.filter((e) => /\.dSYM|\.pdb/i.test(e.name));
console.log(`  ${dsym.length === 0 ? '✅' : '⚠'} 无调试符号残留（${dsym.length} 项）`);

const webFiles = entries.filter((e) => /\/web\//.test(e.name));
const webSize = webFiles.reduce((s, e) => s + e.size, 0);
console.log(`\n  web/ ${webFiles.length} 文件，解压后 ${(webSize / 1024).toFixed(0)} KB`);
const assets = webFiles.filter((e) => /\/assets\//.test(e.name));
console.log(`  其中 assets/ ${assets.length} 文件`);
const idx = webFiles.find((e) => e.name.endsWith('/index.html'));
if (idx) {
  const html = extract(z, idx).toString('utf8');
  const refs = [...html.matchAll(/["']([^"']*assets\/[^"']+)["']/g)].map((m) => m[1]);
  console.log(`  index.html 引用 ${refs.length} 个 asset`);
  const missing = refs.filter((r) => {
    const base = r.replace(/^\.?\//, '');
    return !webFiles.some((e) => e.name.endsWith('/' + base) || e.name.endsWith(base));
  });
  console.log(`  ${missing.length === 0 ? '✅' : '❌'} 引用的 asset 都存在${missing.length ? '（缺 ' + missing.length + '）' : ''}`);
  for (const m of missing.slice(0, 5)) console.log(`      缺: ${m}`);
}
