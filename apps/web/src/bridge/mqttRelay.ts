import type { AgentCommand, InboundEnvelope } from '../protocol/commands'
import type { ConnectionState, ConnectionStatus, Transport } from './transport'
import type { EncryptedSyncFrame } from '../protocol/remote'
import { deriveSyncKey } from './remoteSync'
import { MqttSignalClient, type BrokerAuthProvider } from './mqttSignaling'
import { RemoteFileTransfer, type EngineFileApi } from './fileTransfer'
import type { UploadProgress } from '../protocol/remote'

/**
 * MQTT 中转通道：在没有 TURN、又打不通 WebRTC 的网络里，
 * 用同一个 TLS MQTT broker 作为应用层中转（不是媒体服务器）。
 *
 * 安全性：房间由 pair secret 派生；业务负载全部 AES-GCM 加密，
 * broker 只能看到 from/to/seq/ack 路由字段。不携带任何引擎 Bearer。
 * 可靠性：应用层 seq + ack + 重发（QoS0 broker 之上补齐确认）。
 *
 * 限制：吞吐与延迟取决于公共 broker；文件传输不走上转，只走 WebRTC 直连。
 */
const RELAY_VERSION = 1
const ACK_TIMEOUT_MS = 1500
const MAX_ATTEMPTS = 5
/** 已握手后的心跳间隔。 */
const PING_INTERVAL_MS = 10_000
/** 还没相遇（或对端暂时消失）时的探测间隔：两端都连着 broker 才能尽快撞上。 */
const PROBE_INTERVAL_MS = 3_000
/** broker 已连上、但一直没听到对端：多久后把原因换成「电脑端没有应答」。 */
const PEER_ABSENT_MS = 8_000
/** 这么久没收到对端任何帧才算失联；只降级状态，绝不断开 broker。 */
const PEER_TIMEOUT_MS = 12_000

interface RelayFrame { v: 1; kind: 'relay'; from: string; to: string; seq?: number; ack?: number; ping?: number; pong?: number; frame?: EncryptedSyncFrame }

export interface MqttRelayOptions {
  brokerUrl: string
  roomId: string
  localId: string
  peerId: string
  sharedSecret: string
  role: 'host' | 'client'
  getBrokerAuth?: BrokerAuthProvider
  /** 手机端（client）在自己的中转通道上内置文件中转；宿主侧由桌面自己挂一份。 */
  engineFileApi?: EngineFileApi
  authorizeDownload?: (path: string) => boolean | Promise<boolean>
}

function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function isInbound(value: unknown): value is InboundEnvelope { return isRecord(value) && (value.type === 'event' || value.type === 'ack' || value.type === 'error') && 'payload' in value }
function isCommand(value: unknown): value is AgentCommand { return isRecord(value) && typeof value.command === 'string' }
function ephemeralId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  return 'coomi-relay-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
}

export class MqttRelayTransport implements Transport {
  private client: MqttSignalClient | null = null
  private key: CryptoKey | null = null
  private state: ConnectionState = 'closed'
  private closedByUser = true
  private retries = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setInterval> | null = null
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private seq = 0
  private brokerReady = false
  private brokerReadyAt = 0
  private peerAbsentReported = false
  private lastPongAt = 0
  /** 最近一次心跳往返耗时（ms）。中转「巨慢」到底慢在 broker 一跳还是应用层，先把这个数留下来。 */
  private lastRttMs: number | null = null
  private pongSamples = 0
  private decryptWarned = false
  get rttMs(): number | null { return this.lastRttMs }
  private readonly pending = new Map<number, { frame: RelayFrame; attempts: number }>()
  private readonly seen = new Set<number>()
  private readonly recentSeqs: number[] = []
  private messageHandler?: (envelope: InboundEnvelope) => void
  private stateHandler?: (status: ConnectionStatus) => void
  private commandHandler?: (command: AgentCommand) => void
  private fileTransfer: RemoteFileTransfer | null = null
  private readonly payloadHandlers = new Set<(value: unknown) => void>()

  constructor(private readonly options: MqttRelayOptions) {
    if (!options.sharedSecret) throw new Error('Relay requires the paired secret')
    if (!/^[a-f0-9]{32,96}$/i.test(options.roomId)) throw new Error('Relay room must be an opaque hex id')
    if (options.role === 'client') {
      this.fileTransfer = new RemoteFileTransfer(this, { engineApi: options.engineFileApi, authorizeDownload: options.authorizeDownload })
    }
  }

  uploadFile(file: Blob, filename: string, onProgress?: (progress: UploadProgress) => void): Promise<{ filename: string; size: number; sha256: string; path?: string }> {
    if (!this.fileTransfer) throw new Error('File transfer is owned by the desktop host on this channel')
    return this.fileTransfer.upload(file, filename, onProgress).then(result => ({ filename: result.filename, size: result.size, sha256: result.sha256, path: result.path }))
  }

  downloadFile(path: string, onProgress?: (progress: UploadProgress) => void): Promise<{ blob: Blob; filename: string; mimeType: string }> {
    if (!this.fileTransfer) throw new Error('File transfer is owned by the desktop host on this channel')
    return this.fileTransfer.download(path, onProgress)
  }

