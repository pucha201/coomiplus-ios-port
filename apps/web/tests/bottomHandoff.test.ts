import assert from 'node:assert/strict'
import test from 'node:test'
import { handoffFrame, type HandoffSample } from '../src/utils/bottomHandoff.ts'

const base: HandoffSample = {
  from: 300,
  to: 336,
  nativeReserve: 300,
  elapsed: 0,
  holdMs: 260,
  adjustMs: 160,
}

test('hold 段：键盘退多少，面板就长多少，输入栏位置不动', () => {
  // reserve 恒定 = from，说明「原生垫高 + 面板高度」的总和不变。
  for (const native of [300, 220, 120, 0]) {
    const frame = handoffFrame({ ...base, nativeReserve: native })
    assert.equal(frame.phase, 'hold')
    assert.equal(frame.reserve, 300)
    assert.equal(frame.panelH, 300 - native)
  }
})

test('键盘退到 0 时提前结束 hold，随后落到面板高度', () => {
  const early = handoffFrame({ ...base, nativeReserve: 0, elapsed: 40, holdDone: true, holdElapsed: 40 })
  assert.equal(early.phase, 'adjust')
  assert.ok(early.panelH >= 0)

  const done = handoffFrame({ ...base, nativeReserve: 0, elapsed: 40 + 160, holdDone: true, holdElapsed: 40 })
  assert.equal(done.phase, 'done')
  assert.equal(done.reserve, 336)
  assert.equal(done.panelH, 336)
})

test('adjust 段 reserve 单调、不超过目标', () => {
  let previous = -1
  for (let elapsed = 260; elapsed <= 420; elapsed += 20) {
    const frame = handoffFrame({ ...base, nativeReserve: 0, elapsed })
    assert.ok(frame.reserve >= previous, `reserve 回退 @${elapsed}`)
    assert.ok(frame.reserve <= 336.0001, `reserve 越界 @${elapsed}`)
    assert.ok(frame.panelH >= 0)
    previous = frame.reserve
  }
})

test('键盘本来没开：跳过 hold，直接从 0 长到面板高度', () => {
  const sample = { ...base, from: 0, nativeReserve: 0, holdMs: 0, adjustMs: 240 }
  const start = handoffFrame({ ...sample, elapsed: 0 })
  assert.equal(start.phase, 'adjust')
  assert.equal(start.reserve, 0)
  assert.equal(start.panelH, 0)

  const mid = handoffFrame({ ...sample, elapsed: 120 })
  assert.ok(mid.reserve > 0 && mid.reserve < 336)

  const done = handoffFrame({ ...sample, elapsed: 240 })
  assert.equal(done.phase, 'done')
  assert.equal(done.panelH, 336)
})

test('收起：键盘升起时面板让位，最终 reserve 落到键盘高度', () => {
  const close = { from: 336, to: 300, holdMs: 260, adjustMs: 160 }
  const start = handoffFrame({ ...close, nativeReserve: 0, elapsed: 0 })
  assert.equal(start.phase, 'hold')
  assert.equal(start.reserve, 336)
  assert.equal(start.panelH, 336)

  const rising = handoffFrame({ ...close, nativeReserve: 200, elapsed: 80 })
  assert.equal(rising.reserve, 336)
  assert.equal(rising.panelH, 136)

  const settled = handoffFrame({ ...close, nativeReserve: 300, elapsed: 80, holdDone: true, holdElapsed: 80 })
  assert.ok(settled.panelH >= 0)

  const done = handoffFrame({ ...close, nativeReserve: 300, elapsed: 80 + 160, holdDone: true, holdElapsed: 80 })
  assert.equal(done.phase, 'done')
  assert.equal(done.reserve, 300)
  assert.equal(done.panelH, 0)
})

test('收起且不弹键盘：reserve 落到 0，面板高度归零', () => {
  const sample = { from: 336, to: 0, holdMs: 0, adjustMs: 200 }
  const done = handoffFrame({ ...sample, nativeReserve: 0, elapsed: 200 })
  assert.equal(done.phase, 'done')
  assert.equal(done.reserve, 0)
  assert.equal(done.panelH, 0)
})

test('任何输入下 panelH 都不为负、reserve 都在 [min,max] 内', () => {
  for (const native of [0, 50, 150, 300, 400]) {
    for (const elapsed of [0, 100, 259, 260, 300, 420, 900]) {
      const frame = handoffFrame({ ...base, nativeReserve: native, elapsed })
      assert.ok(frame.panelH >= 0, `panelH<0 native=${native} t=${elapsed}`)
      assert.ok(frame.reserve >= 300 - 0.001 && frame.reserve <= 336 + 0.001)
    }
  }
})
