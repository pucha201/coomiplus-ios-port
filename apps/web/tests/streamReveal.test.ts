import assert from 'node:assert/strict'
import test from 'node:test'
import { advanceReveal, initialRevealShown } from '../src/utils/streamReveal.ts'

test('remounting a message with existing content shows it instead of replaying from zero', () => {
  // 组件销毁重挂时记录可能已被清理；正文已经存在就应当直接显示，
  // 绝不能从 0 再打一遍（用户看到的就是“快结束时突然重播”）。
  assert.equal(initialRevealShown(undefined, 4200), 4200)
})

test('a brand-new empty message still reveals from zero', () => {
  assert.equal(initialRevealShown(undefined, 0), 0)
})

test('stored reveal progress wins over the content length', () => {
  assert.equal(initialRevealShown(120, 4200), 120)
})

test('reveal progress never moves backwards', () => {
  let shown = 4000
  for (let i = 0; i < 20; i++) {
    const next = advanceReveal(shown, 0, 4000, 16)
    assert.ok(next.shown >= shown)
    shown = next.shown
  }
})
