import assert from 'node:assert/strict'
import test from 'node:test'
import { PAIRING_RENEW_THRESHOLD_MS, formatRemaining, pairingCountdown, pairingLine } from '../src/utils/pairingCountdown.ts'

/**
 * 配对凭据的剩余时间要怎么说。
 * 引擎会在「用到时」把有效期补满 24 小时，所以这不是一只只会往下走的倒计时：
 * 直接报「还剩 3 小时」会让用户以为马上就要断开，其实只要连上一次就续上了。
 */

const HOUR = 60 * 60 * 1000

test('不知道有效期就别编一个出来', () => {
  assert.equal(pairingCountdown(undefined), null)
  assert.equal(pairingCountdown(0, 1_700_000_000_000), null)
})

test('有效期还长：说还剩多久，同时说明用过就自动续', () => {
  const now = 1_700_000_000_000
  const view = pairingCountdown(now + 20 * HOUR, now)!
  assert.equal(view.tone, 'ok')
  assert.match(view.text, /剩 20 小时/)
  assert.match(view.text, /自动续/)
})

test('不到 12 小时：改成「下次连上会续期」，别报成马上要断', () => {
  const now = 1_700_000_000_000
  assert.equal(PAIRING_RENEW_THRESHOLD_MS, 12 * HOUR)
  const view = pairingCountdown(now + 6 * HOUR, now)!
  assert.equal(view.tone, 'renewing')
  assert.match(view.text, /连上/)
})

test('过期了就说要在电脑上重新生成，别只写「已过期」', () => {
  const now = 1_700_000_000_000
  const view = pairingCountdown(now - 1, now)!
  assert.equal(view.tone, 'expired')
  assert.match(view.text, /重新生成/)
})

test('不满一小时只显示分钟，不写「0 小时 40 分」', () => {
  assert.equal(formatRemaining(50 * 60 * 1000), '50 分钟')
  assert.equal(formatRemaining(3 * HOUR + 20 * 60 * 1000), '3 小时 20 分钟')
  assert.equal(formatRemaining(0), '不足 1 分钟')
})

test('界面一行：被撤销的设备不报倒计时，改成说怎么重新连上', () => {
  const now = 1_700_000_000_000
  const revoked = pairingLine({
    expiresAt: now + 20 * HOUR,
    revoked: true,
    expiredText: '重新生成配对码',
    revokedText: '已在电脑上撤销，需要重新扫码',
  }, now)!
  assert.equal(revoked.tone, 'expired')
  assert.match(revoked.text, /撤销/)
  // 不给撤销文案时，宁可什么都不显示（桌面端靠状态列自己说明）
  assert.equal(pairingLine({ expiresAt: now + 20 * HOUR, revoked: true, expiredText: 'x' }, now), null)
})

test('界面一行：正常的有效期照报，过期用本端自己的说法', () => {
  const now = 1_700_000_000_000
  assert.equal(pairingLine({ expiresAt: now + 20 * HOUR, expiredText: 'x' }, now)!.text, pairingCountdown(now + 20 * HOUR, now)!.text)
  assert.equal(pairingLine({ expiresAt: now - 1, expiredText: '手机端专用说法' }, now)!.text, '手机端专用说法')
})
