import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { turnBlockReason } from '../src/utils/sendGuard.ts'

const ready = { state: 'open' as const, hasTransport: true, demo: false }

test('an open channel lets the turn start', () => {
  assert.equal(turnBlockReason(ready), null)
})

test('demo mode sends to the scripted transport instead of the engine', () => {
  assert.equal(turnBlockReason({ state: 'error', hasTransport: true, demo: true }), null)
})

test('sending while offline is refused with a reason, not silently dropped', () => {
  assert.match(turnBlockReason({ state: 'open', hasTransport: false, demo: false }) ?? '', /没连接|未连接/)
  assert.match(turnBlockReason({ state: 'error', hasTransport: true, demo: false }) ?? '', /没连接|未连接/)
})

test('a reconnecting channel reports the retry state', () => {
  assert.match(turnBlockReason({ state: 'reconnecting', hasTransport: true, demo: false }) ?? '', /重连|连接中/)
  assert.match(turnBlockReason({ state: 'closed', hasTransport: true, demo: false }) ?? '', /没连接|未连接/)
})

test('the first handshake queues the message instead of refusing it', () => {
  // 刚打开应用那次 connecting 不该挡发送：本地 WS 有离线待发队列，
  // 而且一进应用就弹「发不出去」正是用户抱怨的那个红色重连条。
  assert.equal(turnBlockReason({ state: 'connecting', hasTransport: true, demo: false }), null)
})

test('the store and the composer both consult the same gate', () => {
  const store = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  const composer = readFileSync(new URL('../src/components/Composer.vue', import.meta.url), 'utf8')
  assert.match(store, /turnBlockReason/)
  assert.match(composer, /session\.turnBlock/)
  // 输入框不许自己另算一套判据：否则两边的「能不能发」迟早漂移。
  assert.doesNotMatch(composer, /turnBlockReason\(/)
})
