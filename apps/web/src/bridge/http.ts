import { ref } from 'vue'
import { pairingExpired } from '@/utils/pairing'
import { hasP2PChannel, p2pFetch } from './p2pHttp'
// HTTP API 基址推导。
// 生产：web 由 bridge 同源伺服 → 用相对路径（base=""）。
// 开发：若设了 VITE_ENGINE_WS（ws://host:port），推导出 http://host:port。
function deriveBase(): string {
  const ws = import.meta.env.VITE_ENGINE_WS as string | undefined
  if (!ws) return '' // same-origin
  try {
    const u = new URL(ws)
    const proto = u.protocol === 'wss:' ? 'https:' : 'http:'
    return `${proto}//${u.host}`
  } catch {
    return ''
  }
}

const REMOTE_BASE_KEY = 'coomi.engineBase'
const REMOTE_TOKEN_KEY = 'coomi.engineToken'

interface StoredPairedDevice { id?: string; engineBase?: string; pairingSecret?: string; expiresAt?: number }

/**
 * 当前选中的配对电脑：顶层 `coomi.engineBase` / `coomi.engineToken` 只是配对时写的副本，
 * 一旦被清掉（换机、原生桥只回写了设备列表），云端请求会以为「没有远程地址」，
 * 于是退回本机同源 —— 那就是「云端历史里全是本地会话」。过期的配对不救：401 只会更迷惑。
 */
function selectedPairedDevice(): StoredPairedDevice | null {
  try {
    const activeId = localStorage.getItem('coomi.deviceId')
    if (!activeId) return null
    const devices = JSON.parse(localStorage.getItem('coomi.pairedDevices') ?? '[]') as StoredPairedDevice[]
    const device = devices.find(item => item.id === activeId) ?? null
    return device && !pairingExpired(device.expiresAt) ? device : null
  } catch { return null }
}

function pairedDeviceBase(): string {
  const base = selectedPairedDevice()?.engineBase?.trim().replace(/\/$/, '') ?? ''
  return /^https?:\/\//.test(base) ? base : ''
}

/** Current HTTP endpoint. Empty means same-origin local engine. */
export let API_BASE = (() => {
  try {
    // 本地模式永远同源：云端配对时写入的地址不能带进本地模式。
    if (localStorage.getItem('coomi.connectionMode') !== 'cloud') return deriveBase()
    const saved = localStorage.getItem(REMOTE_BASE_KEY)?.trim() || pairedDeviceBase()
    if (saved) return saved
  } catch { /* storage unavailable */ }
  return deriveBase()
})()

export function isCloudConnectionMode(): boolean {
  try { return localStorage.getItem('coomi.connectionMode') === 'cloud' } catch { return false }
}

export function currentEngineBase(): string {
  if (!isCloudConnectionMode()) return deriveBase()
  try {
    return localStorage.getItem(REMOTE_BASE_KEY)?.trim() || pairedDeviceBase() || API_BASE
  } catch { return API_BASE }
}

/** Switch endpoint without reloading the web app. Pass empty base to return local. */
export function setEngineEndpoint(baseUrl: string, token?: string): void {
  const normalized = baseUrl.trim().replace(/\/$/, '')
  API_BASE = normalized || deriveBase()
  try {
    if (normalized) localStorage.setItem(REMOTE_BASE_KEY, normalized)
    else localStorage.removeItem(REMOTE_BASE_KEY)
    if (token !== undefined) {
      if (token) localStorage.setItem(REMOTE_TOKEN_KEY, token)
      else localStorage.removeItem(REMOTE_TOKEN_KEY)
    }
  } catch { /* storage unavailable */ }
  if (token !== undefined) {
    ENGINE_TOKEN = token.trim()
    tokenRevision.value++
  }
}

/**
 * 引擎访问令牌：由 Android 侧注入页面 URL query（?token=…）。
 * 仅在模块加载时读取一次，并立即用 history.replaceState 从地址栏/浏览器历史中
 * 清除，避免令牌持久留在系统浏览器历史、跨设备同步或扩展可见范围内。
 */
