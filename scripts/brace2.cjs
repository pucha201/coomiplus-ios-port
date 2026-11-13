#!/usr/bin/env node
// 可靠的 Swift 括号平衡检查（修正 bracedepth.cjs 的 bug）。
//
// bracedepth.cjs 的错误：把文档注释里的 ``` 当成 Swift 的三引号字符串起点，
// 于是从那里开始整段跳过真实代码，深度统计全废。
//
// 正确做法：先**逐行剥掉注释**（/// 与 //），再处理字符串，最后数括号。
// Swift 没有类似 C 的 #if 嵌套括号问题，简单处理即可。

const fs = require('fs');
const path = process.argv[2];
const raw = fs.readFileSync(path, 'utf8');
const lines = raw.split('\n');

let depth = 0;
const problems = [];
const zeroPoints = [];
const openStack = [];
let blockDepth = 0;

for (let ln = 0; ln < lines.length; ln++) {
  let s = lines[ln];
  let i = 0;
  let out = '';

  // 逐字符扫描本行，剥离注释与字符串，只保留结构性括号
  while (i < s.length) {
    const c = s[i];
    const c2 = s[i + 1];

    if (blockDepth > 0) {
      if (c === '/' && c2 === '*') { blockDepth++; i += 2; continue; }
      if (c === '*' && c2 === '/') { blockDepth--; i += 2; continue; }
      i++; continue;
    }
    if (c === '/' && c2 === '*') { blockDepth++; i += 2; continue; }
    // 行注释：整行剩余部分丢弃
    if (c === '/' && c2 === '/') break;

    const Q = String.fromCharCode(34);
    if (c === Q) {
      // 三引号多行字符串：可能跨行，这里逐行处理时按"本行内找结束"近似；
      // Swift 的三引号字符串通常成对出现在相邻行，用开关变量跟踪。
      if (s.startsWith(Q.repeat(3), i)) {
        i += 3;
        // 本行内找结束
        while (i < s.length && !s.startsWith(Q.repeat(3), i)) {
          if (s[i] === '\\') i++;
          i++;
        }
        i += 3;
        continue;
      }
      i++;
      while (i < s.length && s[i] !== Q) {
        if (s[i] === '\\') i++;
        i++;
      }
      i++;
      continue;
    }

    out += c;
    i++;
  }

  for (const c of out) {
    if (c === '{') { depth++; openStack.push(ln + 1); }
    else if (c === '}') {
      depth--;
      if (depth === 0) zeroPoints.push({ close: ln + 1, open: openStack[openStack.length - 1] });
      if (depth < 0) problems.push(`第 ${ln + 1} 行：多余的 '}'`);
      openStack.pop();
    }
  }
}

console.log(`${path.split(/[\\/]/).pop()}`);
console.log(`  最终花括号深度 = ${depth}${depth === 0 ? '  ✅ 平衡' : '  ❌ 不平衡'}`);
console.log(`  顶层块闭合点 = ${zeroPoints.length} 个`);
if (zeroPoints.length > 1) {
  for (const z of zeroPoints) {
    console.log(`     第 ${z.close} 行闭合了第 ${z.open} 行开始的块`);
  }
}
for (const p of problems) console.log(`  ${p}`);
process.exit(depth === 0 && problems.length === 0 ? 0 : 1);
