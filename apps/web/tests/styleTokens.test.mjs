/**
 * 设计令牌守卫（移动端）。
 *
 * 背景：75 个 .vue 的样式里散落着裸 px。20261009 做了一次机械 token 化，
 * 把「值恰好等于令牌档位」的字面量换成 var(--sp-*) / var(--fs-*) / var(--lh-*) / var(--z-*)。
 * 这个测试防止它再退化回去 —— 新写的样式如果又把 12px 写死，这里会红。
 *
 * 只校验「档上值」：档外的值（10 / 14 / 6 / 11.5 等）是这套界面真实的 2px 节奏，
 * 强行对齐会改变所有内边距，属于视觉改版而不是重构，不在守卫范围。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'src')

const SP_TOKENS = { 4: '--sp-1', 8: '--sp-2', 12: '--sp-3', 16: '--sp-4', 20: '--sp-5', 24: '--sp-6', 32: '--sp-7', 40: '--sp-8', 48: '--sp-9' }
const FS_TOKENS = { 11: '--fs-caption', 12: '--fs-label', 13: '--fs-sub', 14: '--fs-body', 16: '--fs-strong', 20: '--fs-title' }
const LH_TOKENS = { 16: '--lh-caption', 18: '--lh-label', 20: '--lh-sub', 22: '--lh-body', 24: '--lh-strong', 28: '--lh-title' }
const Z_TOKENS = { 0: '--z-base', 10: '--z-sticky', 20: '--z-header', 30: '--z-drawer', 40: '--z-sheet', 50: '--z-toast', 60: '--z-modal' }

const SP_PROP = /^(padding|margin|gap|row-gap|column-gap)(-(top|right|bottom|left|x|y|inline|block))?$/

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

/** 所有声明对（含单行多声明）。 */
function declarations(path) {
  const out = []
  for (const css of styleBlocks(path)) {
    for (const m of css.matchAll(/(^|[;{\s])([\w-]+)(\s*):\s*([^;{}]+)/g)) {
      out.push({ prop: m[2].toLowerCase(), value: m[4] })
    }
  }
  return out
}

test('档上间距/字号/行高/层级必须使用设计令牌', () => {
  const violations = []
  for (const path of walk(SRC)) {
    for (const { prop, value } of declarations(path)) {
      if (SP_PROP.test(prop)) {
        for (const m of value.matchAll(/(-?)(\d+)px/g)) {
          const token = SP_TOKENS[Number(m[2])]
          if (token) violations.push(`${path} padding/margin/gap 用了裸 ${m[2]}px，应为 var(${token})`)
        }
      } else if (prop === 'font-size') {
        const token = FS_TOKENS[Number(value.trim().replace('px', ''))]
        if (token) violations.push(`${path} font-size 用了裸 ${value.trim()}，应为 var(${token})`)
      } else if (prop === 'line-height') {
        const token = LH_TOKENS[Number(value.trim().replace('px', ''))]
        if (token) violations.push(`${path} line-height 用了裸 ${value.trim()}，应为 var(${token})`)
      } else if (prop === 'z-index') {
        const token = Z_TOKENS[Number(value.trim())]
        if (token) violations.push(`${path} z-index 用了裸 ${value.trim()}，应为 var(${token})`)
      }
    }
  }
  assert.deepEqual(violations, [], '发现未走令牌的档上数值:\n' + violations.join('\n'))
})

test('CSS 变量必须带 -- 前缀（防 var(name) 这种无效变量）', () => {
  const violations = []
  for (const path of walk(SRC)) {
    for (const css of styleBlocks(path)) {
      for (const m of css.matchAll(/var\(([^),]+)/g)) {
        if (!m[1].trim().startsWith('--')) violations.push(`${path}: var(${m[1].trim()})`)
      }
    }
  }
  assert.deepEqual(violations, [], '发现缺少 -- 前缀的 var():\n' + violations.join('\n'))
})

test('工具卡片与消息气泡必须有入场过渡（不得 animation:none 硬弹出来）', () => {
  // 用户反馈「AI 回复过程中工具突然出现，观感不好」：入口动画曾被整体关掉
  // （.cascade/.fade-in/.tab-pane { animation: none }），工具卡片无过渡硬插进时间线。
  // 恢复成 --enter-append（160ms / 2px，专为「新消息/追加项」设计的最小入场），
  // 这条守卫防止再次被退化成 none。reduced-motion 的降级声明不受此限制。
  const css = readFileSync(join(SRC, 'styles', 'global.css'), 'utf8')
  const block = css.match(/\.cascade\s*\{[\s\S]{0,160}?\}/)
  assert.ok(block, '找不到 .cascade 规则')
  assert.ok(
    /animation:\s*coomi-enter-append\b/.test(block[0]),
    '.cascade 必须使用 coomi-enter-append 入场动画（当前:\n' + block[0] + ')',
  )
  assert.ok(!/animation:\s*none\s*;/.test(block[0]), '.cascade 不得是 animation:none')
})
