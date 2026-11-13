#!/usr/bin/env node
// 不解包、直接从 IPA（zip）里读主二进制做字符串对照。
//
// 为什么要这样：本机把 IPA 解包到磁盘后，解出来的 .app 目录里的主二进制
// 会在几十秒内消失（杀软/清理行为），导致后续命令报「路径不存在」而
// 看起来像代码问题。改成流式读取 zip 条目，完全不落地。
//
// IPA 是 zip，主二进制在 Payload/*.app/<CFBundleExecutable>，通常是 store 压缩。
// 这里只支持 stored(0) 与 deflate(8) 两种方法，够用。
//
// 用法: node ipastr.cjs <file.ipa|binary> <string1> [string2 ...]
const fs = require('fs');
const zlib = require('zlib');

/** 从 zip buffer 里取出指定后缀的最大条目内容。 */
function readZipEntry(buf, namePredicate) {
  // 从尾部找 EOCD
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 70000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('不是有效 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  let best = null;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const cmtLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    if (namePredicate(name)) {
      // 读 local header 拿真实数据起点
      const lnameLen = buf.readUInt16LE(localOff + 26);
      const lextraLen = buf.readUInt16LE(localOff + 28);
      const dataStart = localOff + 30 + lnameLen + lextraLen;
      const raw = buf.slice(dataStart, dataStart + compSize);
      let data;
      if (method === 0) data = raw;
      else if (method === 8) data = zlib.inflateRawSync(raw);
      else throw new Error(`不支持的压缩方法 ${method}（${name}）`);
      if (!best || data.length > best.data.length) best = { name, data };
    }
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return best;
}

/** 数 UTF-8 子串出现次数（按字节匹配，跨边界也无所谓）。 */
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

const [, , FILE, ...STRINGS] = process.argv;
if (!FILE || STRINGS.length === 0) {
  console.error('用法: node ipastr.cjs <file.ipa|binary> <string1> [string2 ...]');
  process.exit(2);
}

const buf = fs.readFileSync(FILE);
let bin;
let label;
if (buf.length > 4 && buf.readUInt32LE(0) === 0x04034b50) {
  const e = readZipEntry(buf, (n) => /^Payload\/[^/]+\.app\/[^/]+$/.test(n) && !/\.(plist|png|jpg|css|js|html|gz|ttf)$/.test(n));
  if (!e) throw new Error('没找到主二进制条目');
  bin = e.data;
  label = e.name;
} else {
  bin = buf;
  label = FILE.split(/[\\/]/).pop();
}
console.log(`读取 ${label}  ${bin.length} B\n`);

for (const s of STRINGS) {
  console.log(`  ${String(count(bin, s)).padStart(3)}  ${s}`);
}
