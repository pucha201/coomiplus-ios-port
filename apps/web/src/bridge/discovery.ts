import { parseDiscoveredPeers, type DiscoveredPeer } from '@/utils/deviceDiscovery'

/** 本地引擎 token：云端模式下它与配对 token 是两套凭据，绝不能拿后者去问本地引擎。 */
export function localEngineToken(): string {
  try {
    const stored = localStorage.getItem('coomi.localEngineToken')?.trim()
    if (stored && !stored.startsWith('coomi_pair_')) return stored
  } catch { /* storage unavailable */ }
  try {
    const fromBridge = (window as unknown as { CoomiAndroid?: { getEngineToken?: () => string } })
      .CoomiAndroid?.getEngineToken?.()?.trim()
    if (fromBridge && !fromBridge.startsWith('coomi_pair_')) return fromBridge
  } catch { /* 非原生壳 */ }
  return ''
}

/**
 * 让**手机本地引擎**在局域网广播一次发现请求。
 *
 * 不能走 authedFetch/currentEngineBase：云端模式下它们指向电脑，而广播必须由手机自己发
 * （电脑听不到自己的广播）。页面始终由本地引擎伺服，所以相对路径就是本地引擎。
 */
export async function discoverDesktops(timeoutMs = 1200): Promise<DiscoveredPeer[]> {
  const token = localEngineToken()
  const response = await fetch('/api/device/discover', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ timeout_ms: timeoutMs }),
  })
  if (!response.ok) throw new Error(`局域网发现失败：HTTP ${response.status}`)
  const data = await response.json() as { peers?: unknown }
  return parseDiscoveredPeers(data.peers)
}
