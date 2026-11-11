import assert from 'node:assert/strict'
import test from 'node:test'
import { ONLINE_FRESH_MS, PAIRING_EXPIRED_GRACE_MS, pairingExpired, pickAutoConnectDevice } from '../src/utils/pairing.ts'
import type { PairedDevice } from '../src/protocol/remote.ts'

const NOW = 1_700_000_000_000

function device(overrides: Partial<PairedDevice>): PairedDevice {
  return {
    id: 'pc-1',
    name: 'PC',
    kind: 'desktop',
    engineBase: 'http://192.168.1.10:8787',
    reachability: 'online',
    lastSeenAt: NOW - 1_000,
    createdAt: NOW - 1_000,
    updatedAt: NOW - 1_000,
    ...overrides,
  }
}

test('a pairing token past its expiry is reported expired', () => {
  assert.equal(pairingExpired(NOW - 1, NOW), true)
  assert.equal(pairingExpired(NOW, NOW), true)
  assert.equal(pairingExpired(NOW + 1, NOW), false)
  assert.equal(pairingExpired(undefined, NOW), false)
})

test('boot auto-connect picks a device that was seen online recently', () => {
  const picked = pickAutoConnectDevice([
    device({ id: 'stale', lastSeenAt: NOW - ONLINE_FRESH_MS - 1 }),
    device({ id: 'offline', reachability: 'offline' }),
    device({ id: 'fresh' }),
  ], NOW)
  assert.equal(picked?.id, 'fresh')
})

test('boot auto-connect 只放过名义过期但可能已被引擎续期的配对', () => {
  // 引擎对活跃配对滑动续期，本地到期时间只会偏旧：名义过期一天内仍值得一试。
  assert.equal(pickAutoConnectDevice([device({ id: 'renewed', expiresAt: NOW - 1 })], NOW)?.id, 'renewed')
  // 过期超过一整天：真的没救了，别再拖进无限重连。
  assert.equal(pickAutoConnectDevice([device({ id: 'dead', expiresAt: NOW - PAIRING_EXPIRED_GRACE_MS - 1 })], NOW), null)
})

test('boot auto-connect stays empty instead of falling back to a stale device', () => {
  assert.equal(pickAutoConnectDevice([
    device({ id: 'stale', lastSeenAt: NOW - ONLINE_FRESH_MS * 2 }),
    device({ id: 'offline', reachability: 'offline' }),
    device({ id: 'unknown', reachability: 'unknown' }),
  ], NOW), null)
})
