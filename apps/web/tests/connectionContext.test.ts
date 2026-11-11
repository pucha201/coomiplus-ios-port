import assert from 'node:assert/strict'
import test from 'node:test'
import { connectionContextKey, shouldClearSessionHistory } from '../src/utils/connectionContext.ts'

test('local mode never keeps a cloud device key', () => {
  assert.equal(connectionContextKey('local', 'pc-1'), 'local')
  assert.equal(connectionContextKey('local', ''), 'local')
})

test('cloud mode without a selected device is its own empty context', () => {
  assert.equal(connectionContextKey('cloud', ''), 'cloud:unselected')
  assert.equal(shouldClearSessionHistory('cloud', ''), true)
})

test('each paired computer gets its own history context', () => {
  assert.equal(connectionContextKey('cloud', 'pc-1'), 'cloud:pc-1')
  assert.equal(connectionContextKey('cloud', 'pc-2'), 'cloud:pc-2')
  assert.equal(shouldClearSessionHistory('cloud', 'pc-1'), false)
  assert.equal(shouldClearSessionHistory('local', ''), false)
})
