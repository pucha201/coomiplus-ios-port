#!/usr/bin/env node
// Swift 源码结构检查（本地没有 swiftc，只能做语法级静态校验）。
//
// 检查项（都是"改完手抖"最容易犯的错）：
//   1. 括号 / 方括号 / 花括号是否平衡（跳过字符串、注释、字符字面量）
//   2. 是否残留冲突标记（<<<<<<< / ======= / >>>>>>>）
//   3. 是否残留我自己的占位符（TODO-CODEX / XXX-REPLACE）
//   4. 每个 `struct X: View` 是否有配对的 body
//   5. 文本文件是否含非 UTF-8 字节
//
// 明确不做的事：不解析类型系统、不校验 API 存在性。它只能证明
// "结构没坏"，不能证明 "能编译过" —— 后者必须上 Xcode。

const fs = require('fs');
const path = require('path');

/** 逐字符扫描，把字符串 / 注释 / 字符字面量跳过，只统计结构性括号。 */
function scanBalanced(src) {
  const stack = [];
  const pairs = { ')': '(', ']': '[', '}': '{' };
  let i = 0;
  let line = 1;
  // Swift 支持嵌套块注释 /* /* */ */
  let blockDepth = 0;
  const errors = [];

  while (i < src.length) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '\n') { line++; i++; continue; }

    // 块注释（可嵌套）
    if (blockDepth > 0) {
      if (c === '/' && c2 === '*') { blockDepth++; i += 2; continue; }
      if (c === '*' && c2 === '/') { blockDepth--; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && c2 === '*') { blockDepth++; i += 2; continue; }

    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }

    // 三引号多行字符串
    if (c === '"' && src.startsWith('"""', i)) {
      i += 3;
      while (i < src.length && !src.startsWith('"""', i)) {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') line++;
        i++;
      }
      i += 3;
      continue;
    }

    // 普通字符串（含 \( ) 插值——插值里的括号是真实代码，但为简单起见
    // 整段跳过；这会让 `"\(foo(bar))"` 里的括号不被计数，属可接受的漏报）
    if (c === '"') {
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\') i++;
        if (src[i] === '\n') { line++; }
        i++;
      }
      i++;
      continue;
    }

    // 字符字面量 'a' / '\n' （Swift 里较少，但 # 不是）
    if (c === "'") {
      i++;
      while (i < src.length && src[i] !== "'") { if (src[i] === '\\') i++; i++; }
      i++;
      continue;
    }

    if (c === '(' || c === '[' || c === '{') {
      stack.push({ ch: c, line });
      i++; continue;
    }
    if (c === ')' || c === ']' || c === '}') {
      const top = stack.pop();
      if (!top) {
        errors.push(`第 ${line} 行：多余的 '${c}'（没有配对的 '${pairs[c]}'）`);
      } else if (top.ch !== pairs[c]) {
        errors.push(`第 ${line} 行：'${c}' 与第 ${top.line} 行的 '${top.ch}' 不配对`);
      }
      i++; continue;
    }
    i++;
  }

  if (blockDepth > 0) errors.push(`块注释未闭合（还剩 ${blockDepth} 层）`);
  for (const left of stack) {
    errors.push(`第 ${left.line} 行的 '${left.ch}' 未闭合`);
  }
  return errors;
}

/** 数出 `struct X: View` 与 `var body` 的出现次数，粗略核对配对。 */
function checkViewBodies(src) {
  const viewStructs = [...src.matchAll(/struct\s+(\w+)\s*:\s*View\b/g)].map(m => m[1]);
  const bodies = (src.match(/\bvar\s+body\s*:\s*some\s+View\b/g) || []).length;
  const problems = [];
  if (viewStructs.length !== bodies) {
    problems.push(
      `struct ... : View 有 ${viewStructs.length} 个（${viewStructs.join(', ')}），` +
      `但 var body: some View 只有 ${bodies} 个`
    );
  }
  return { viewStructs, bodies, problems };
}

const files = process.argv.slice(2);
if (files.length === 0) {
  console.error('用法: node swiftcheck.cjs <file.swift> [...]');
  process.exit(2);
}

let failed = 0;
for (const f of files) {
  const abs = path.resolve(f);
  const raw = fs.readFileSync(abs);
  const label = path.basename(abs);
  const problems = [];

  // UTF-8 校验
  const text = raw.toString('utf8');
  if (Buffer.from(text, 'utf8').compare(raw) !== 0) {
    problems.push('含非法 UTF-8 字节序列');
  }

  // 冲突标记
  const conflicts = text.split('\n')
    .map((l, n) => ({ l, n: n + 1 }))
    .filter(({ l }) => /^(<{7}|={7}|>{7})(\s|$)/.test(l));
  for (const c of conflicts) problems.push(`第 ${c.n} 行：残留冲突标记 "${c.l.trim()}"`);

  // 占位符
  for (const marker of ['TODO-CODEX', 'XXX-REPLACE', '__PLACEHOLDER__']) {
    if (text.includes(marker)) problems.push(`残留占位符 ${marker}`);
  }

  problems.push(...scanBalanced(text));
  const vb = checkViewBodies(text);
  problems.push(...vb.problems);

  if (problems.length === 0) {
    const extra = vb.viewStructs.length ? `（${vb.viewStructs.length} 个 View struct）` : '';
    console.log(`✅ ${label}  结构平衡${extra}`);
  } else {
    failed++;
    console.log(`❌ ${label}`);
    for (const p of problems) console.log(`     ${p}`);
  }
}

process.exit(failed === 0 ? 0 : 1);
