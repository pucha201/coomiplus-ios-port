import type { AgentCommand, InboundEnvelope } from '@/protocol/commands'
import type { UploadProgress } from '@/protocol/remote'
import { authedFetch } from './http'
import { wrapCommand } from './envelope'
import { retryStateFor } from './retryPhase'
import type { ConnectionState, ConnectionStatus, Transport } from './transport'

/** 离线待发队列上限：超过就丢最早的，并且必须让用户看得见。 */
const MAX_OUTBOX = 32

export interface WsTransportOptions {
  url: string
  maxRetries?: number
  backoffBase?: number
  backoffMax?: number
  /** 应用层 ping 间隔 ms，默认 10s */
  heartbeatMs?: number
  /** 超过该时间无任何消息则判定链路假死并重连，默认 25s */
  silentTimeoutMs?: number
  /** 重试耗尽后每 30s 尝试复活的间隔 ms，默认 30000 */
  stalledReviveMs?: number
}

export class WsTransport implements Transport {
  /** 直连引擎（本机或云端 LAN）：没有宿主在中间，宿主命令不能发。 */
  readonly hostCommands = false
  private ws: WebSocket | null = null
  private msgHandlers: ((env: InboundEnvelope) => void)[] = []
  private stateHandlers: ((status: ConnectionStatus) => void)[] = []
  private retries = 0
  private closedByUser = false
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null
  private reviveTimer: ReturnType<typeof setInterval> | null = null
  private lastMessageAt = 0
  private lastEventSeq = 0
  /** 连接建立前发送的命令，onopen 后 flush */
  private outbox: AgentCommand[] = []
  private stalled = false
  /** 连续异常关闭（1006 等）计数：引擎重启会连报多次，触发后立即重建 */
  private abnormalCloseCount = 0
  private reviveDelayMs: number | null = null
  private onOnline: (() => void) | null = null
  private onVisible: (() => void) | null = null
  /** 出队溢出提示只报一次：断线期间反复丢包不该刷屏。连上后复位。 */
  private outboxOverflowWarned = false
  /** 这条传输是否成功打开过：决定失败时显示“连接中”还是“正在重连”。 */
  private everOpened = false
  /** 本次 connect() 的起点：首次连接宽限期从这里算。 */
  private startedAt = 0

  constructor(private readonly opts: WsTransportOptions) {}

