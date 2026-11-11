import { DirectTransport, directTransportAvailable } from './directTransport'
import { WsTransport } from './wsTransport'
import { DemoTransport } from './demoTransport'
import { isDemoMode } from './demoMode'
import { retryStateFor } from './retryPhase'
import { isIrohProxyBase } from './iroh'
import { pairingExpired } from '@/utils/pairing'
import type { PairedDevice } from '@/protocol/remote'
import type { AgentCommand } from '@/protocol/commands'
import { currentEngineBase, engineToken, isCloudConnectionMode, syncEndpointFromBridge } from './http'

// 启动即对齐原生配对页保存的远程 endpoint（有则自动进入云端模式）。
syncEndpointFromBridge()
import type { Transport } from './transport'

export type { Transport, ConnectionState, ConnectionStatus } from './transport'

const DEFAULT_RETRIES = { maxRetries: 10, backoffBase: 500, backoffMax: 10_000 }
/** 加密通道握手期间的待发命令上限（与本地 WS 的队列保持同量级）。 */
const MAX_PENDING = 32
/** 中转给足的握手时间：蜂窝网络连公共 broker、等对端心跳都可能要十几秒。 */
const RELAY_GRACE_MS = 20_000
/** 中转还没通时，隔多久复查一次局域网（回到同一 Wi-Fi 后能及时切过去）。 */
const LAN_REPROBE_MS = 30_000
function wsRetryOptions() {
  const maxRetries = Number(localStorage.getItem('coomi.wsRetryCount'))
  const backoffBase = Number(localStorage.getItem('coomi.reconnectInitialDelayMs'))
  const backoffMax = Number(localStorage.getItem('coomi.reconnectMaxDelayMs'))
  return {
    maxRetries: Number.isInteger(maxRetries) && maxRetries >= 0 && maxRetries <= 30 ? maxRetries : DEFAULT_RETRIES.maxRetries,
    backoffBase: Number.isFinite(backoffBase) && backoffBase >= 500 && backoffBase <= 60_000 ? backoffBase : DEFAULT_RETRIES.backoffBase,
    backoffMax: Number.isFinite(backoffMax) && backoffMax >= 1_000 && backoffMax <= 120_000 ? backoffMax : DEFAULT_RETRIES.backoffMax,
  }
}


function readPairedRemoteDevice(): PairedDevice | null {
  try {
    const activeId = localStorage.getItem('coomi.deviceId')
    const devices = JSON.parse(localStorage.getItem('coomi.pairedDevices') ?? '[]') as PairedDevice[]
    const device = devices.find(item => item.id === activeId)
    if (!device?.engineBase || !device.pairingSecret || !device.peerId || !device.p2pSecretHash) return null
    // 过期配对连上去只会 401，交给 OfflineTransport 直接提示重新扫码。
    if (pairingExpired(device.expiresAt)) return null
    return device
  } catch { return null }
}

function readLocalDeviceId(): string {
  try { return localStorage.getItem('coomi.localDeviceId') ?? '' } catch { return '' }
}

/** 云端没选设备/没信令时使用：明确报错，绝不回落到本地引擎。 */
class OfflineTransport implements Transport {
  readonly hostCommands = false
  private messageHandler?: (env: Parameters<Transport['onMessage']>[0] extends (value: infer T) => void ? T : never) => void
  private stateHandler?: (status: Parameters<Transport['onStateChange']>[0] extends (value: infer T) => void ? T : never) => void
  constructor(private readonly reason: string) {}
  connect(): void { this.stateHandler?.({ state: 'error', reason: this.reason }) }
  close(): void { /* nothing */ }
  send(): void { /* disconnected */ }
  onMessage(handler: (env: Parameters<Transport['onMessage']>[0] extends (value: infer T) => void ? T : never) => void): void { this.messageHandler = handler }
  onStateChange(handler: (status: Parameters<Transport['onStateChange']>[0] extends (value: infer T) => void ? T : never) => void): void {
    this.stateHandler = handler
    handler({ state: 'error', reason: this.reason })
  }
  isAlive(): boolean { return false }
  forceReconnect(): void { this.stateHandler?.({ state: 'error', reason: this.reason }) }
}

/**
 * 连接诊断：给云端首页/状态条展示“现在走到哪一步、为什么失败”。
 * reason 只写「为什么」（cause），状态由界面按 phase+state 拼——两边混一句话就会重复打架。
 */
function setTransportDiag(phase: string, state: string, reason: string): void {
  // 通道的异步回话可能晚于页面卸载（或测试环境的 window 注销），诊断广播不该把宿主拖崩。
  if (typeof window === 'undefined') return
  ;(window as unknown as { __coomiTransport?: unknown }).__coomiTransport = { phase, state, reason }
  window.dispatchEvent(new Event('coomi:transport-state'))
}

export function createTransport(sessionId: string, wsUrl?: string): Transport {
  // 演示模式不碰网络：引擎没起来也要能看界面。界面上有「演示」标记。
  if (isDemoMode()) return new DemoTransport()
  const cloudMode = isCloudConnectionMode()
  const remoteHttp = currentEngineBase()

  const pairedDevice = cloudMode ? readPairedRemoteDevice() : null
  if (cloudMode && !pairedDevice) return new OfflineTransport('云端未选择电脑，请先在侧栏选择设备')
  // iroh 已建立：engineBase 是本机代理，HTTP/WS 直接走 QUIC 隧道，
  // 不再启动 WebRTC/MQTT 回退链（否则它们会抢走 HTTP 通道）。
  if (cloudMode && pairedDevice && isIrohProxyBase(remoteHttp)) {
    const wsBase = remoteHttp.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:')
    const token = pairedDevice.pairingSecret ?? engineToken()
    const url = wsBase.replace(/\/$/, '') + '/ws/session/' + encodeURIComponent(sessionId)
      + (token ? '?token=' + encodeURIComponent(token) : '')
    return new WsTransport({ url, ...wsRetryOptions() })
  }
  // 互联只保留两条腿：iroh 隧道（上分支）与局域网直连（本函数末尾）。
  // WebRTC / MQTT「加密中转」已停用：它们比隧道多一跳、依赖公共 broker，
  // 而且旧配对没有 iroh 地址时会被迫走中转，表现就是“能连但很慢/时好时坏”。
  // 本地模式只认壳内直连：localStorage 里可能残留上一次云端配对的地址，
  // 继续拿它拼 WS 就会连到一台已经不可达的电脑，界面表现为一直重试。
  if (!cloudMode && directTransportAvailable()) return new DirectTransport()
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
  // 远程 engine（http→ws）优先；否则本机同源。
  const remoteWs = remoteHttp ? remoteHttp.replace(/^http:/, 'ws:').replace(/^https:/, 'wss:') : ''
  const base = wsUrl || import.meta.env.VITE_ENGINE_WS || remoteWs || `${protocol}//${location.host}`
  const url = base.includes('/ws/') ? base : `${base.replace(/\/$/, '')}/ws/session/${sessionId}`
  // WS 握手无法带自定义 header，改用 query 传令牌（引擎中间件同样校验）。
  const token = engineToken()
  const urlWithToken = token
    ? url + (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token)
    : url
  return new WsTransport({ url: urlWithToken, ...wsRetryOptions() })
}