  onMessage(handler: (envelope: InboundEnvelope) => void): void { this.messageHandler = handler }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.stateHandler = handler }
  onHostCommand(handler: (command: AgentCommand) => void): void { this.commandHandler = handler }
  /** 载荷订阅可以有多个（文件中转 + HTTP 代理），后注册的不能把前一个顶掉。 */
  onPayload(handler: (value: unknown) => void): () => void {
    this.payloadHandlers.add(handler)
    return () => { this.payloadHandlers.delete(handler) }
  }

  private notifyPayload(value: unknown): void {
    for (const handler of [...this.payloadHandlers]) {
      try { handler(value) } catch (error) { console.warn('[relay] payload handler failed:', error) }
    }
  }

  connect(): void {
    if (!this.closedByUser && this.state !== 'closed' && this.state !== 'error') return
    this.closedByUser = false
    this.retries = 0
    void this.open()
  }

  close(): void {
    this.closedByUser = true
    this.brokerReady = false
    this.clearTimers()
    this.client?.close(); this.client = null
    this.key = null
    this.pending.clear(); this.seen.clear(); this.recentSeqs.length = 0
    this.fileTransfer?.close(); this.fileTransfer = null
    this.setState('closed')
  }

  isAlive(): boolean { return !this.closedByUser && (this.state === 'connecting' || this.state === 'reconnecting' || this.state === 'open') }
  /** 通道是否真的可发数据：P2P HTTP 代理只认这个，不看对象存不存在。 */
  isOpen(): boolean { return this.state === 'open' }
  forceReconnect(): void { if (!this.closedByUser) { this.brokerReady = false; this.clearTimers(); this.client?.close(); this.client = null; void this.open() } }

  send(command: AgentCommand): void { if (this.options.role !== 'client') return; void this.sendPayload(command) }

  async sendPayload(value: unknown): Promise<void> {
    const key = this.key
    if (!key || !this.client) throw new Error('Relay is not connected')
    const frame = await this.encrypt(key, value)
    const seq = ++this.seq
    const envelope: RelayFrame = { v: RELAY_VERSION, kind: 'relay', from: this.options.localId, to: this.options.peerId, seq, frame }
    this.pending.set(seq, { frame: envelope, attempts: 1 })
    this.publish(envelope)
    this.ensureRetryTimer()
  }

  private async open(): Promise<void> {
    if (this.closedByUser) return
    this.setState(this.retries ? 'reconnecting' : 'connecting')
    try {
      this.key = await deriveSyncKey(this.options.sharedSecret, this.options.roomId)
      const base = 'coomi-sync/v1/' + this.options.roomId + '/relay/'
      const client = new MqttSignalClient({
        url: this.options.brokerUrl,
        topic: base + this.options.localId,
        publishTopic: base + this.options.peerId,
        clientId: ephemeralId(),
        auth: 'anonymous',
        onDisconnect: () => this.scheduleReconnect('relay broker disconnected'),
      }, value => void this.onFrame(value))
      this.client = client
      await client.connect()
      if (this.closedByUser || this.client !== client) { client.close(); return }
      // 关键：连着 broker 就一直连着。对端在不在是另一回事 ——
      // 以前「6 秒没等到对端就整个断开」，退避越涨越长，手机什么时候发起都只能靠撞运气。
      this.brokerReady = true
      this.brokerReadyAt = Date.now()
      this.peerAbsentReported = false
      this.retries = 0
      this.sendPing()
      this.startProbeLoop()
    } catch (error) {
      this.scheduleReconnect(error instanceof Error ? error.message : 'relay connect failed')
    }
  }

  /** broker 连接不因对端缺席而断开；这里只负责发心跳/探测 ping。 */
  private startProbeLoop(): void {
    if (this.pingTimer) return
    this.pingTimer = setInterval(() => {
      if (!this.brokerReady) return
      const now = Date.now()
      if (this.state === 'open') {
        // 对端失联只降级状态：broker 留着，继续探测，对端回来立刻恢复。
        if (now - this.lastPongAt > PEER_TIMEOUT_MS) this.setState('reconnecting', { reason: 'relay peer heartbeat lost' })
        else if (now - this.lastPongAt < PING_INTERVAL_MS) return
      } else if (!this.peerAbsentReported && !this.lastPongAt && now - this.brokerReadyAt >= PEER_ABSENT_MS) {
        // broker 明显是通的（我们连上了），但房间里始终没有对端应答：
        // 这既不是「中转不可用」，也不是「配对失效」，必须原样告诉用户去电脑那侧看。
        this.peerAbsentReported = true
        this.setState('connecting', { reason: 'relay peer absent' })
      }
      this.sendPing()
    }, PROBE_INTERVAL_MS)
  }

  private sendPing(): void {
    if (!this.brokerReady) return
    try { this.client?.publishRaw({ v: RELAY_VERSION, kind: 'relay', from: this.options.localId, to: this.options.peerId, ping: Date.now() } satisfies RelayFrame) } catch { /* broker close handler owns reconnect */ }
  }

  private publish(envelope: RelayFrame): void {
    try { this.client?.publishRaw(envelope) } catch (error) { this.scheduleReconnect(error instanceof Error ? error.message : 'relay publish failed') }
  }

  private async onFrame(value: unknown): Promise<void> {
    if (!isRecord(value) || value.v !== RELAY_VERSION || value.kind !== 'relay') return
    const frame = value as unknown as RelayFrame
    if (frame.to !== this.options.localId || frame.from !== this.options.peerId) return
    if (typeof frame.ping === 'number') {
      try { this.client?.publishRaw({ v: RELAY_VERSION, kind: 'relay', from: this.options.localId, to: this.options.peerId, pong: frame.ping } satisfies RelayFrame) } catch { /* ignore */ }
      this.markOpen()
      return
    }
    if (typeof frame.pong === 'number') {
      this.lastPongAt = Date.now()
      if (frame.pong > 0) {
        this.lastRttMs = Math.max(0, this.lastPongAt - frame.pong)
        // 一分钟一条就够：目的是判断「慢在 broker」而不是刷日志。
        if (++this.pongSamples % 6 === 0) {
          console.info(`[coomi] relay rtt ${this.lastRttMs}ms (${this.options.role})`)
        }
      }
      this.markOpen()
      return
    }
    if (typeof frame.ack === 'number') { this.pending.delete(frame.ack); return }
    if (typeof frame.seq !== 'number' || !frame.frame) return
    if (this.seen.has(frame.seq)) { try { this.client?.publishRaw({ v: RELAY_VERSION, kind: 'relay', from: this.options.localId, to: this.options.peerId, ack: frame.seq } satisfies RelayFrame) } catch { /* ignore */ } return }
    this.remember(frame.seq)
    try { this.client?.publishRaw({ v: RELAY_VERSION, kind: 'relay', from: this.options.localId, to: this.options.peerId, ack: frame.seq } satisfies RelayFrame) } catch { /* ignore */ }
    const key = this.key
    if (!key) return
    try {
      const plain = await this.decrypt(key, frame.frame)
      this.markOpen()
      if (this.options.role === 'host' && isCommand(plain)) { this.commandHandler?.(plain); return }
      if (this.options.role === 'client' && isInbound(plain)) { this.messageHandler?.(plain); return }
      this.notifyPayload(plain)
    } catch (error) {
      // 解不开的帧只能丢，但静默丢就是「消息发了没回」：留一条能查的证据（只报一次）。
      if (!this.decryptWarned) {
        this.decryptWarned = true
        console.warn('[coomi] relay frame dropped: decrypt failed', error instanceof Error ? error.message : error)
      }
    }
  }

  private markOpen(): void {
    this.lastPongAt = Date.now()
    if (this.state === 'open') return
    this.retries = 0
    this.setState('open')
  }

  private remember(seq: number): void {
    this.seen.add(seq); this.recentSeqs.push(seq)
    if (this.recentSeqs.length > 256) { const drop = this.recentSeqs.shift(); if (drop !== undefined) this.seen.delete(drop) }
  }

  private ensureRetryTimer(): void {
    if (this.retryTimer) return
    this.retryTimer = setInterval(() => {
      if (!this.pending.size) return
      for (const [seq, entry] of [...this.pending]) {
        if (entry.attempts >= MAX_ATTEMPTS) { this.pending.delete(seq); continue }
        entry.attempts += 1
        this.publish(entry.frame)
      }
    }, ACK_TIMEOUT_MS)
  }

  private scheduleReconnect(reason: string): void {
    if (this.closedByUser || this.reconnectTimer) return
    this.brokerReady = false
    this.peerAbsentReported = false
    this.clearTimers()
    this.client?.close(); this.client = null
    this.retries += 1
    const delayMs = Math.min(30_000, 800 * 2 ** Math.min(this.retries - 1, 5))
    this.setState('reconnecting', { attempt: this.retries, delayMs, reason })
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.open() }, delayMs)
  }

  private clearTimers(): void {
    if (this.retryTimer) clearInterval(this.retryTimer)
    if (this.pingTimer) clearInterval(this.pingTimer)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.retryTimer = null; this.pingTimer = null; this.reconnectTimer = null
  }

  private setState(state: ConnectionState, extra: Omit<ConnectionStatus, 'state'> = {}): void {
    this.state = state
    this.stateHandler?.({ state, ...extra })
  }

  private async encrypt(key: CryptoKey, value: unknown): Promise<EncryptedSyncFrame> {
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const clear = new TextEncoder().encode(JSON.stringify(value)) as unknown as BufferSource
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as unknown as BufferSource }, key, clear)
    return { v: 1, iv: this.b64(iv), ciphertext: this.b64(new Uint8Array(cipher)) }
  }

  private async decrypt(key: CryptoKey, frame: EncryptedSyncFrame): Promise<unknown> {
    const iv = this.unb64(frame.iv) as unknown as BufferSource
    const data = this.unb64(frame.ciphertext) as unknown as BufferSource
    const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data)
    return JSON.parse(new TextDecoder().decode(clear)) as unknown
  }

  private b64(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
  private unb64(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)) }
}
