import type { AgentCommand, InboundEnvelope } from '../protocol/commands'
import type { ConnectionState, ConnectionStatus, Transport } from './transport'
import type { AuthenticatedRtcSignal, EncryptedSyncFrame, PairedDevice, RelayGuarantee, RtcSignal, RtcSignalPayload, RemoteFileMessage, UploadProgress } from '../protocol/remote'
import { MqttSignalClient, mqttSignalTopic, type BrokerAuthProvider, type MqttSignalOptions } from './mqttSignaling'
import { RemoteFileTransfer, type EngineFileApi } from './fileTransfer'


export type RemoteSyncRole = 'host' | 'client'
export { DEFAULT_SYNC_BROKER_URL } from '../utils/brokerConfig'
import { isBrokerUrlAllowed } from '../utils/brokerConfig'
export interface RemotePeerTransportConfig { brokerUrl: string; localDeviceId: string; iceServers?: RTCIceServer[] }
export type EngineEnvelopeSubscriber = (handler: (envelope: InboundEnvelope) => void) => () => void
export interface RemoteSyncOptions {
  brokerUrl: string
  deviceId: string
  peerDeviceId: string
  sharedSecret: string
  getBrokerAuth?: BrokerAuthProvider
  role: RemoteSyncRole
  iceServers?: RTCIceServer[]
  reconnectMs?: number
  dataChannelLabel?: string
  engineFileApi?: EngineFileApi
  authorizeDownload?: (path: string) => boolean | Promise<boolean>
}
type PayloadHandler = (value: unknown) => void
export type RemoteEngineCommand = { command: string } & object
type RtcSignalContent = Pick<RtcSignalPayload, 'type' | 'sdp' | 'candidate'>
const encoder = new TextEncoder()
function ephemeralClientId(): string { const bytes = crypto.getRandomValues(new Uint8Array(16)); return 'coomi-' + Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('') }
type HostCommandHandler = (command: AgentCommand) => Promise<InboundEnvelope | void> | InboundEnvelope | void
const decoder = new TextDecoder()

function base64(bytes: Uint8Array): string { let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte); return btoa(binary) }
function unbase64(value: string): Uint8Array { const binary = atob(value); return Uint8Array.from(binary, char => char.charCodeAt(0)) }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null }
function isAgentCommand(value: unknown): value is AgentCommand { return isRecord(value) && typeof value.command === 'string' }
function isInbound(value: unknown): value is InboundEnvelope { return isRecord(value) && (value.type === 'event' || value.type === 'ack' || value.type === 'error') && 'payload' in value }

/** Derive a domain-separated opaque room id from the P2P pairing-secret hash. */
export async function deriveSignalingRoomId(secret: string): Promise<string> {
  if (!secret) throw new Error('Pairing secret is required')
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode('coomi-signal-room-v1:' + secret))
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}
export async function deriveSyncKey(secretHash: string, roomId: string): Promise<CryptoKey> {
  if (!/^[a-f0-9]{64}$/i.test(secretHash)) throw new Error('P2P secret must be a SHA-256 hex digest')
  const ikm = Uint8Array.from(secretHash.match(/.{2}/g) ?? [], pair => Number.parseInt(pair, 16))
  const salt = Uint8Array.from(roomId.match(/.{2}/g) ?? [], pair => Number.parseInt(pair, 16))
  const material = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveKey'])
  return crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt, info: encoder.encode('coomi-sync-v1/aes-256-gcm') }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
}
export async function encryptSyncFrame(key: CryptoKey, value: unknown): Promise<EncryptedSyncFrame> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const ciphertext = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(JSON.stringify(value)))
  return { v: 1, iv: base64(iv), ciphertext: base64(new Uint8Array(ciphertext)) }
}
export async function decryptSyncFrame<T>(key: CryptoKey, frame: EncryptedSyncFrame): Promise<T> {
  if (frame.v !== 1) throw new Error('Unsupported encrypted sync frame')
  const iv = new Uint8Array(unbase64(frame.iv))
  const ciphertext = new Uint8Array(unbase64(frame.ciphertext))
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, ciphertext)
  return JSON.parse(decoder.decode(clear)) as T
}

