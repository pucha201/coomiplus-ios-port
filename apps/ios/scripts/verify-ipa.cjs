#!/usr/bin/env node
/**
 * iOS IPA 产物验证器 —— 不依赖 macOS 工具（无 otool / nm / unzip 也可跑）
 *
 * 校验项：
 *   1. zip → ipa 结构（Payload/CoomiIOS.app）
 *   2. 主二进制是 arm64 Mach-O、MH_EXECUTE
 *   3. .app 内必须含 web/index.html（引擎 ServeDir 的来源）
 *   4. .app 内 front-end 不能平铺在根目录
 *   5. linux-rootfs.tar.gz 存在且是有效 Alpine（含 bin/busybox）
 *   6. rootfs 的 uid/gid 已归一化为 0
 *   7. 未签名（无 _CodeSignature、无 embedded.mobileprovision）
 *
 * 用法：
 *   node verify-ipa.cjs <path-to.zip-or-ipa>
 *   退出码 0 = 全部通过；非 0 = 有失败项
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const input = process.argv[2];
if (!input) {
  console.error('用法: node verify-ipa.cjs <zip|ipa>');
  process.exit(2);
}

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? '  — ' + detail : ''}`);
}

// ── zip 读取（手写中央目录解析，避免依赖外部 unzip）──────────────────
function readZip(file) {
  const buf = fs.readFileSync(file);
  // 找 EOCD（0x06054b50），从尾部倒着扫
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 70000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效 zip（找不到 EOCD）');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);

  const entries = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(off) !== 0x02014b50) break;
    const method = buf.readUInt16LE(off + 10);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.slice(off + 46, off + 46 + nameLen).toString('utf8');
    // 本地头：跳过 name/extra 取数据
    const lNameLen = buf.readUInt16LE(localOff + 26);
    const lExtraLen = buf.readUInt16LE(localOff + 28);
    const dataStart = localOff + 30 + lNameLen + lExtraLen;
    const raw = buf.slice(dataStart, dataStart + compSize);
    let data;
    if (method === 0) data = raw;
    else if (method === 8) data = zlib.inflateRawSync(raw);
    else throw new Error(`不支持的压缩方式 ${method}: ${name}`);
    entries.push({ name, data, uncompSize });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ── tar 解析（gzip 后逐块读头）────────────────────────────────────────
function readTarGz(gzBuf) {
  const buf = zlib.gunzipSync(gzBuf);
  const names = [];
  let off = 0;
  while (off + 512 <= buf.length) {
    const block = buf.slice(off, off + 512);
    if (block.every((b) => b === 0)) break;
    let name = block.slice(0, 100).toString('utf8').replace(/\0.*$/, '');
    const sizeStr = block.slice(124, 136).toString('ascii').replace(/\0.*$/, '').trim();
    const size = parseInt(sizeStr, 8) || 0;
    const type = String.fromCharCode(block[156] || 48);
    const uid = parseInt(block.slice(108, 116).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const gid = parseInt(block.slice(116, 124).toString('ascii').replace(/\0.*$/, '').trim(), 8) || 0;
    const mode = block.slice(100, 108).toString('ascii').replace(/\0.*$/, '').trim();
    const prefix = block.slice(345, 500).toString('utf8').replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    const dataOff = off + 512;
    names.push({ name, size, type, uid, gid, mode, data: buf.slice(dataOff, dataOff + size) });
    off = dataOff + Math.ceil(size / 512) * 512;
  }
  return names;
}

// ── plist 解析（Xcode 会把 Info.plist 编译成 bplist00 二进制格式，
//    所以不能只按 XML 正则找，否则会误报"缺 CFBundleIdentifier"）──────
const TYPE = {
  SINGLETON: 0x0,
  INT: 0x1,
  REAL: 0x2,
  DATE: 0x3,
  DATA: 0x4,
  ASCII: 0x5,
  UTF16: 0x6,
  UID: 0x8,
  ARRAY: 0xa,
  SET: 0xc,
  DICT: 0xd,
};

function parseBplist(buf) {
  if (buf.slice(0, 8).toString('latin1') !== 'bplist00') {
    throw new Error('不是 bplist00');
  }
  const tail = buf.length - 32;
  const offsetSize = buf[tail + 6];
  const objectRefSize = buf[tail + 7];
  const numObjects = Number(buf.readBigUInt64BE(tail + 8));
  const topObject = Number(buf.readBigUInt64BE(tail + 16));
  const offsetTableOffset = Number(buf.readBigUInt64BE(tail + 24));

  // 读 offset table
  const offsets = [];
  for (let i = 0; i < numObjects; i++) {
    const at = offsetTableOffset + i * offsetSize;
    let v = 0;
    for (let k = 0; k < offsetSize; k++) v = v * 256 + buf[at + k];
    offsets.push(v);
  }

  const seen = new Set();

  function readLen(markerLow, at) {
    // 返回 [length, 数据起始偏移]
    if (markerLow !== 0x0f) return [markerLow, at];
    const m = buf[at];
    const t = m >> 4;
    if (t !== TYPE.INT) throw new Error('长度标记不是 int');
    const nbytes = 1 << (m & 0x0f);
    let v = 0;
    for (let k = 0; k < nbytes; k++) v = v * 256 + buf[at + 1 + k];
    return [v, at + 1 + nbytes];
  }

  function readObject(ref) {
    const off = offsets[ref];
    if (off === undefined) return null;
    const marker = buf[off];
    const high = marker >> 4;
    const low = marker & 0x0f;

    switch (high) {
      case TYPE.SINGLETON:
        if (low === 0x0) return null;
        if (low === 0x8) return false;
        if (low === 0x9) return true;
        return null;

      case TYPE.INT: {
        const nbytes = 1 << low;
        let v = 0;
        for (let k = 0; k < nbytes; k++) v = v * 256 + buf[off + 1 + k];
        // 有符号：最高位为 1 则负数
        const bits = nbytes * 8;
        if (v >= 2 ** (bits - 1)) v -= 2 ** bits;
        return v;
      }

      case TYPE.REAL: {
        const nbytes = 1 << low;
        if (nbytes === 4) return buf.readFloatBE(off + 1);
        if (nbytes === 8) return buf.readDoubleBE(off + 1);
        return null;
      }

      case TYPE.DATE: {
        const secs = buf.readDoubleBE(off + 1);
        // Apple epoch 2001-01-01
        return new Date(Date.UTC(2001, 0, 1) + secs * 1000);
      }

      case TYPE.DATA: {
        const [len, ds] = readLen(low, off + 1);
        return buf.slice(ds, ds + len);
      }

      case TYPE.ASCII: {
        const [len, ds] = readLen(low, off + 1);
        return buf.slice(ds, ds + len).toString('latin1');
      }

      case TYPE.UTF16: {
        const [len, ds] = readLen(low, off + 1);
        // len 是字符数，字节数是 len*2
        const raw = buf.slice(ds, ds + len * 2);
        // 转成 UTF-16BE buffer 再解码
        const swapped = Buffer.alloc(raw.length);
        for (let i = 0; i < raw.length; i += 2) {
          swapped[i] = raw[i + 1];
          swapped[i + 1] = raw[i];
        }
        return swapped.toString('utf16le');
      }

      case TYPE.UID: {
        const nbytes = low + 1;
        let v = 0;
        for (let k = 0; k < nbytes; k++) v = v * 256 + buf[off + 1 + k];
        return v;
      }

      case TYPE.ARRAY:
      case TYPE.SET: {
        const [len, ds] = readLen(low, off + 1);
        const out = [];
        for (let i = 0; i < len; i++) {
          let r = 0;
          for (let k = 0; k < objectRefSize; k++) r = r * 256 + buf[ds + i * objectRefSize + k];
          out.push(readObject(r));
        }
        return out;
      }

      case TYPE.DICT: {
        const [len, ds] = readLen(low, off + 1);
        const out = {};
        // keyrefs 在前，valuerefs 在后
        const keyBase = ds;
        const valBase = ds + len * objectRefSize;
        for (let i = 0; i < len; i++) {
          let kr = 0;
          for (let k = 0; k < objectRefSize; k++) kr = kr * 256 + buf[keyBase + i * objectRefSize + k];
          let vr = 0;
          for (let k = 0; k < objectRefSize; k++) vr = vr * 256 + buf[valBase + i * objectRefSize + k];
          const key = readObject(kr);
          if (typeof key !== 'string') continue;
          out[key] = readObject(vr);
        }
        return out;
      }

      default:
        return null;
    }
  }

  return readObject(topObject);
}

function readPlist(data) {
  const ascii = data.toString('latin1');
  if (ascii.startsWith('bplist00')) {
    if (!parseBplist) throw new Error('需要 bplist.cjs 才能解析二进制 plist');
    return { binary: true, obj: parseBplist(data) };
  }
  // XML：把 <key>k</key><string>v</string> 抽成对象
  const txt = data.toString('utf8');
  const obj = {};
  const re = /<key>([^<]+)<\/key>\s*<(string|integer|true|false)>([^<]*)</g;
  let m;
  while ((m = re.exec(txt))) {
    if (m[2] === 'string') obj[m[1]] = m[3];
    else if (m[2] === 'integer') obj[m[1]] = Number(m[3]);
    else obj[m[1]] = m[2] === 'true';
  }
  return { binary: false, obj };
}

// ── Mach-O 头 ─────────────────────────────────────────────────────────
function machoHeader(data) {
  if (data.length < 32) return null;
  const le = data.readUInt32LE(0);
  const be = data.readUInt32BE(0);
  let swap = false;
  let is64 = false;
  if (le === 0xfeedfacf) is64 = true;
  else if (be === 0xfeedfacf) { is64 = true; swap = true; }
  else if (le === 0xfeedface) is64 = false;
  else if (be === 0xfeedface) { is64 = false; swap = true; }
  else return null;
  const rd = (o) => (swap ? data.readUInt32BE(o) : data.readUInt32LE(o));
  return { is64, magic: is64 ? '0xFEEDFACF' : '0xFEEDFACE', cputype: rd(4), cpusubtype: rd(8), filetype: rd(12) };
}

const CPU = { 16777228: 'CPU_TYPE_ARM64', 16777223: 'CPU_TYPE_X86_64', 7: 'CPU_TYPE_X86' };
const FILETYPE = { 1: 'MH_OBJECT', 2: 'MH_EXECUTE', 6: 'MH_DYLIB', 8: 'MH_BUNDLE' };

// ── 主流程 ───────────────────────────────────────────────────────────
try {
  console.log(`\n=== 验证 ${input} ===\n`);
  const sizeInit = fs.statSync(input).size;
  console.log(`输入: ${sizeInit} B = ${(sizeInit / 1024 / 1024).toFixed(2)} MB\n`);

  // 第一层：可能是 zip 包着 ipa，也可能直接是 ipa
  let outer = readZip(input);
  let ipaBuf;
  let ipaName;
  const ipaEntry = outer.find((e) => e.name.endsWith('.ipa'));
  if (ipaEntry) {
    console.log(`外层 zip 内含 ${ipaEntry.name}（${ipaEntry.data.length} B = ${(ipaEntry.data.length / 1024 / 1024).toFixed(2)} MB）\n`);
    ipaBuf = ipaEntry.data;
    ipaName = ipaEntry.name;
  } else {
    ipaBuf = fs.readFileSync(input);
    ipaName = path.basename(input);
  }

  // 第二层：ipa 内 Payload
  const tmp = path.join(os.tmpdir(), 'coomi-verify-' + Date.now() + '.ipa');
  fs.writeFileSync(tmp, ipaBuf);
  let entries;
  try {
    entries = readZip(tmp);
  } finally {
    // 保留 tmp 以便排查；成功时删
  }

  const appFiles = entries.filter((e) => /^Payload\/[^/]+\.app\//.test(e.name));
  check('ipa 结构 Payload/*.app 存在', appFiles.length > 0, `${appFiles.length} 个条目`);

  const appDir = (entries.find((e) => /^Payload\/[^/]+\.app\//.test(e.name)) || {}).name || '';
  const appRoot = appDir.split('/').slice(0, 2).join('/'); // Payload/Xxx.app
  const rel = (e) => e.name.slice(appRoot.length + 1);

  // 主二进制：Payload/Xxx.app/Xxx（与 .app 同名）
  const appName = appRoot.split('/')[1].replace(/\.app$/, '');
  const exeEntry = entries.find((e) => e.name === `${appRoot}/${appName}`);
  check(`主二进制 ${appName} 存在`, !!exeEntry, exeEntry ? `${exeEntry.uncompSize} B` : '缺失');

  if (exeEntry) {
    const h = machoHeader(exeEntry.data);
    check('主二进制是 Mach-O', !!h, h ? h.magic : '魔数不匹配');
    if (h) {
      check('架构是 arm64', h.cputype === 16777228, `${CPU[h.cputype] || h.cputype}`);
      check('类型是 MH_EXECUTE', h.filetype === 2, FILETYPE[h.filetype] || h.filetype);
      check('是 64 位', h.is64, h.is64 ? '64-bit' : '32-bit');
    }
    // C ABI 符号：字节级搜索
    const blob = exeEntry.data.toString('latin1');
    for (const s of ['coomi_start', 'coomi_port', 'coomi_version']) {
      check(`静态链入符号 ${s}`, blob.includes(s), blob.includes(s) ? '在二进制内' : '未找到');
    }

    // iSH 内核：App 里到底有没有 Linux 运行时。
    //
    // 这是「AI 能不能执行 shell 命令」的判据。只看有没有 rootfs 是不够的 ——
    // rootfs 只是文件系统数据；没有内核就是一堆死文件，装进包里除了占体积
    // 什么也不做。必须确认 ish_embed_* 这套嵌入式 ABI 真的被静态链进来了。
    const ishSyms = ['ish_embed_boot', 'ish_embed_run_oneshot', 'ish_embed_shutdown'];
    const ishHit = ishSyms.filter((s) => blob.includes(s));
    check('iSH 内核已静态链入', ishHit.length === ishSyms.length,
      ishHit.length ? `${ishHit.length}/${ishSyms.length} 个 ish_embed_* 符号` : '未找到（COOMI_HAS_ISH=0？）');
    // 内核内部符号，证明不是只有一层空壳。
    const kernelHit = ['become_first_process', 'kernel_init', 'do_execve'].filter((s) => blob.includes(s));
    check('iSH 内核代码在位', kernelHit.length >= 2,
      kernelHit.length ? kernelHit.join(', ') : '未找到内核符号');
  }

  // 前端
  const webFiles = entries.filter((e) => rel(e).startsWith('web/'));
  const webIndex = entries.find((e) => rel(e) === 'web/index.html');
  check('web/index.html 存在', !!webIndex, webIndex ? `${webIndex.uncompSize} B` : '缺失');
  check('前端在 web/ 子目录（未平铺）', webFiles.length > 0, `${webFiles.length} 个文件`);
  const rootIndex = entries.find((e) => rel(e) === 'index.html');
  check('根目录无 index.html（未污染 Bundle 根）', !rootIndex, rootIndex ? '发现平铺残留' : '干净');
  const rootAssets = entries.filter((e) => /^(index-|ChatView-|assets\/)/.test(rel(e)));
  check('根目录无前端 chunk 残留', rootAssets.length === 0, rootAssets.length ? `${rootAssets.length} 个残留` : '干净');

  // assets 子目录
  const assetsFiles = entries.filter((e) => rel(e).startsWith('web/assets/'));
  check('web/assets/ 存在', assetsFiles.length > 0, `${assetsFiles.length} 个文件`);

  // rootfs
  const rootfs = entries.find((e) => rel(e) === 'linux-rootfs.tar.gz');
  check('linux-rootfs.tar.gz 存在', !!rootfs, rootfs ? `${rootfs.uncompSize} B = ${(rootfs.uncompSize / 1024 / 1024).toFixed(2)} MB` : '缺失');
  if (rootfs) {
    let tar = null;
    try {
      tar = readTarGz(rootfs.data);
    } catch (e) {
      check('rootfs 是有效 gzip', false, e.message);
    }
    if (tar) {
      check('rootfs 是有效 gzip', true, `${tar.length} 个条目`);
      const bbPath = tar.find((t) => /^(\.\/)?bin\/busybox$/.test(t.name));
      check('rootfs 含 bin/busybox', !!bbPath, bbPath ? `${bbPath.size} B` : '缺失');
      const shLink = tar.find((t) => /^(\.\/)?bin\/sh$/.test(t.name));
      check('rootfs 含 bin/sh', !!shLink, shLink ? `type=${shLink.type}` : '缺失');
      const ws = tar.find((t) => /^(\.\/)?workspace\/$/.test(t.name));
      check('rootfs 含 /workspace', !!ws, ws ? '存在' : '缺失');
      const badUid = tar.filter((t) => t.uid !== 0 || t.gid !== 0);
      check('rootfs uid/gid 全为 0', badUid.length === 0,
        badUid.length === 0 ? '全部归一化' : `${badUid.length} 个条目非 0（如 ${badUid[0].name} uid=${badUid[0].uid}）`);
    }
  }

  // 签名状态
  const hasCodeSig = entries.some((e) => rel(e).startsWith('_CodeSignature/'));
  check('未签名（无 _CodeSignature）', !hasCodeSig, hasCodeSig ? '意外含签名' : '符合预期');
  const hasProv = entries.some((e) => rel(e) === 'embedded.mobileprovision');
  check('无 embedded.mobileprovision', !hasProv, hasProv ? '意外含描述文件' : '符合预期');

  // Info.plist 基本字段
  const plist = entries.find((e) => rel(e) === 'Info.plist');
  check('Info.plist 存在', !!plist, plist ? `${plist.uncompSize} B` : '缺失');
  if (plist) {
    let p = null;
    try {
      p = readPlist(plist.data);
    } catch (e) {
      check('Info.plist 可解析', false, e.message);
    }
    if (p) {
      check('Info.plist 格式', true, p.binary ? 'bplist00（二进制，Xcode 编译产物）' : 'XML');
      const get = (k) => (p.obj && p.obj[k] !== undefined ? p.obj[k] : null);

      const bundleId = get('CFBundleIdentifier');
      check('CFBundleIdentifier 存在', !!bundleId, bundleId || '未找到');
      if (bundleId) {
        check('bundle id 格式合法', /^[A-Za-z0-9.-]+$/.test(String(bundleId)), String(bundleId));
      }

      const exeName = get('CFBundleExecutable');
      check('CFBundleExecutable 存在', !!exeName, exeName || '未找到');
      check('CFBundleExecutable 与主二进制一致', exeName === appName, `plist=${exeName} 实际=${appName}`);

      const minOs = get('MinimumOSVersion');
      check('MinimumOSVersion 存在', !!minOs, minOs || '未找到');

      const plat = get('CFBundleSupportedPlatforms');
      check('平台是 iPhoneOS', Array.isArray(plat) ? plat.includes('iPhoneOS') : plat === 'iPhoneOS',
        Array.isArray(plat) ? plat.join(',') : String(plat));

      const ats = get('NSAppTransportSecurity');
      check('ATS 允许本地网络（引擎 127.0.0.1）',
        !!(ats && ats.NSAllowsLocalNetworking),
        ats ? `NSAllowsLocalNetworking=${ats.NSAllowsLocalNetworking}` : '未配置');
    }
  }

  try { fs.unlinkSync(tmp); } catch {}

  // 汇总
  const failed = results.filter((r) => !r.ok);
  console.log(`\n=== 汇总：${results.length - failed.length}/${results.length} 通过 ===`);
  if (failed.length) {
    console.log('\n失败项：');
    failed.forEach((f) => console.log(`  ❌ ${f.name}${f.detail ? ' — ' + f.detail : ''}`));
    process.exit(1);
  }
  console.log('✅ IPA 全部验证通过');
} catch (e) {
  console.error('\n验证器异常:', e.message);
  process.exit(2);
}
