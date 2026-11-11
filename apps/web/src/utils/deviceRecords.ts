import type { PairedDevice } from '@/protocol/remote'
import { pairingExpired } from './pairing.ts'

/** 引擎 `/api/device/peers` 返回的一条 peer（只读视图，不含令牌）。 */
export interface EnginePeerRecord {
  id: string
  online?: boolean
  revoked?: boolean
  expired?: boolean
  reachability?: string
  lastSeenAt?: number
  /** 引擎侧的权威到期时间（毫秒 epoch）：滑动续期后它比手机本地记录的更新。 */
  expiresAt?: number
}

export interface ForgetPlan {
  localRemoved: true
  shouldNotifyEngine: boolean
  reason: string
}

/**
 * 把电脑端 peer 列表并进手机保存的「已配对电脑」记录里。
 *
 * 两侧记录的语义不同：手机存的是「哪台电脑」，电脑存的是「哪台手机」。
 * 所以只能按 `peerId` 对齐、只更新在线状态，绝不能整表替换 ——
 * 替换会把 pairingSecret / peerId / engineBase 全部丢掉，互联从此只能重扫。
 */
export function mergeEnginePeerSnapshot(
  local: PairedDevice[],
  snapshot: EnginePeerRecord[],
  now = Date.now(),
): PairedDevice[] {
  // 空列表多半是旧引擎/权限不足，不是「电脑上把所有设备删光了」：不动任何记录。
  if (snapshot.length === 0) return local
  return local.map(device => {
    const peer = device.peerId ? snapshot.find(item => item.id === device.peerId) : undefined
    if (!peer) {
      return { ...device, remoteRevoked: true, reachability: 'offline' as const, updatedAt: now }
    }
    const gone = peer.revoked === true || peer.expired === true
    // 滑动续期同步：引擎的到期时间只会更晚，回填它；绝不把本地值缩小。
    const engineExpiry = typeof peer.expiresAt === 'number' && peer.expiresAt > 0 ? peer.expiresAt : undefined
    const expiresAt = engineExpiry !== undefined && engineExpiry > (device.expiresAt ?? 0)
      ? engineExpiry
      : device.expiresAt
    return {
      ...device,
      remoteRevoked: gone,
      reachability: peer.online && !gone ? 'online' : 'offline',
      lastSeenAt: typeof peer.lastSeenAt === 'number' ? Math.max(device.lastSeenAt ?? 0, peer.lastSeenAt) : device.lastSeenAt,
      expiresAt,
      updatedAt: now,
    }
  })
}

/**
 * 「删除设备」的计划：本地忘记是无条件的，通知电脑作废凭据只是尽力而为。
 * 手机在蜂窝网络下够不着电脑是常态，把删除按钮卡在网络上是这台应用最常见的死循环。
 */
export function planForgetDevice(record: PairedDevice, hasLiveChannel: boolean, now = Date.now()): ForgetPlan {
  if (!record.peerId) {
    return { localRemoved: true, shouldNotifyEngine: false, reason: '连接码缺少 peerId，只在这台手机上忘记' }
  }
  if (pairingExpired(record.expiresAt, now)) {
    return { localRemoved: true, shouldNotifyEngine: false, reason: '配对已过期，只在这台手机上忘记' }
  }
  if (!hasLiveChannel) {
    return { localRemoved: true, shouldNotifyEngine: false, reason: '手机暂时连不上电脑，已先在本地忘记' }
  }
  return { localRemoved: true, shouldNotifyEngine: true, reason: '' }
}
