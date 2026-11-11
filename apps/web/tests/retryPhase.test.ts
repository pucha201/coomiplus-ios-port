import assert from 'node:assert/strict'
import test from 'node:test'
import { INITIAL_CONNECT_GRACE_MS, retryStateFor } from '../src/bridge/retryPhase.ts'

test('the very first connection failures stay in connecting during the grace window', () => {
  assert.equal(retryStateFor({ everOpened: false, elapsedMs: 1200 }), 'connecting')
  assert.equal(retryStateFor({ everOpened: false, elapsedMs: INITIAL_CONNECT_GRACE_MS - 1 }), 'connecting')
})

test('a never-opened connection becomes reconnecting only after the grace window', () => {
  assert.equal(retryStateFor({ everOpened: false, elapsedMs: INITIAL_CONNECT_GRACE_MS }), 'reconnecting')
  assert.equal(retryStateFor({ everOpened: false, elapsedMs: INITIAL_CONNECT_GRACE_MS + 4000 }), 'reconnecting')
})

test('a connection that was open before reports reconnecting immediately', () => {
  assert.equal(retryStateFor({ everOpened: true, elapsedMs: 50 }), 'reconnecting')
})
