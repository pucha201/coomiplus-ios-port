/**
 * 「连不上电脑」到底是电脑没开，还是通道没打通 —— 探活结果负责区分这两件事。
 * 手机分不清自己是不是和电脑在同一个 Wi-Fi，所以话只能说到位，不能替用户定罪。
 */

export const HOST_PROBE_FRESH_MS = 60_000
export const HOST_PROBE_MIN_INTERVAL_MS = 15_000

export interface HostProbe {
  reachable: boolean
  checkedAt: number
}

/** 探活结论变成横幅上的一句话；没有结论就什么都不说。 */
export function presenceNote(probe: HostProbe | null, now = Date.now()): string | null {
  if (!probe || now - probe.checkedAt > HOST_PROBE_FRESH_MS) return null
  return probe.reachable
    ? '电脑在线，是加密通道没打通（可切换网络后重试）'
    : '这台电脑的局域网地址没有应答（电脑关机/休眠，或手机不在同一网络）'
}

/** 什么时候值得再探一次：云端 + 选了电脑 + 通道还没通 + 距上次探活够久。 */
export function shouldProbeHost(input: {
  mode: string
  deviceId: string
  state: string
  lastProbeAt: number
  now?: number
}): boolean {
  if (input.mode !== 'cloud' || !input.deviceId) return false
  if (input.state === 'open') return false
  const now = input.now ?? Date.now()
  return now - input.lastProbeAt >= HOST_PROBE_MIN_INTERVAL_MS
}
