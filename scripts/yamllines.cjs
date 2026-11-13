#!/usr/bin/env node
// 扫描 YAML 的 run: 块，找出「两条命令被合并到同一行」的痕迹。
//
// 起因：私有仓的 build-ios.yml 里
//     set +e          LIB=apps/.../libcoomi_ui.a
// 把两条本该分行的语句挤到了一行。后果是 LIB 变成 `set +e` 的临时环境变量
// 而不是 shell 变量，后续 `ls -la "$LIB"` 实际在 `ls -la ""`。
// 这类错误不会让脚本报错（有 set +e），但会让自检报告假的成功。
//
// 判据：同一行里出现「一个完整命令 + 大段空格 + 另一个赋值/命令」的形状。
// 只报疑似，交由人工确认。
//
// 用法: node yamllines.cjs <file.yml> [...]
const fs = require('fs');

const files = process.argv.slice(2);
if (files.length === 0) { console.error('用法: node yamllines.cjs <file.yml> [...]'); process.exit(2); }

let total = 0;
for (const f of files) {
  const lines = fs.readFileSync(f, 'utf8').split('\n');
  const hits = [];
  lines.forEach((l, i) => {
    const body = l.replace(/\r$/, '');
    // 跳过 YAML 注释与空行
    if (/^\s*#/.test(body) || !body.trim()) return;
    // 形状 1：`set +e` / `set -e` 后面还跟着别的东西
    if (/\bset\s+[+-][a-zA-Z]+\s{2,}\S/.test(body)) hits.push({ n: i + 1, l: body, why: 'set 后面还跟着别的命令' });
    // 形状 2：`VAR=value` 后面跟着大段空格再跟另一个赋值
    if (/^\s*\w+=\S+\s{3,}\w+=/.test(body)) hits.push({ n: i + 1, l: body, why: '两个赋值挤在一行' });
    // 形状 3：`VAR=value` 后面大段空格再跟一个明显是命令的词
    if (/^\s*\w+=\S+\s{4,}(echo|ls|cd|file|grep|if|for|while|exit|test)\b/.test(body))
      hits.push({ n: i + 1, l: body, why: '赋值后面挤了一条命令' });
    // 形状 4：行内出现 tab 分隔的两个命令（YAML 里 tab 非法，但先看看）
    if (/\t/.test(body) && /\S\t+\S/.test(body)) hits.push({ n: i + 1, l: body, why: '含 TAB' });
  });

  if (hits.length === 0) {
    console.log(`✅ ${f.split(/[\\/]/).pop()}  未发现行合并痕迹`);
  } else {
    total += hits.length;
    console.log(`⚠ ${f.split(/[\\/]/).pop()}  发现 ${hits.length} 处：`);
    for (const h of hits) {
      console.log(`    L${h.n}  [${h.why}]`);
      console.log(`        ${h.l.trim().slice(0, 120)}`);
    }
  }
}
process.exit(total ? 1 : 0);
