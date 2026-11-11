import type { PairedDevice } from '../protocol/remote.ts'

/** 加密中转/信令默认 broker：公共 EMQX 沙箱，无 SLA，可在电脑端换成自建地址。 */
export const DEFAULT_SYNC_BROKER_URL = 'wss://broker.emqx.io:8084/mqtt'

/** broker URL 的 host 部分：去掉 path/query、userinfo 与端口，不依赖 URL 构造器。 */
function brokerHost(authorityAndPath: string): string {
  const authority = authorityAndPath.split('/')[0]?.split('?')[0] ?? ''
  const withoutUser = authority.split('@').pop() ?? ''
  const host = withoutUser.startsWith('[')
    ? withoutUser.slice(1).split(']')[0] ?? ''
    : withoutUser.split(':')[0] ?? ''
  return host.trim().toLowerCase()
}

/** 明文 ws 只准用于本机/内网 broker —— 过公网一律要 TLS，配对凭据不能裸奔。 */
function isPrivateHost(host: string): boolean {
  if (!host) return false
  if (host === 'localhost' || host.endsWith('.local')) return true
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (ipv4) {
    const a = Number(ipv4[1])
    const b = Number(ipv4[2])
    if (a > 255 || b > 255) return false
    return a === 127 || a === 10 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || a === 169
  }
  if (host.includes(':')) return host === '::1' || host.startsWith('fe80') || host.startsWith('fc') || host.startsWith('fd')
  return false
}

/** broker 地址是否可用：wss 任意，ws 限本机/内网，其它一律拒绝（由调用方回退默认值）。 */
export function isBrokerUrlAllowed(url: string): boolean {
  const value = url.trim()
  if (value.startsWith('wss://') && brokerHost(value.slice('wss://'.length))) return true
  if (value.startsWith('ws://') && isPrivateHost(brokerHost(value.slice('ws://'.length)))) return true
  return false
}

/**
 * 双端必须连同一个 broker，否则信令永远碰不到一起。
 * 优先级：配对码里电脑自己配置的值 > 打包时的环境变量 > 公共默认值。
 * 配对码赢是因为它就是桌面宿主正在用的地址 —— 环境变量只能兜底，不能压过对端事实。
 */
export function brokerUrlFor(
  device: Pick<PairedDevice, 'brokerUrl'> | null | undefined,
  envUrl?: string,
): string {
  const fromPeer = device?.brokerUrl?.trim() ?? ''
  if (fromPeer && isBrokerUrlAllowed(fromPeer)) return fromPeer
  const fromEnv = envUrl?.trim() ?? ''
  if (fromEnv && isBrokerUrlAllowed(fromEnv)) return fromEnv
  return DEFAULT_SYNC_BROKER_URL
}
