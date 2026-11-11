/**
 * 字号放大守卫（移动端）。
 *
 * 用户报的「同一个组件换个模式就变大、严重时整页崩坏」有两条来源：
 *   1. WebView 自己的字号放大（系统字体缩放 + WebKit 的 font inflation），
 *      文字变胖但写死 height 的控件不跟着长，于是文字被切、行叠行；
 *   2. 外观设置里的 --ui-font-scale 把 --fs 与 --lh 系列乘到 1.08/1.18，
 *      同一批控件的盒子却还是写死的 px。
 * 这里守 CSS 这一半：全局必须关掉 text-size-adjust；凡是「字号会跟着 --ui-font-scale 长」
 * 的块只能用 min-height 定「至少多高」，不能定「最多长这样」。
 * 写死 px 字号的块不在此列——字号锁死后它不会自己变胖。
 * （Java 那一半——WebView 的 setTextZoom——由 apps/coomi-app 的 CoomiTextZoomTest 守着。）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

/**
 * 依赖精确像素做算术的地方不许改成 min-height：滚轮按 index * 56 定位，
 * 行高一旦能自己长，选中项就再也对不上刻度。
 */
const FILE_ALLOWLIST = new Set(['HistoryDial.vue'])

/** 正方形/圆形的小盒子（头像、序号点、计数徽标）：里面只有一个字符，尺寸是几何而不是排版。 */
const GEOMETRY_BOXES = new Set([
  '.cnt', '.av', '.av.sm', '.phase-dot', '.member .del', '.count', '.steps span', '.thumb-more',
  '.parameter-help', '.agent-limit output', '.fb-index', '.order',
])

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) out.push(...walk(p))
    else if (p.endsWith('.vue') || p.endsWith('.css')) out.push(p)
  }
  return out
}

function styleBlocks(path) {
  const src = readFileSync(path, 'utf8')
  if (path.endsWith('.css')) return [src]
  return [...src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)].map(m => m[1])
}

/** 每个规则块：选择器 + 声明体。 */
function rules(path) {
  const out = []
  for (const css of styleBlocks(path)) {
    for (const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      out.push({ selector: m[1].trim().replace(/\s+/g, ' '), body: m[2] })
    }
  }
  return out
}

/** 字号或行高来自 --fs / --lh 令牌、或写成 calc —— 也就是会跟着 --ui-font-scale 一起变胖。 */
function scalesWithFontToken(body) {
  return /(font-size|line-height)\s*:\s*(var\(--fs|var\(--lh|calc)/.test(body)
}

test('全局必须锁掉 WebKit 自己的字号放大', () => {
  const css = readFileSync(join(SRC, 'styles', 'global.css'), 'utf8')
  assert.match(css, /-webkit-text-size-adjust:\s*100%/, '缺 -webkit-text-size-adjust：WebView 会自己把文字放大')
  assert.match(css, /(^|[;\s])text-size-adjust:\s*100%/, '缺标准 text-size-adjust')
})

test('字号会跟着缩放档变胖的块，不许写死 height', () => {
  const watched = [...walk(join(SRC, 'components')), ...walk(join(SRC, 'views')), ...walk(join(SRC, 'styles'))]
  const violations = []
  for (const path of watched) {
    if (FILE_ALLOWLIST.has(path.split(/[\\/]/).pop())) continue
    for (const { selector, body } of rules(path)) {
      if (GEOMETRY_BOXES.has(selector)) continue
      const fixed = /(^|[;])\s*height:\s*\d+(?:\.\d+)?px/.test(body)
      if (fixed && !/min-height/.test(body) && scalesWithFontToken(body)) {
        violations.push(`${path.split(/[\\/]/).slice(-2).join('/')} · ${selector} 写死 height，字号一档变大一档就被切`)
      }
    }
  }
  assert.deepEqual(violations, [], '以下文字块还在用固定高度：\n' + violations.join('\n'))
})
