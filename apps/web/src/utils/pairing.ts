import type { PairedDevice } from '@/protocol/remote'

/** 冷启动自动连接只信任最近 5 分钟内确认过在线的设备。 */
export const ONLINE_FRESH_MS = 5 * 60 * 1000

/** 配对令牌过期时间（毫秒 epoch）。旧连接码没有 exp，视为不过期。 */
export function pairingExpired(expiresAt: number | undefined, now = Date.now()): boolean {
  return typeof expiresAt === 'number' && expiresAt > 0 && expiresAt <= now
}

/**
 * 引擎会对活跃配对滑动续期，本地记录因此可能「名义过期但实际还活着」。
 * 只有过期超过这一整天宽限，才判定配对真的死了、拒绝自动连接。
 */
export const PAIRING_EXPIRED_GRACE_MS = 24 * 60 * 60 * 1000

export function pairingLikelyDead(expiresAt: number | undefined, now = Date.now()): boolean {
  return typeof expiresAt === 'number' && expiresAt > 0 && expiresAt + PAIRING_EXPIRED_GRACE_MS <= now
}

/**
 * 冷启动自动选设备：只选「配对未过期 + 在线 + 最近确认过」的那台。
 * 宁可留空让用户手动选，也不要把过期/离线设备拖进无限重连。
 */
export function pickAutoConnectDevice(devices: PairedDevice[], now = Date.now()): PairedDevice | null {
  return devices.find(device =>
    !pairingLikelyDead(device.expiresAt, now)
    && !device.remoteRevoked
    && device.reachability === 'online'
    && typeof device.lastSeenAt === 'number'
    && now - device.lastSeenAt <= ONLINE_FRESH_MS
  ) ?? null
}
