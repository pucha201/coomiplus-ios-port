/**
 * 局域网发现的纯逻辑：解析本地引擎的应答、按 deviceId 找到电脑的当前地址。
 *
 * host 不是电脑自己报的，而是本地引擎从 UDP 数据报源地址抄下来的 ——
 * 多网卡时它就是「这条请求真正能到达的那张网卡」，比二维码里那次性的
 * `local_ip()` 猜测可靠。
 */
export interface DiscoveredPeer {
  deviceId: string
  name: string
  host: string
  port: number
  version: string
}

function isPeer(value: unknown): value is DiscoveredPeer {
  if (typeof value !== 'object' || value === null) return false
  const peer = value as Record<string, unknown>
  return typeof peer.deviceId === 'string' && peer.deviceId.trim().length > 0
    && typeof peer.host === 'string' && peer.host.trim().length > 0
    && typeof peer.port === 'number' && Number.isInteger(peer.port) && peer.port > 0 && peer.port <= 65535
}

export function parseDiscoveredPeers(value: unknown): DiscoveredPeer[] {
  if (!Array.isArray(value)) return []
  const peers: DiscoveredPeer[] = []
  for (const item of value) {
    if (!isPeer(item)) continue
    const peer: DiscoveredPeer = {
      deviceId: item.deviceId.trim(),
      name: typeof item.name === 'string' ? item.name : '',
      host: item.host.trim(),
      port: item.port,
      version: typeof item.version === 'string' ? item.version : '',
    }
    // 同一台电脑可能被有线/无线各回一次：只留第一个（引擎侧已按 deviceId 去重，
    // 这里再兜一层，防止旧版本引擎重复上报）。
    if (!peers.some(existing => existing.deviceId === peer.deviceId)) peers.push(peer)
  }
  return peers
}

/** 按电脑的 deviceId 取它现在的 `http://host:port`；没有匹配返回 null。 */
export function matchDiscoveredEndpoint(deviceId: string, peers: DiscoveredPeer[]): string | null {
  const match = peers.find(peer => peer.deviceId === deviceId)
  if (!match) return null
  const host = match.host.includes(':') && !match.host.startsWith('[') ? `[${match.host}]` : match.host
  return `http://${host}:${match.port}`
}
