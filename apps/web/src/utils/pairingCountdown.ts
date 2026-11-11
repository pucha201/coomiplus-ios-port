/**
 * 配对凭据剩余有效期的说法（手机端设备列表与桌面端已配对列表共用）。
 *
 * 引擎用的是滑动续期：一次成功认证就会把不足 12 小时的有效期补满 24 小时，
 * 已经过期（剩 0）的不会复活。所以这不是只会往下走的倒计时——直接贴
 * 「还剩 3 小时」会让人以为马上要断开，其实连上一次就续上了。
 * 界面要说的：还有多久 + 用过会自动续 + 真过期了该怎么办。
 */

/** 与引擎 RENEW_THRESHOLD_SECS 对齐：低于这个剩余量，下次认证成功就会续满。 */
export const PAIRING_RENEW_THRESHOLD_MS = 12 * 60 * 60 * 1000

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

export type PairingTone = 'ok' | 'renewing' | 'expired'

export interface PairingCountdown {
  text: string
  tone: PairingTone
}

/** 向下取整：宁可少说一分钟，也不许承诺已经没有了的时间。 */
export function formatRemaining(ms: number): string {
  if (ms < MINUTE) return '不足 1 分钟'
  const hours = Math.floor(ms / HOUR)
  if (!hours) return Math.floor(ms / MINUTE) + ' 分钟'
  const minutes = Math.floor((ms % HOUR) / MINUTE)
  return minutes ? `${hours} 小时 ${minutes} 分钟` : `${hours} 小时`
}

/** expiresAtMs 缺失或为 0 表示「不知道」——返回 null，由界面显示「有效期未知」。 */
export function pairingCountdown(expiresAtMs: number | null | undefined, now = Date.now()): PairingCountdown | null {
  if (!expiresAtMs) return null
  const remaining = expiresAtMs - now
  if (remaining <= 0) return { text: '配对已过期，请在电脑上重新生成连接码', tone: 'expired' }
  if (remaining >= PAIRING_RENEW_THRESHOLD_MS) {
    return { text: `剩 ${formatRemaining(remaining)} · 用过会自动续期`, tone: 'ok' }
  }
  return { text: `剩 ${formatRemaining(remaining)} · 连上电脑会自动续期`, tone: 'renewing' }
}

export interface PairingLineInput {
  /** 毫秒；缺失或 0 表示不知道。 */
  expiresAt?: number | null
  /** 电脑那边已经把这台设备撤销/删除：报剩余时长毫无意义，只会误导。 */
  revoked?: boolean
  /** 过期的补救动作在两端口径不同（电脑重新生成码 / 手机重新扫码），由调用方给文案。 */
  expiredText: string
  /** 撤销后的说法；不给就返回 null，让调用方用状态列自己说明。 */
  revokedText?: string
}

/** 设备行上的一行配对状态：桌面端与手机端共用同一套判断，只差文案。 */
export function pairingLine(input: PairingLineInput, now = Date.now()): PairingCountdown | null {
  if (input.revoked) return input.revokedText ? { tone: 'expired', text: input.revokedText } : null
  const view = pairingCountdown(input.expiresAt ?? null, now)
  if (!view) return null
  return view.tone === 'expired' ? { tone: 'expired', text: input.expiredText } : view
}