/** WebRTC DataChannel backed transport. Client sends engine commands; host only bridges them locally. */
export class RemoteSyncTransport implements Transport {
  private readonly options: RemoteSyncOptions
  readonly relayGuarantee: RelayGuarantee
  private roomId = ''
  private signalQueue: Promise<void> = Promise.resolve()
  private localDescriptionPublished = false
  private pc: RTCPeerConnection | null = null
  private channel: RTCDataChannel | null = null
  private signaling: MqttSignalClient | null = null
  private key: CryptoKey | null = null
  private state: ConnectionState = 'closed'
  private retries = 0
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = true
  private messageHandler?: (envelope: InboundEnvelope) => void
  private statusHandler?: (status: ConnectionStatus) => void
  private readonly payloadHandlers = new Set<PayloadHandler>()
  private fileTransfer: RemoteFileTransfer | null = null
  private commandHandler?: HostCommandHandler
  private pendingCandidates: RTCIceCandidateInit[] = []
  private localCandidateHistory: RTCIceCandidateInit[] = []
  private seenRemoteCandidates = new Set<string>()
  private offerRetryTimer: ReturnType<typeof setInterval> | null = null
  private pendingRemoteCandidates: RTCIceCandidateInit[] = []
  private cachedOffer: RTCSessionDescriptionInit | null = null
  private cachedAnswer: RTCSessionDescriptionInit | null = null
  constructor(options: RemoteSyncOptions) {
    this.options = options
    const servers = options.iceServers ?? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }]
    this.relayGuarantee = servers.some(server => (Array.isArray(server.urls) ? server.urls : [server.urls]).some(url => url.startsWith('turn:') || url.startsWith('turns:'))) ? 'turn-configured' : 'not-guaranteed'
  }
  onMessage(handler: (envelope: InboundEnvelope) => void): void { this.messageHandler = handler }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.statusHandler = handler }
  canGuaranteeCrossNetworkRelay(): boolean { return this.relayGuarantee === 'turn-configured' }
  onPayload(handler: PayloadHandler): () => void { this.payloadHandlers.add(handler); return () => this.payloadHandlers.delete(handler) }
  onFileMessage(handler: (message: RemoteFileMessage) => void): () => void { return this.fileTransfer?.onMessage(handler) ?? (() => undefined) }
  uploadFile(file: Blob, filename: string, onProgress?: (progress: UploadProgress) => void): Promise<{ filename: string; size: number; sha256: string; path?: string }> { if (!this.fileTransfer) throw new Error('File transfer channel is not open'); return this.fileTransfer.upload(file, filename, onProgress).then(result => ({ filename: result.filename, size: result.size, sha256: result.sha256, path: result.path })) }
  downloadFile(path: string, onProgress?: (progress: UploadProgress) => void): Promise<{ blob: Blob; filename: string; mimeType: string }> { if (!this.fileTransfer) throw new Error('File transfer channel is not open'); return this.fileTransfer.download(path, onProgress) }
  onHostCommand(handler: HostCommandHandler): void { this.commandHandler = handler }
  connect(): void { if (!this.closedByUser && this.state !== 'error' && this.state !== 'closed') return; this.closedByUser = false; this.retries = 0; void this.open() }
  close(): void {
    this.signalQueue = Promise.resolve()
    this.closedByUser = true; if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null
    this.teardownPeer(); this.key = null; this.setState('closed')
  }
  isAlive(): boolean { return !this.closedByUser && (this.state === 'connecting' || this.state === 'reconnecting' || this.state === 'open') }
  /** 通道是否真的可发数据：P2P HTTP 代理只认这个，不看对象存不存在。 */
  isOpen(): boolean { return this.state === 'open' }
  send(command: AgentCommand): void { if (this.options.role !== 'client') return; void this.sendEncrypted(command).catch(error => this.setState('error', { reason: safeError(error) })) }
  async sendPayload(value: unknown): Promise<void> { await this.sendEncrypted(value) }
  forceReconnect(): void { if (!this.closedByUser) { if (this.retryTimer) clearTimeout(this.retryTimer); this.retryTimer = null; this.teardownPeer(); void this.open() } }
  private async open(): Promise<void> {
    if (this.closedByUser) return
    this.teardownPeer(); this.setState(this.retries ? 'reconnecting' : 'connecting')
    try {
      if (!this.options.peerDeviceId || this.options.peerDeviceId === this.options.deviceId) throw new Error('A distinct paired peer device id is required')
      this.roomId = await deriveSignalingRoomId(this.options.sharedSecret)
      this.key = await deriveSyncKey(this.options.sharedSecret, this.roomId)
      const signalTopic = mqttSignalTopic(this.roomId)
      const authOptions: MqttSignalOptions = this.options.getBrokerAuth
        ? { url: this.options.brokerUrl, topic: signalTopic, clientId: ephemeralClientId(), auth: 'short-lived', getAuth: this.options.getBrokerAuth, onDisconnect: () => this.scheduleReconnect('MQTT signaling disconnected') }
        : { url: this.options.brokerUrl, topic: signalTopic, clientId: ephemeralClientId(), auth: 'anonymous', onDisconnect: () => this.scheduleReconnect('MQTT signaling disconnected') }
      this.signaling = new MqttSignalClient(authOptions, signal => { this.signalQueue = this.signalQueue.then(async () => { const payload = await decryptSyncFrame<RtcSignalPayload>(this.key!, signal.frame); await this.onSignal(payload) }).catch(error => { this.setState('error', { reason: safeError(error) }) }) })
      await this.signaling.connect()
      const config: RTCConfiguration = { iceServers: this.options.iceServers ?? [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] }] }
      this.pc = new RTCPeerConnection(config)
      this.pendingCandidates = []
      this.localCandidateHistory = []
      this.pendingRemoteCandidates = []
      this.seenRemoteCandidates.clear()
      this.localDescriptionPublished = false
      this.pc.onicecandidate = event => {
        if (!event.candidate) return
        const candidate = event.candidate.toJSON()
        this.localCandidateHistory.push(candidate)
        if (this.localDescriptionPublished) this.sendSignal({ type: 'ice', candidate })
        else this.pendingCandidates.push(candidate)
      }
      this.pc.onconnectionstatechange = () => {
        const status = this.pc?.connectionState
        if (status === 'connected') { this.retries = 0; this.setState('open') }
        else if (status === 'failed' || status === 'disconnected' || status === 'closed') this.scheduleReconnect(status)
      }
      if (this.options.role === 'client') {
        const channel = this.pc.createDataChannel(this.options.dataChannelLabel ?? 'coomi-engine-v1', { ordered: true })
        this.bindChannel(channel)
        const offer = await this.pc.createOffer(); await this.pc.setLocalDescription(offer)
        this.cachedOffer = this.pc.localDescription?.toJSON() ?? null
        this.localDescriptionPublished = true
        this.publishOfferAndCandidates()
        this.offerRetryTimer = setInterval(() => this.publishOfferAndCandidates(), 5000)
      } else {
        this.pc.ondatachannel = event => this.bindChannel(event.channel)
      }
    } catch (error) { this.scheduleReconnect(safeError(error)) }
  }
  private async onSignal(signal: AuthenticatedRtcSignal): Promise<void> {
    if (signal.v !== 1 || !['offer', 'answer', 'ice'].includes(signal.type) || signal.room !== this.roomId || signal.to !== this.options.deviceId || signal.from !== this.options.peerDeviceId) return
    const pc = this.pc; if (!pc) return
    try {
      if (signal.type === 'offer' && this.options.role === 'host' && signal.sdp) {
        if (pc.remoteDescription?.sdp === signal.sdp.sdp && this.cachedAnswer) { this.sendAnswerAndCandidates(); return }
        if (pc.remoteDescription) return
        await pc.setRemoteDescription(signal.sdp); await this.flushRemoteCandidates(); const answer = await pc.createAnswer(); await pc.setLocalDescription(answer); this.cachedAnswer = pc.localDescription?.toJSON() ?? null; this.localDescriptionPublished = true; this.sendAnswerAndCandidates()
      } else if (signal.type === 'answer' && this.options.role === 'client' && signal.sdp) {
        if (this.offerRetryTimer) clearInterval(this.offerRetryTimer); this.offerRetryTimer = null
        if (!pc.remoteDescription) { await pc.setRemoteDescription(signal.sdp); await this.flushRemoteCandidates() }
      } else if (signal.type === 'ice' && signal.candidate) {
        const candidateId = signal.candidate.candidate ?? ''
        if (this.seenRemoteCandidates.has(candidateId)) return
        if (pc.remoteDescription) { await pc.addIceCandidate(signal.candidate); this.seenRemoteCandidates.add(candidateId) }
        else if (this.pendingRemoteCandidates.length < 256) this.pendingRemoteCandidates.push(signal.candidate)
      }
    } catch (error) { this.setState('error', { reason: safeError(error) }) }
  }
  private publishOfferAndCandidates(): void {
    if (this.cachedOffer) this.sendSignal({ type: 'offer', sdp: this.cachedOffer })
    for (const candidate of this.localCandidateHistory) this.sendSignal({ type: 'ice', candidate })
    this.pendingCandidates = []
  }
  private sendAnswerAndCandidates(): void {
    if (this.cachedAnswer) this.sendSignal({ type: 'answer', sdp: this.cachedAnswer })
    for (const candidate of this.localCandidateHistory) this.sendSignal({ type: 'ice', candidate })
    this.pendingCandidates = []
  }
  private async flushRemoteCandidates(): Promise<void> {
    if (!this.pc?.remoteDescription) return
    const pending = this.pendingRemoteCandidates.splice(0)
    for (const candidate of pending) {
      const id = candidate.candidate ?? ''
      if (this.seenRemoteCandidates.has(id)) continue
      await this.pc.addIceCandidate(candidate); this.seenRemoteCandidates.add(id)
    }
  }
  private sendSignal(value: RtcSignalContent): void {
    if (!this.signaling) return
    const key = this.key; if (!key) return
    void encryptSyncFrame(key, { ...value, v: 1 as const, room: this.roomId, from: this.options.deviceId, to: this.options.peerDeviceId }).then(frame => {
      const signal: RtcSignal = { v: 1, frame }
      try { this.signaling?.publish(signal) } catch (error) { this.scheduleReconnect(safeError(error)) }
    }).catch(error => this.setState('error', { reason: safeError(error) }))
  }
  private bindChannel(channel: RTCDataChannel): void {
    this.fileTransfer?.close(); this.fileTransfer = null
    this.channel?.close(); this.channel = channel; channel.binaryType = 'arraybuffer'
    this.fileTransfer = new RemoteFileTransfer(this, { engineApi: this.options.engineFileApi, authorizeDownload: this.options.authorizeDownload })
    channel.onopen = () => this.setState('open')
    channel.onclose = () => { if (!this.closedByUser) this.scheduleReconnect('DataChannel closed') }
    channel.onerror = () => this.setState('error', { reason: 'DataChannel error' })
    channel.onmessage = event => void this.receiveEncrypted(event.data)
  }
  private async sendEncrypted(value: unknown): Promise<void> {
    if (!this.key || !this.channel || this.channel.readyState !== 'open') throw new Error('Remote peer is not connected')
    const frame = await encryptSyncFrame(this.key, value); this.channel.send(JSON.stringify(frame))
  }
  private async receiveEncrypted(raw: unknown): Promise<void> {
    try {
      if (!this.key) return
      const text = typeof raw === 'string' ? raw : raw instanceof ArrayBuffer ? decoder.decode(raw) : raw instanceof Blob ? await raw.text() : ''
      if (!text) return
      const frame = JSON.parse(text) as EncryptedSyncFrame; const value = await decryptSyncFrame<unknown>(this.key, frame)
      if (this.options.role === 'host' && isAgentCommand(value)) {
        const response = await this.commandHandler?.(value); if (response) await this.sendEncrypted(response); return
      }
      if (this.options.role === 'client' && isInbound(value)) { this.messageHandler?.(value); return }
      for (const handler of this.payloadHandlers) handler(value)
    } catch (error) { this.setState('error', { reason: safeError(error) }) }
  }
  private scheduleReconnect(reason: string): void {
    if (this.closedByUser || this.retryTimer) return
    this.retries += 1; const delayMs = Math.min(30000, 750 * 2 ** Math.min(this.retries - 1, 6))
    this.setState('reconnecting', { attempt: this.retries, maxRetries: 0, delayMs, reason })
    this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.open() }, delayMs)
  }
  private teardownPeer(): void {
    this.signaling?.close(); this.signaling = null
    if (this.offerRetryTimer) clearInterval(this.offerRetryTimer); this.offerRetryTimer = null
    this.fileTransfer?.close(); this.fileTransfer = null
    if (this.channel) { this.channel.onclose = null; this.channel.close(); this.channel = null }
    if (this.pc) { this.pc.onconnectionstatechange = null; this.pc.onicecandidate = null; this.pc.ondatachannel = null; this.pc.close(); this.pc = null }
    this.cachedOffer = null; this.cachedAnswer = null; this.pendingCandidates = []; this.localCandidateHistory = []; this.pendingRemoteCandidates = []; this.seenRemoteCandidates.clear(); this.localDescriptionPublished = false
  }
  private setState(state: ConnectionState, detail: Omit<ConnectionStatus, 'state'> = {}): void { this.state = state; this.statusHandler?.({ state, ...detail }) }
}
function safeError(error: unknown): string { return error instanceof Error ? error.message : 'Remote sync failed' }

