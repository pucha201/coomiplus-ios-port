import type { AgentCommand, InboundEnvelope } from '@/protocol/commands'
import type { ConnectionStatus, Transport } from './transport'

/**
 * 进程内直连传输（替代 WebSocket）。
 *
 * 引擎已经是 .so（JNI 同进程），命令没必要再绕 loopback WS 一趟：
 *   · 命令：JS → CoomiAndroid.sendEngineCommand(json) → JNI → 引擎；
 *   · 事件：引擎 → JNI → Java → webView.evaluateJavascript('window.__coomiDispatchEvent(json)')
 *           → 这里挂的 window 事件监听。
 *
 * 安全阀：原生侧只有在 **Rust 事件汇注册成功** 后 supportsDirectTransport() 才返回 true；
 * 没就绪（旧壳 / 桌面端 / 调试）时 createTransport 自动回退 WsTransport，行为不变。
 */
interface DirectBridge {
  supportsDirectTransport?(): boolean
  sendEngineCommand?(json: string): void
}

/** 原生注入的入口名（Java 侧 evaluateJavascript 调它）。 */
const DISPATCH_FN = '__coomiDispatchEvent'
/** JS 侧监听的事件名。 */
const EVENT_NAME = 'coomi:engine-event'

function bridge(): DirectBridge | undefined {
  return (window as unknown as { CoomiAndroid?: DirectBridge }).CoomiAndroid
}

/** 原生直连通路是否就绪。 */
export function directTransportAvailable(): boolean {
  try {
    const api = bridge()
    return typeof api?.supportsDirectTransport === 'function' && api.supportsDirectTransport() === true
  } catch {
    return false
  }
}

export class DirectTransport implements Transport {
  /** 原生壳内直连引擎：没有宿主。 */
  readonly hostCommands = false
  private messageHandler: ((env: InboundEnvelope) => void) | null = null
  private stateHandler: ((status: ConnectionStatus) => void) | null = null
  private connected = false

  private onEvent = (event: Event) => {
    const detail = (event as CustomEvent<InboundEnvelope | string>).detail
    let env: InboundEnvelope | null = null
    try {
      env = typeof detail === 'string' ? (JSON.parse(detail) as InboundEnvelope) : (detail as InboundEnvelope)
    } catch {
      env = null
    }
    if (env && this.messageHandler) this.messageHandler(env)
  }

  private installDispatch(): void {
    const target = window as unknown as Record<string, unknown>
    if (typeof target[DISPATCH_FN] === 'function') return
    // 原生用 evaluateJavascript 调这个函数推事件；字符串直接解析，对象直接用。
    target[DISPATCH_FN] = (payload: InboundEnvelope | string) => {
      window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: payload }))
    }
  }

  connect(): void {
    if (this.connected) return
    this.connected = true
    this.installDispatch()
    window.addEventListener(EVENT_NAME, this.onEvent)
    this.stateHandler?.({ state: 'open' })
  }

  close(): void {
    if (!this.connected) return
    this.connected = false
    window.removeEventListener(EVENT_NAME, this.onEvent)
    this.stateHandler?.({ state: 'closed' })
  }

  send(command: AgentCommand): void {
    try {
      bridge()?.sendEngineCommand?.(JSON.stringify(command))
    } catch {
      /* 通道异常不该拖垮界面：命令丢了由引擎侧状态兜底 */
    }
  }

  onMessage(handler: (env: InboundEnvelope) => void): void {
    this.messageHandler = handler
  }

  onStateChange(handler: (status: ConnectionStatus) => void): void {
    this.stateHandler = handler
  }

  /** 进程内直连没有「连接断开」这个概念：只要桥在就永远是活的。 */
  isAlive(): boolean {
    return directTransportAvailable()
  }

  /** 直连无需重连；保留接口以对齐 Transport。 */
  forceReconnect(): void {
    this.stateHandler?.({ state: 'open' })
  }
}
