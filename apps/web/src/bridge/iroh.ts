import type { PairedDevice } from '@/protocol/remote'
import { localEngineToken } from './discovery'

/** 隧道验活上限：建好本地代理 ≠ 隧道通了，必须真发一次请求。 */
const TUNNEL_HEALTH_TIMEOUT_MS = 5000

/**
 * 经代理打一次健康检查。
 * 代理只负责把字节搬进 QUIC，是否打洞成功、relay 通不通，只有真请求才看得出来。
 */
async function probeTunnel(base: string, timeoutMs = TUNNEL_HEALTH_TIMEOUT_MS): Promise<number> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()
  try {
    const response = await fetch(base + '/api/runtime/health', {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`隧道健康检查返回 ${response.status}`)
    return Date.now() - startedAt
  } catch (cause) {
    if ((cause as Error)?.name === 'AbortError') {
      throw new Error(`隧道 ${Math.round(timeoutMs / 1000)} 秒内没有响应（打洞或中转不通）`)
    }
    throw cause instanceof Error ? cause : new Error(String(cause))
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 让**本机引擎**起一个 iroh 代理：
 *   本机 WebView → http://127.0.0.1:<proxyPort> → iroh QUIC → 电脑引擎
 * 之后 engineBase 指向这个代理，现有 HTTP/WS 完全不用改。
 * 返回前会过一次健康检查：不通就抛错，让调用方立刻回退局域网，而不是挂在死隧道上。
 */
export async function ensureIrohTunnel(device: PairedDevice): Promise<string> {
  const addr = device.iroh?.addr
  const pairing = device.pairingSecret?.trim() ?? ''
  if (!addr) throw new Error('这台电脑的配对码没有隧道地址（旧配对），跨网需要重新扫码配对')
  if (!pairing) throw new Error('配对令牌缺失，请重新扫码配对')
  const token = localEngineToken()
  const response = await fetch('/api/device/iroh/connect', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ addr, token: pairing }),
  })
  const data = await response.json().catch(() => ({})) as { engineBase?: string; error?: string }
  if (!response.ok || !data.engineBase) {
    throw new Error(data.error || `iroh 代理启动失败（HTTP ${response.status}）`)
  }
  const base = data.engineBase
  const ms = await probeTunnel(base)
  lastIrohLatency = ms
  return base
}

/** 最近一次隧道健康检查的往返毫秒数（诊断展示用，0 表示还没成功过）。 */
export let lastIrohLatency = 0

/** 当前 engineBase 是否是 iroh 本地代理（127.0.0.1/localhost 上的非页面端口）。 */
export function isIrohProxyBase(base: string): boolean {
  try {
    const url = new URL(base)
    if (url.protocol !== 'http:') return false
    if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false
    return url.port !== location.port
  } catch {
    return false
  }
}