/** Broker-free smoke test for two local browser peers and encrypted DataChannel frames. */
export async function runLocalPeerSmokeTest(timeoutMs = 10000): Promise<{ connected: true; encryptedRoundTrip: true }> {
  const left = new RTCPeerConnection({ iceServers: [] })
  const right = new RTCPeerConnection({ iceServers: [] })
  const leftKey = await deriveSyncKey('local-smoke-shared-secret-32-bytes', 'local-smoke-room')
  const rightKey = await deriveSyncKey('local-smoke-shared-secret-32-bytes', 'local-smoke-room')
  const channel = left.createDataChannel('coomi-smoke', { ordered: true })
  const remoteChannels: RTCDataChannel[] = []
  right.ondatachannel = event => { remoteChannels.push(event.channel) }
  const gatherCandidates = async (peer: RTCPeerConnection) => {
    if (peer.iceGatheringState === 'complete') return
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { peer.removeEventListener('icegatheringstatechange', check); reject(new Error('Local ICE gathering timed out')) }, timeoutMs)
      const check = () => { if (peer.iceGatheringState === 'complete') { clearTimeout(timer); peer.removeEventListener('icegatheringstatechange', check); resolve() } }
      peer.addEventListener('icegatheringstatechange', check)
    })
  }
  const connected = new Promise<RTCDataChannel>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Local WebRTC smoke test timed out')), timeoutMs)
    const check = () => { if (channel.readyState === 'open' && remoteChannels[0]?.readyState === 'open') { clearTimeout(timer); resolve(remoteChannels[0]) } }
    channel.onopen = check
    const assign = () => { if (remoteChannels[0]) remoteChannels[0].onopen = check; check() }
    const interval = setInterval(() => { assign(); if (channel.readyState === 'open' && remoteChannels[0]?.readyState === 'open') clearInterval(interval) }, 10)
  })
  try {
    await left.setLocalDescription(await left.createOffer())
    await gatherCandidates(left)
    await right.setRemoteDescription(left.localDescription!)
    await right.setLocalDescription(await right.createAnswer())
    await gatherCandidates(right)
    await left.setRemoteDescription(right.localDescription!)
    const receivingChannel = await connected
    const payload = { type: 'smoke_command', command: 'ping', value: 'ciphertext-only' }
    const roundTrip = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Encrypted DataChannel smoke test timed out')), timeoutMs)
      receivingChannel.onmessage = event => {
        clearTimeout(timer)
        void decryptSyncFrame(leftKey, JSON.parse(String(event.data)) as EncryptedSyncFrame).then(resolve, reject)
      }
    })
    channel.send(JSON.stringify(await encryptSyncFrame(rightKey, payload)))
    const received = await roundTrip
    if (JSON.stringify(received) !== JSON.stringify(payload)) throw new Error('Encrypted DataChannel payload did not round-trip')
    return { connected: true, encryptedRoundTrip: true }
  } finally { channel.close(); remoteChannels[0]?.close(); left.close(); right.close() }
}

