#!/usr/bin/env node
// 死代码扫描：找出「定义了但全项目从未被引用」的 Swift 函数 / 属性 / 类型。
//
// 起因：iSH 集成里 `ISHBridge.boot()` 定义了却零调用，内核链进二进制却永不启动。
// 这类静默失效不会报错、不会崩，只在真机上表现为「功能没反应」——最难发现。
// 所以要机械地扫一遍，而不是靠读代码时「觉得好像有人用」。
//
// 判据：一个 func/property 的名字，如果除了它自己的声明行之外，
// 在整个 Sources 目录里**一次都没出现过**，那它就是死代码。
//
// 会漏报的情况（宁可漏，不可误报）：
//   · 协议实现 / @objc 选择器：名字可能只由运行时使用
//   · SwiftUI 的 body / 属性包装器
//   · 被 C 调用的 @_silgen_name 函数
// 这些一律进白名单，不报。
//
// 用法: node deadcode.cjs <sourcesDir>
const fs = require('fs');
const path = require('path');

const DIR = process.argv[2];
if (!DIR) { console.error('用法: node deadcode.cjs <sourcesDir>'); process.exit(2); }

const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.swift') || f.endsWith('.c'));
const src = new Map();
for (const f of files) src.set(f, fs.readFileSync(path.join(DIR, f), 'utf8'));
const allText = [...src.values()].join('\n');

// 白名单：这些名字由框架/运行时/C 使用，静态扫不出引用
const WHITELIST = new Set([
  'body', 'init', 'deinit', 'main', 'shared',
  // SwiftUI
  'makeBody', 'makeUIView', 'updateUIView', 'makeCoordinator',
  // 协议/生命周期
  'encode', 'decode', 'hash', 'description', 'debugDescription',
  'start', 'stop', 'cancel', 'resume', 'pause',
  // 属性包装器访问器
  'wrappedValue', 'projectedValue',
  // C ABI（由 Rust 导出、Swift @_silgen_name 引用）
  'coomi_start', 'coomi_port', 'coomi_version',
  'coomi_ish_boot', 'coomi_ish_run', 'coomi_ish_free', 'coomi_ish_shutdown',
  'ish_available', 'ish_embed_boot', 'ish_embed_run_oneshot', 'ish_embed_free',
  'ish_embed_shutdown', 'ish_embed_spawn', 'ish_embed_session_open',
]);

const findings = [];

for (const [file, text] of src) {
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    // 匹配 func / var / let / class / struct / enum 的声明
    const m = line.match(/^\s*(?:@\w+(?:\([^)]*\))?\s+)*(?:(?:public|private|internal|fileprivate|open|final|static|class|nonisolated|override|mutating|@\w+)\s+)*\b(func|var|let|class|struct|enum)\s+([A-Za-z_]\w*)/);
    if (!m) return;
    const kind = m[1];
    const name = m[2];
    if (WHITELIST.has(name)) return;
    if (name.length < 4) return;              // 太短的名字容易误判
    if (/^\s*\/\//.test(line)) return;        // 注释行

    // 统计整个项目里这个名字出现的总次数（按单词边界）
    const re = new RegExp(`\\b${name}\\b`, 'g');
    const total = (allText.match(re) || []).length;

    // 声明行本身算 1 次。总计 <= 1 说明除声明外无人提及。
    if (total <= 1) {
      findings.push({ file, line: i + 1, kind, name, text: line.trim() });
    }
  });
}

console.log(`扫描 ${files.length} 个文件（${[...src.values()].join('').length} 字符）\n`);
if (findings.length === 0) {
  console.log('✅ 未发现死代码');
} else {
  console.log(`⚠ 发现 ${findings.length} 处「定义了但无人引用」：\n`);
  for (const f of findings) {
    console.log(`  ${f.file}:${f.line}  [${f.kind}] ${f.name}`);
    console.log(`      ${f.text}`);
  }
  console.log('\n注意：这些是**候选**，需人工确认不是协议实现 / @objc / 由运行时调用。');
}
process.exit(0);
