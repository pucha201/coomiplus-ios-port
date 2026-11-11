import type { P2PHttpRequest, P2PHttpResponse } from '../protocol/remote'

/**
 * 把引擎 HTTP 请求代理到对端（电脑）。
 * 只在云端 + 加密通道已建立时启用；负载放进同一条 AES-GCM 通道，不经过明文。
 */
export interface P2PChannel {
  sendPayload(value: unknown): Promise<void>
  onPayload(handler: (value: unknown) => void): (() => void) | void
  /** 通道自己的「是否已连通」：对象存在不代表能发东西。 */
  isOpen?(): boolean
}

let activeChannel: P2PChannel | null = null
let activeUnsubscribe: (() => void) | null = null
const pending = new Map<string, { resolve: (response: P2PHttpResponse) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function isHttpRequest(value: unknown): value is P2PHttpRequest { return isRecord(value) && value.kind === 'http:req' && typeof value.id === 'string' }
function isHttpResponse(value: unknown): value is P2PHttpResponse { return isRecord(value) && value.kind === 'http:res' && typeof value.id === 'string' }

/** 安装/切换当前 P2P 通道；重复调用会先摘掉旧的监听，并作废旧通道上没回来的请求。 */
export function setP2PChannel(channel: P2PChannel | null): void {
  if (activeUnsubscribe) { try { activeUnsubscribe() } catch { /* ignore */ } activeUnsubscribe = null }
  if (channel !== activeChannel) {
    // 通道换了就等于旧请求永远不会回：不能让调用方干等 20 秒超时。
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('P2P 通道已关闭')) }
    pending.clear()
  }
  activeChannel = channel
  if (!channel) return
  const unsubscribe = channel.onPayload(value => {
    if (!isHttpResponse(value)) return
    const entry = pending.get(value.id)
    if (!entry) return
    clearTimeout(entry.timer); pending.delete(value.id)
    if (value.error) entry.reject(new Error(value.error))
    else entry.resolve(value)
  })
  if (typeof unsubscribe === 'function') activeUnsubscribe = unsubscribe
}

export function hasP2PChannel(): boolean { return activeChannel !== null && (activeChannel.isOpen?.() ?? true) }

export async function p2pFetch(path: string, init: RequestInit = {}, timeoutMs = 20_000): Promise<Response> {
  if (!hasP2PChannel()) throw new Error('P2P 通道未连接')
  const channel = activeChannel as P2PChannel
  const id = crypto.randomUUID()
  const headers: Record<string, string> = {}
  new Headers(init.headers).forEach((value, key) => { headers[key] = value })
  const bodyText = typeof init.body === 'string' ? init.body : undefined
  const request: P2PHttpRequest = { kind: 'http:req', id, method: (init.method || 'GET').toUpperCase(), path, headers, body: bodyText }
  const responsePromise = new Promise<P2PHttpResponse>((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('电脑响应超时')) }, timeoutMs)
    pending.set(id, { resolve, reject, timer })
  })
  try { await channel.sendPayload(request) } catch (error) { pending.delete(id); throw error instanceof Error ? error : new Error('P2P 发送失败') }
  const response = await responsePromise
  const responseHeaders = new Headers(response.headers)
  return new Response(response.body ?? '', { status: response.status, headers: responseHeaders })
}

/** 主机侧：收到 http:req 后用本地引擎凭证代发，并把结果原路返回。 */
export function installP2PHttpHost(channel: P2PChannel, issue: (request: P2PHttpRequest) => Promise<Omit<P2PHttpResponse, 'kind' | 'id'>>): () => void {
  const unsubscribe = channel.onPayload(value => {
    if (!isHttpRequest(value)) return
    void (async () => {
      let response: Omit<P2PHttpResponse, 'kind' | 'id'>
      try { response = await issue(value) }
      catch (error) { response = { status: 0, headers: {}, error: error instanceof Error ? error.message : '代理请求失败' } }
      try { await channel.sendPayload({ ...response, kind: 'http:res', id: value.id } satisfies P2PHttpResponse) } catch { /* ignore */ }
    })()
  })
  return () => { if (typeof unsubscribe === 'function') unsubscribe() }
}
