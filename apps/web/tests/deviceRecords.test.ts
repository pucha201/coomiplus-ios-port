import assert from 'node:assert/strict'
import test from 'node:test'
import { mergeEnginePeerSnapshot, planForgetDevice } from '../src/utils/deviceRecords.ts'
import { pickAutoConnectDevice, pairingLikelyDead } from '../src/utils/pairing.ts'
import type { PairedDevice } from '../src/protocol/remote.ts'

const NOW = 1_700_000_000_000

function computer(overrides: Partial<PairedDevice>): PairedDevice {
  return {
    id: 'dev_pc_1',
    peerId: 'peer_phone_1',
    pairingSecret: 'coomi_pair_secret',
    name: '家里的电脑',
    kind: 'desktop',
    engineBase: 'http://192.168.1.10:8787',
    reachability: 'unknown',
    expiresAt: NOW + 60_000,
    createdAt: NOW - 10_000,
    updatedAt: NOW - 10_000,
    ...overrides,
  }
}

test('桌面返回的 peer 列表只更新在线状态，绝不覆盖手机存的配对凭据', () => {
  const local = [computer({})]
  const merged = mergeEnginePeerSnapshot(local, [
    { id: 'peer_phone_1', online: true, lastSeenAt: NOW },
  ], NOW)

  assert.deepEqual(merged[0], {
    ...local[0],
    reachability: 'online',
    lastSeenAt: NOW,
    updatedAt: NOW,
    remoteRevoked: false,
  })
  // 逐字校验：引擎 peer_view 里没有 token，也不会有手机侧的 pairingSecret / peerId。
  assert.equal(merged[0].pairingSecret, 'coomi_pair_secret')
  assert.equal(merged[0].peerId, 'peer_phone_1')
  assert.equal(merged[0].engineBase, 'http://192.168.1.10:8787')
})

test('电脑一条 peer 都没返回时不改写任何记录', () => {
  const local = [computer({ reachability: 'online', lastSeenAt: NOW - 1_000 })]
  const merged = mergeEnginePeerSnapshot(local, [])

  assert.deepEqual(merged, local)
})

test('自己的 peer 记录在电脑上消失时标记「已被电脑移除」', () => {
  const merged = mergeEnginePeerSnapshot([computer({})], [
    { id: 'peer_someone_else', online: true },
  ])

  assert.equal(merged[0].remoteRevoked, true)
  assert.equal(merged[0].reachability, 'offline')
  // 仍然保留凭据：用户重新点一下就能重新发起配对，不必先丢令牌。
  assert.equal(merged[0].pairingSecret, 'coomi_pair_secret')
})

test('被电脑移除的设备不再参与冷启动自动连接', () => {
  const chosen = pickAutoConnectDevice([
    computer({ id: 'dev_removed', reachability: 'online', lastSeenAt: NOW - 1_000, remoteRevoked: true }),
    computer({ id: 'dev_live', reachability: 'online', lastSeenAt: NOW - 1_000 }),
  ], NOW)

  assert.equal(chosen?.id, 'dev_live')
})

test('手机删除设备永远先在本地忘记，连不上电脑也算成功', () => {
  const plan = planForgetDevice(computer({}), false, NOW)

  assert.equal(plan.localRemoved, true)
  assert.equal(plan.shouldNotifyEngine, false)
  assert.match(plan.reason, /本地/)
})

test('有活通道时同时请电脑作废本机凭据', () => {
  const plan = planForgetDevice(computer({}), true, NOW)

  assert.equal(plan.localRemoved, true)
  assert.equal(plan.shouldNotifyEngine, true)
  assert.equal(plan.reason, '')
})

test('连接码里没有 peerId 或配对已过期时不去打扰电脑', () => {
  assert.equal(planForgetDevice(computer({ peerId: undefined }), true, NOW).shouldNotifyEngine, false)
  assert.equal(planForgetDevice(computer({ expiresAt: NOW - 1 }), true, NOW).shouldNotifyEngine, false)
})

test('引擎滑动过的到期时间回填到本地记录（续期同步）', () => {
  const local = [computer({ expiresAt: NOW + 60_000 })]
  const merged = mergeEnginePeerSnapshot(local, [
    { id: 'peer_phone_1', online: true, lastSeenAt: NOW, expiresAt: NOW + 20 * 60 * 60 * 1000 },
  ], NOW)

  assert.equal(merged[0].expiresAt, NOW + 20 * 60 * 60 * 1000)
})

test('引擎到期时间早于本地时不把本地值缩小', () => {
  const local = [computer({ expiresAt: NOW + 20 * 60 * 60 * 1000 })]
  const merged = mergeEnginePeerSnapshot(local, [
    { id: 'peer_phone_1', online: true, lastSeenAt: NOW, expiresAt: NOW + 60_000 },
  ], NOW)

  assert.equal(merged[0].expiresAt, NOW + 20 * 60 * 60 * 1000)
})

test('过期未满一天的配对还有救：引擎可能已经滑动续期', () => {
  assert.equal(pairingLikelyDead(NOW - 60 * 60 * 1000, NOW), false)
  assert.equal(pairingLikelyDead(NOW - 25 * 60 * 60 * 1000, NOW), true)
  assert.equal(pairingLikelyDead(undefined, NOW), false)
})