  /**
   * iroh 模式下引擎 base 是本机代理，附件直接走宿主的 HTTP 上传接口
   * （start → chunk → finish）。隧道会把配对 Authorization 换成宿主引擎 token。
   */
  async uploadFile(
    file: Blob,
    filename: string,
    onProgress?: (progress: UploadProgress) => void,
  ): Promise<{ filename: string; size: number; sha256: string; path?: string }> {
    const buffer = await file.arrayBuffer()
    const digest = await crypto.subtle.digest('SHA-256', buffer)
    const sha256 = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    const started = await authedFetch('/api/device/uploads', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ filename, size: file.size, sha256 }),
    })
    const startData = await started.json().catch(() => ({})) as { upload_id?: string; chunk_size?: number; error?: string }
    if (!started.ok || !startData.upload_id) {
      throw new Error(startData.error || `上传初始化失败（HTTP ${started.status}）`)
    }
    const uploadId = startData.upload_id
    const chunkSize = Math.min(Number(startData.chunk_size) || 512 * 1024, 512 * 1024)
    let offset = 0
    while (offset < buffer.byteLength) {
      const end = Math.min(offset + chunkSize, buffer.byteLength)
      const chunk = buffer.slice(offset, end)
      const response = await authedFetch(
        `/api/device/uploads/${encodeURIComponent(uploadId)}/chunk?offset=${offset}`,
        { method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: chunk },
      )
      if (!response.ok) {
        const detail = await response.text().catch(() => '')
        throw new Error(detail || `上传分片失败（HTTP ${response.status}）`)
      }
      offset = end
      onProgress?.({
        loaded: offset,
        total: file.size,
        percent: file.size > 0 ? Math.round(offset / file.size * 100) : 100,
      })
    }
    const finished = await authedFetch(`/api/device/uploads/${encodeURIComponent(uploadId)}/finish`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    })
    const finishData = await finished.json().catch(() => ({})) as { filename?: string; size?: number; sha256?: string; path?: string; error?: string }
    if (!finished.ok) throw new Error(finishData.error || `上传完成确认失败（HTTP ${finished.status}）`)
    return {
      filename: finishData.filename || filename,
      size: finishData.size ?? file.size,
      sha256: finishData.sha256 ?? sha256,
      path: finishData.path,
    }
  }

  connect(): void {
    this.closedByUser = false
    this.stalled = false
    this.abnormalCloseCount = 0
    this.reviveDelayMs = null
    this.startedAt = Date.now()
    this.stopRevive()
    this.open()
  }

  /**
   * 引擎重启通知：清空重试计数，强制立即重建 WS。
   * 引擎重启后旧连接必死（即使 readyState 短暂仍显示 OPEN），必须重建。
   */
  forceReconnect(): void {
    if (this.closedByUser) return
    this.retries = 0
    this.stalled = false
    this.abnormalCloseCount = 0
    this.stopRevive()
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // 关闭现有连接（如果有），然后立即 open
    if (this.ws) {
      // 先清 handlers 避免 close 事件触发 scheduleReconnect
      this.ws.onopen = null
      this.ws.onmessage = null
      this.ws.onerror = null
      this.ws.onclose = null
      try { this.ws.close() } catch { /* ignore */ }
      this.ws = null
    }
    this.open()
  }

  private open(): void {
    this.emitState('connecting')
    try { this.ws = new WebSocket(this.opts.url) } catch { this.scheduleReconnect('无法创建连接'); return }
    this.ws.onopen = () => {
      this.retries = 0
      this.stalled = false
      this.abnormalCloseCount = 0
      this.everOpened = true
      this.outboxOverflowWarned = false
      this.lastMessageAt = Date.now()
      this.stopRevive()
      this.emitState('open')
      this.startHeartbeat()
      if (this.lastEventSeq > 0) {
        this.send({ command: 'resync_events', after_seq: this.lastEventSeq } as AgentCommand)
      }
      this.flushOutbox()
    }
    this.ws.onmessage = (ev) => {
      this.lastMessageAt = Date.now()
      try {
        const env = JSON.parse(ev.data as string) as InboundEnvelope
        this.trackSeq(env)
        this.msgHandlers.forEach(h => h(env))
      } catch { /* ignore */ }
    }
    this.ws.onerror = () => this.emitState('error', { reason: '连接发生错误' })
    this.ws.onclose = (event) => {
      this.stopHeartbeat()
      if (this.closedByUser) { this.emitState('closed'); return }
      // 异常关闭（1006 引擎重启等）：只加快退避，**不重置重试次数**。
      // 以前这里在连续两次异常后把 retries 清零并立即重连，遇到「令牌错误 / WS 路径不对」
      // 这种必然失败的服务端拒绝时，就永远到不了停摆态 —— 界面无限显示“正在重连”。
      const reason = event.reason || (event.code ? `连接关闭 (${event.code})` : '连接关闭')
      if (event.code === 1006 || event.code === 1005 || event.code === 1001) {
        this.abnormalCloseCount += 1
      }
      this.scheduleReconnect(reason)
    }
  }

  private trackSeq(env: InboundEnvelope): void {
    const payload = (env as { payload?: { event_seq?: number; event_type?: string } }).payload
      ?? (env as unknown as { event_seq?: number; event_type?: string })
    const seq = payload?.event_seq
    if (typeof seq === 'number' && seq > this.lastEventSeq) {
      this.lastEventSeq = seq
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat()
    const hb = this.opts.heartbeatMs ?? 10_000
    const silent = this.opts.silentTimeoutMs ?? 25_000
    this.heartbeatTimer = setInterval(() => {
      if (this.ws?.readyState !== WebSocket.OPEN) return
      if (this.lastMessageAt && Date.now() - this.lastMessageAt > silent) {
        this.ws.close()
        return
      }
      try {
        this.ws.send(JSON.stringify(wrapCommand({ command: 'ping' } as AgentCommand)))
      } catch { /* ignore */ }
    }, hb)
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer)
    this.heartbeatTimer = null
  }

  private startRevive(): void {
    if (this.reviveTimer || this.closedByUser) return
    // Keep the no-abandon policy, but don't leave a recovered network idle for 30s.
    const configured = this.opts.stalledReviveMs ?? 30_000
    this.reviveDelayMs = this.reviveDelayMs === null ? Math.min(configured, 2_000) : Math.min(configured, Math.ceil(this.reviveDelayMs * 1.7))
    const revive = (): void => {
      if (this.closedByUser || !this.stalled || this.ws?.readyState === WebSocket.OPEN) return
      this.retries = 0
      this.stalled = false
      this.stopRevive()
      this.open()
    }
    this.reviveTimer = setTimeout(() => { this.reviveTimer = null; revive() }, this.reviveDelayMs) as unknown as ReturnType<typeof setInterval>
    if (typeof window !== 'undefined') {
      if (!this.onOnline) { this.onOnline = revive; window.addEventListener('online', this.onOnline) }
      if (!this.onVisible) { this.onVisible = () => { if (document.visibilityState === 'visible') revive() }; document.addEventListener('visibilitychange', this.onVisible) }
    }
  }

  private stopRevive(): void {
    if (this.reviveTimer) clearTimeout(this.reviveTimer as unknown as ReturnType<typeof setTimeout>)
    this.reviveTimer = null
    if (typeof window !== 'undefined' && this.onOnline) window.removeEventListener('online', this.onOnline)
    if (typeof document !== 'undefined' && this.onVisible) document.removeEventListener('visibilitychange', this.onVisible)
    this.onOnline = null
    this.onVisible = null
  }

  private scheduleReconnect(reason: string): void {
    const max = this.opts.maxRetries ?? 10
    if (this.retries >= max) {
      this.stalled = true
      this.emitState('error', {
        attempt: this.retries,
        maxRetries: max,
        reason: `${reason}，已进入停摆态，网络恢复后自动尝试`,
      })
      this.startRevive()
      // 浏览器 online 事件立即复活
      if (typeof window !== 'undefined') {
        const onOnline = () => {
          window.removeEventListener('online', onOnline)
          if (this.closedByUser || !this.stalled) return
          this.retries = 0
          this.stalled = false
          this.abnormalCloseCount = 0
          this.stopRevive()
          this.open()
        }
        window.addEventListener('online', onOnline)
      }
      return
    }
    // 异常关闭（引擎重启）时用更短的退避：前 3 次最多 1s，之后恢复正常指数退避
    const base = this.abnormalCloseCount > 0 ? Math.min(this.opts.backoffBase ?? 500, 400) : (this.opts.backoffBase ?? 500)
    const delay = Math.min(base * 2 ** this.retries, this.opts.backoffMax ?? 10_000)
    this.retries += 1
    const state = retryStateFor({
      everOpened: this.everOpened,
      elapsedMs: Date.now() - this.startedAt,
    })
    this.emitState(state, { attempt: this.retries, maxRetries: max, delayMs: delay, reason })
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }

  close(): void {
    this.closedByUser = true
    this.stalled = false
    this.stopHeartbeat()
    this.stopRevive()
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.outbox = []
    this.ws?.close()
  }

  /**
   * 「活着」= 没有主动关闭、没有停摆，且还有恢复通道（socket 在 / 退避重连在排 /
   * 兜底复活在跑）。只有重试耗尽进入停摆态（stalled）才算死 —— 这时外部应重建而不是干等。
   * connect() 幂等判断用：同一个会话的活连接不应被 ChatView 反复挂载拆掉重建。
   */
  isAlive(): boolean {
    return !this.closedByUser && !this.stalled && (this.ws !== null || this.reconnectTimer !== null || this.reviveTimer !== null)
  }

  send(command: AgentCommand): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(wrapCommand(command)))
      return
    }
    // 未连接：入队，连上后 flush（避免静默丢弃）
    this.outbox.push(command)
    if (this.outbox.length > MAX_OUTBOX) {
      // 溢出必须说出来：以前这里静默 shift，断线久了用户的消息会无声消失，
      // 连上后只发出一部分，界面上看不出少了什么。
      this.outbox.shift()
      if (!this.outboxOverflowWarned) {
        this.outboxOverflowWarned = true
        this.emitState('error', {
          reason: `离线待发命令已超过 ${MAX_OUTBOX} 条，最早的一条被丢弃`,
        })
      }
    }
  }

  private flushOutbox(): void {
    const pending = this.outbox.splice(0, this.outbox.length)
    for (const cmd of pending) {
      try {
        this.ws?.send(JSON.stringify(wrapCommand(cmd)))
      } catch { /* drop on send failure after reconnect */ }
    }
  }

  onMessage(handler: (env: InboundEnvelope) => void): void { this.msgHandlers.push(handler) }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.stateHandlers.push(handler) }
  private emitState(state: ConnectionState, detail: Omit<ConnectionStatus, 'state'> = {}): void {
    this.stateHandlers.forEach(h => h({ state, ...detail }))
  }
}
