import assert from 'node:assert/strict'
import test from 'node:test'
import { HOST_PROBE_FRESH_MS, presenceNote, shouldProbeHost } from '../src/utils/hostPresence.ts'

const NOW = 1_700_000_000_000

test('探活结果过期了就不开口，别拿十分钟前的判断骗人', () => {
  assert.equal(presenceNote(null, NOW), null)
  assert.equal(presenceNote({ reachable: true, checkedAt: NOW - HOST_PROBE_FRESH_MS - 1 }, NOW), null)
})

test('电脑应答了就说明故障在通道，不在电脑', () => {
  const note = presenceNote({ reachable: true, checkedAt: NOW }, NOW) ?? ''
  assert.match(note, /电脑在线/)
  assert.doesNotMatch(note, /没开机/)
})

test('局域网没有应答时给出可能的原因，不把话说死', () => {
  const note = presenceNote({ reachable: false, checkedAt: NOW }, NOW) ?? ''
  assert.match(note, /没有应答/)
  assert.match(note, /同一网络/)
})

test('只有云端、选了电脑、通道没通、且探活不频繁时才去探一次', () => {
  const base = { mode: 'cloud', deviceId: 'pc-1', state: 'closed', lastProbeAt: 0, now: NOW }
  assert.equal(shouldProbeHost(base), true)
  assert.equal(shouldProbeHost({ ...base, mode: 'local' }), false)
  assert.equal(shouldProbeHost({ ...base, deviceId: '' }), false)
  assert.equal(shouldProbeHost({ ...base, state: 'open' }), false)
  assert.equal(shouldProbeHost({ ...base, state: 'connecting', lastProbeAt: NOW - 5_000 }), false)
  assert.equal(shouldProbeHost({ ...base, lastProbeAt: NOW - 60_000 }), true)
})
