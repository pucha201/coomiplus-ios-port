import assert from 'node:assert/strict'
import test from 'node:test'
import { decideHold, decideClick, movedBeyondSlop } from '../src/utils/holdGesture.ts'

/**
 * 长按手势是真机上最难验的部分：浏览器总会在 pointerup 之后补发 click，
 * 漏挡一次就表现为「长按选完口味开关被翻一次」或「短按没反应」。
 * 这里把四种情形与两种 click 归宿穷举钉死。
 */

/* ── 按下→抬起的判定 ───────────────────────────────────────────────────── */

test('长按成立 → 开 sheet', () => {
  assert.equal(
    decideHold({ primaryButton: true, movedBeyondSlop: false, heldToCompletion: true, releasedBeforeTimer: false }),
    'open-sheet',
  )
})

test('到点前抬起 → 当短按切开关', () => {
  assert.equal(
    decideHold({ primaryButton: true, movedBeyondSlop: false, heldToCompletion: false, releasedBeforeTimer: true }),
    'toggle',
  )
})

test('滑走 → 吞掉，既不开面板也不切开关', () => {
  assert.equal(
    decideHold({ primaryButton: true, movedBeyondSlop: true, heldToCompletion: false, releasedBeforeTimer: true }),
    'swallow',
  )
})

test('滑走优先于长按：手指已经离开按钮，不该再弹面板', () => {
  assert.equal(
    decideHold({ primaryButton: true, movedBeyondSlop: true, heldToCompletion: true, releasedBeforeTimer: false }),
    'swallow',
  )
})

test('非主键（右键 / 中键）什么都不做，且不影响后续 click', () => {
  assert.equal(
    decideHold({ primaryButton: false, movedBeyondSlop: false, heldToCompletion: false, releasedBeforeTimer: true }),
    'ignore',
  )
  assert.equal(
    decideHold({ primaryButton: false, movedBeyondSlop: false, heldToCompletion: true, releasedBeforeTimer: false }),
    'ignore',
  )
})

test('非主键优先于长按：右键按住不放不该弹面板', () => {
  assert.equal(
    decideHold({ primaryButton: false, movedBeyondSlop: true, heldToCompletion: true, releasedBeforeTimer: false }),
    'ignore',
  )
})

test('没开始过手势（cancel 后补的 up）→ ignore', () => {
  assert.equal(
    decideHold({ primaryButton: true, movedBeyondSlop: false, heldToCompletion: false, releasedBeforeTimer: false }),
    'ignore',
  )
})

/* ── click 的归宿 ──────────────────────────────────────────────────────── */

test('有 suppress 标记 → 吞掉（长按与短按的共同路径）', () => {
  assert.equal(decideClick(true, true), 'swallow')
  // 即使 pointer 没被标记处理过，suppress 也优先。
  assert.equal(decideClick(true, false), 'swallow')
})

test('pointer 已处理过 → click 是重复的，忽略（不能翻第二次）', () => {
  assert.equal(decideClick(false, true), 'ignore')
})

test('只有 click（键盘回车 / 辅助技术）→ 当短按', () => {
  assert.equal(decideClick(false, false), 'toggle')
})

/* ── 容差 ──────────────────────────────────────────────────────────────── */

test('位移容差 8px：界内不动，界外判滑走', () => {
  assert.equal(movedBeyondSlop(0, 0), false)
  assert.equal(movedBeyondSlop(8, 0), false, '正好 8px 仍算界内')
  assert.equal(movedBeyondSlop(9, 0), true)
  assert.equal(movedBeyondSlop(0, -9), true, '负方向同样要判')
  assert.equal(movedBeyondSlop(-8, 8), false)
})

test('容差可覆盖（与既有手势保持一致时用）', () => {
  assert.equal(movedBeyondSlop(5, 5, 4), true)
  assert.equal(movedBeyondSlop(5, 5, 6), false)
})