let ENGINE_TOKEN: string = (() => {
  try {
    const configured = localStorage.getItem(REMOTE_TOKEN_KEY)
    if (configured) return configured
    const token = new URLSearchParams(window.location.search).get('token') ?? ''
    if (token && window.history?.replaceState) {
      const url = new URL(window.location.href)
      url.searchParams.delete('token')
      window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`)
    }
    return token
  } catch {
    return ''
  }
})()

/**
 * 令牌获取版本号：0 → 1 表示「拿到了令牌」。
 * 页面在首帧可能还拿不到（原生尚未把 token 传进来 / 重载后 URL 已被清），
 * 依赖它的 computed 会在拿到后自动重绘（图片、预览、下载链接都在此列）。
 */
export const tokenRevision = ref(0)

/** 原生侧（Android 配对页）保存的远程 engine 地址/令牌 → 应用到 Web 层。启动时调用一次。 */
export function syncEndpointFromBridge(): void {
  try {
    const bridge = (window as unknown as { CoomiAndroid?: { getEngineBase?: () => string; getRemoteToken?: () => string } }).CoomiAndroid
    // 本地模式由同源引擎提供页面：此时绝不能把原生桥里的云端地址写进来。
    if (!isCloudConnectionMode()) return
    const base = bridge?.getEngineBase?.()?.trim() ?? ''
    const token = bridge?.getRemoteToken?.()?.trim() ?? ''
    if (!base) return
    if (base === currentEngineBase() && (!token || token === ENGINE_TOKEN)) return
    setEngineEndpoint(base, token || undefined)
  } catch { /* 非原生壳忽略 */ }
}

/**
 * 引擎访问令牌。
 * 本地模式只认原生提供的本地引擎 token；云端模式只认配对 token。
 * 两套凭据混用会得到「切回本地后模型列表 401 / WS 一直重试」。
 */
export function engineToken(): string {
  const cloud = isCloudConnectionMode()
  if (cloud) {
    try {
      const configured = localStorage.getItem(REMOTE_TOKEN_KEY)?.trim()
      if (configured) {
        if (configured !== ENGINE_TOKEN) { ENGINE_TOKEN = configured; tokenRevision.value++ }
        return configured
      }
    } catch { /* ignore */ }
    if (ENGINE_TOKEN.startsWith('coomi_pair_')) return ENGINE_TOKEN
    const paired = selectedPairedDevice()?.pairingSecret?.trim()
    if (paired) { ENGINE_TOKEN = paired; tokenRevision.value++; return paired }
    try {
      const remote = (window as unknown as { CoomiAndroid?: { getRemoteToken?: () => string } })
        .CoomiAndroid?.getRemoteToken?.()?.trim()
      if (remote) { ENGINE_TOKEN = remote; tokenRevision.value++; return remote }
    } catch { /* ignore */ }
    return ''
  }
  // 本地：内存里是本地 token 就直接用；是云端遗留就重新向原生桥 / 持久化键取。
  if (ENGINE_TOKEN && !ENGINE_TOKEN.startsWith('coomi_pair_')) return ENGINE_TOKEN
  let local = ''
  try { local = localStorage.getItem('coomi.localEngineToken')?.trim() ?? '' } catch { /* ignore */ }
  try {
    const fromBridge = (window as unknown as { CoomiAndroid?: { getEngineToken?: () => string } })
      .CoomiAndroid?.getEngineToken?.()?.trim()
    if (fromBridge && !fromBridge.startsWith('coomi_pair_')) local = fromBridge
  } catch { /* 非原生壳忽略 */ }
  if (local) {
    ENGINE_TOKEN = local
    tokenRevision.value++
    return local
  }
  ENGINE_TOKEN = ''
  return ''
}

/**
 * 启动时等本机引擎令牌就绪。
 *
 * 页面模块求值往往早于原生壳把 token 注进来（或原生桥刚创建还没回填），
 * 这一瞬间发出去的 /api 全部 401；以前只能靠用户手动切一次「本地」
 * 触发 restoreLocalEndpoint 才恢复。这里给启动加载一个短暂等待窗口：
 * 拿到令牌立刻返回，超时才让调用方把任务留在重试队列里。
 */
export async function waitForEngineToken(timeoutMs = 2500): Promise<string> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const token = engineToken()
    if (token) return token
    if (Date.now() >= deadline) return ''
    await new Promise(resolve => setTimeout(resolve, 150))
  }
}

/** 二进制接口不进 JSON 通道：预览/下载仍要直连或走文件传输通道。 */
function isBinaryApiPath(path: string): boolean { return /^\/api\/(fs\/(raw|download)|attachments?\/)/.test(path) }

/** 带引擎令牌的 fetch：所有 /api/* 与 /ws/* 请求必须携带 Bearer token。 */
export async function authedFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const headers = new Headers(init?.headers)
  const token = engineToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  const endpoint = currentEngineBase()
  const url = typeof input === 'string' && input.startsWith('/') ? endpoint + input : input
  if (isCloudConnectionMode()) {
    const target = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url
    const path = endpoint && target.startsWith(endpoint) ? target.slice(endpoint.length) || '/'
      : target.startsWith('/') ? target : ''
    // 云端 + 加密通道已开：JSON API 代理到电脑，与地址栏里那个「远程基址」无关。
    if (path && !isBinaryApiPath(path) && hasP2PChannel()) return p2pFetch(path, { ...init, headers })
    // 云端既没通道也没远程地址：同源站着的是本机引擎，宁可报错也不能把它当成云端数据。
    // 文案说人话：这条错误会原样出现在多张页面顶部，「请求没有发出」对用户没有信息量。
    if (!endpoint) throw new Error('云端模式还没有选择电脑')
  }
  return fetch(url, { ...init, headers })
}

/**
 * 引擎请求的统一 JSON 解析：桥把 SPA 以 200 回给 /api/*（引擎死了、或开发期没起引擎）时，
 * 直接 response.json() 会得到 `Unexpected token '<'`，对用户毫无信息量。
 * 这里统一翻译成一句能指向「连接」的提示。
 */
async function parseJson(response: Response, allowEmpty = false): Promise<any> {
  const text = await response.text()
  if (!text) {
    // 查询接口拿到空 body 不是「空数据」：那是引擎/桥没给出答案。
    // 以前这里返回 {}，列表页把「没回答」画成「一条都没有」，还不报错。
    if (allowEmpty) return {}
    throw new Error(`电脑端返回了空响应（HTTP ${response.status}），请检查连接`)
  }
  try { return JSON.parse(text) } catch {
    throw new Error(`电脑端返回了非 JSON 响应（HTTP ${response.status}），请检查连接`)
  }
}

/**
 * 请求失败的统一翻译。页面会把这个 Error 的 message 原样贴到通知/错误条上，
 * 所以兜底文案不能说「GET /api/xxx → 404」这种只有开发看得懂的话；
 * 方法、路径这些排障信息留在 console，用户只看到能接着做的一句。
 */
function requestError(r: Response, method: string, path: string, data: any): Error {
  if (typeof data?.error === 'string' && data.error) return new Error(data.error)
  if (typeof data?.message === 'string' && data.message) return new Error(data.message)
  console.warn(`[coomi] ${method} ${path} → HTTP ${r.status}`)
  return new Error(`请求失败（HTTP ${r.status}）`)
}

/**
 * 传输层失败在浏览器里是三副面孔：Failed to fetch（Chrome）、load failed（iOS WebView）、
 * aborted（取消）。各页面以前遇到这类消息干脆不显示错误，于是「连不上电脑」在界面上
 * 表现为一片空白 —— 该出现的东西没出现。统一翻成一句能接着做的事。
 */
export function userError(cause: unknown): string {
  const msg = cause instanceof Error ? cause.message : String(cause)
  if (/failed to fetch|networkerror|network request failed|load failed|\baborted\b|\berr_[a-z_]+/i.test(msg)) {
    return '连不上电脑，请确认电脑端在线后重试'
  }
  return msg
}

export async function apiGet<T>(path: string): Promise<T> {
  const r = await authedFetch(`${currentEngineBase()}${path}`, { headers: { Accept: 'application/json' } })
  const data = await parseJson(r)
  if (!r.ok) throw requestError(r, 'GET', path, data)
  return data as T
}

export async function apiSend<T>(path: string, method: 'POST' | 'PUT' | 'DELETE', body?: unknown): Promise<T> {
  const r = await authedFetch(`${currentEngineBase()}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  const data = await parseJson(r, true)
  if (!r.ok) throw requestError(r, method, path, data)
  return data as T
}