export interface RemoteEngineProxyOptions extends Omit<RemoteSyncOptions, 'role'> {
  engineSend: (command: RemoteEngineCommand) => boolean
  subscribeEngineEnvelope: (handler: (envelope: InboundEnvelope) => void) => () => void
}
/** Injected desktop host adapter; no IPC command names are assumed here. */
export class RemoteEngineProxy {
  readonly transport: RemoteSyncTransport
  private unsubscribeEngine: (() => void) | null = null
  private connected = false
  constructor(private readonly options: RemoteEngineProxyOptions) {
    this.transport = new RemoteSyncTransport({ ...options, role: 'host', engineFileApi: options.engineFileApi, authorizeDownload: options.authorizeDownload })
    this.transport.onHostCommand(command => { if (!options.engineSend(command)) throw new Error('Desktop engine rejected remote command'); return undefined })
  }
  connect(): void {
    if (this.connected) return
    this.connected = true
    this.unsubscribeEngine = this.options.subscribeEngineEnvelope(envelope => this.publishEngineEnvelope(envelope))
    this.transport.connect()
  }
  close(): void {
    if (!this.connected) return
    this.connected = false
    this.unsubscribeEngine?.(); this.unsubscribeEngine = null
    this.transport.close()
  }
  publishEngineEnvelope(envelope: InboundEnvelope): Promise<void> { return this.transport.sendPayload(envelope) }
  uploadFile(file: Blob, filename: string, onProgress?: (progress: UploadProgress) => void) { return this.transport.uploadFile(file, filename, onProgress) }
  downloadFile(path: string, onProgress?: (progress: UploadProgress) => void) { return this.transport.downloadFile(path, onProgress) }
  onFileMessage(handler: (message: RemoteFileMessage) => void): () => void { return this.transport.onFileMessage(handler) }
  onStateChange(handler: (status: ConnectionStatus) => void): void { this.transport.onStateChange(handler) }
}

/** Build the client transport from a paired desktop QR record. The pairing bearer stays local. */
export function createRemoteTransportFromDevice(device: PairedDevice, config: RemotePeerTransportConfig): RemoteSyncTransport {
  const sharedSecret = device.p2pSecretHash?.trim()
  if (!sharedSecret) throw new Error('Paired P2P secret hash is required')
  if (!isBrokerUrlAllowed(config.brokerUrl)) throw new Error('P2P signaling requires a TLS WebSocket broker (or a private ws:// one)')
  return new RemoteSyncTransport({
    brokerUrl: config.brokerUrl,
    deviceId: device.peerId ?? config.localDeviceId,
    peerDeviceId: device.id,
    sharedSecret,
    role: 'client',
    iceServers: config.iceServers,
  })
}

