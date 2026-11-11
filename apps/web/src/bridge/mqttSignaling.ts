import type { RtcSignal } from '../protocol/remote'

type PacketHandler = (signal: RtcSignal) => void
export interface BrokerAuth { username: string; password: string; expiresAt: number; authorizedTopic: string }
export type BrokerAuthProvider = () => Promise<BrokerAuth>
export type MqttSignalOptions = { url: string; topic: string; publishTopic?: string; clientId: string; onDisconnect?: () => void } & ({ auth: 'anonymous' } | { auth: 'short-lived'; getAuth: BrokerAuthProvider })

const encoder = new TextEncoder()
const decoder = new TextDecoder()

function encodeRemainingLength(value: number): number[] {
  const bytes: number[] = []
  do { let digit = value % 128; value = Math.floor(value / 128); if (value > 0) digit |= 0x80; bytes.push(digit) } while (value > 0)
  return bytes
}
function encodeString(value: string): number[] { const data = encoder.encode(value); return [(data.length >> 8) & 255, data.length & 255, ...data] }
function packet(header: number, body: number[]): Uint8Array { return new Uint8Array([header, ...encodeRemainingLength(body.length), ...body]) }
function readRemainingLength(bytes: Uint8Array, offset: number): { length: number; next: number } | null {
  let multiplier = 1, length = 0, cursor = offset
  for (let i = 0; i < 4 && cursor < bytes.length; i++) { const digit = bytes[cursor++]; length += (digit & 127) * multiplier; if (!(digit & 128)) return { length, next: cursor }; multiplier *= 128 }
  return null
}
function readString(bytes: Uint8Array, offset: number): { value: string; next: number } | null {
  if (offset + 2 > bytes.length) return null
  const length = (bytes[offset] << 8) | bytes[offset + 1]; const end = offset + 2 + length
  if (end > bytes.length) return null
  return { value: decoder.decode(bytes.subarray(offset + 2, end)), next: end }
}

/** MQTT 3.1.1 QoS 0 SDP/ICE signaling over TLS WebSocket with topic-scoped short-lived auth. */
export class MqttSignalClient {
  private socket: WebSocket | null = null
  private readonly clientId: string
  private readonly topic: string
  private readonly publishTopic: string
  private readonly handler: PacketHandler
  private readonly options: MqttSignalOptions
  private wasConnected = false
  private username = ''
  private password = ''
  private readonly onDisconnect?: () => void
  private packetId = 1
  private connected = false
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private keepAliveTimer: ReturnType<typeof setInterval> | null = null
  private credentialExpiryTimer: ReturnType<typeof setTimeout> | null = null
  constructor(options: MqttSignalOptions, handler: PacketHandler) {
    const broker = new URL(options.url)
    if (broker.protocol !== 'wss:' || broker.username || broker.password || broker.search || broker.hash) throw new Error('MQTT signaling requires a credential-free WSS URL')
    if (!options.topic || !options.clientId) throw new Error('MQTT topic and client id are required')
    if (options.auth === 'anonymous' && (!options.clientId || options.clientId.length < 16)) throw new Error('Anonymous broker signaling requires a random ephemeral client id')
    this.options = options; this.topic = options.topic; this.publishTopic = options.publishTopic || options.topic; this.clientId = options.clientId; this.handler = handler; this.onDisconnect = options.onDisconnect
  }
  async connect(): Promise<void> {
    if (this.options.auth === 'short-lived') {
      const auth = await this.options.getAuth()
      if (!auth.username || !auth.password || auth.authorizedTopic !== this.topic || auth.expiresAt <= Date.now() || auth.expiresAt > Date.now() + 15 * 60_000) throw new Error('MQTT signaling requires valid topic-scoped short-lived credentials')
      this.username = auth.username; this.password = auth.password
      this.credentialExpiryTimer = setTimeout(() => this.socket?.close(), auth.expiresAt - Date.now())
    }
    this.wasConnected = false
    return new Promise((resolve, reject) => {
      try { this.socket = new WebSocket(this.options.url, ['mqtt']) } catch (error) { reject(error); return }
      const socket = this.socket; socket.binaryType = 'arraybuffer'
      this.connectTimer = setTimeout(() => { socket.close(); reject(new Error('MQTT broker connection timed out')) }, 10000)
      socket.onopen = () => {
        const hasCredentials = this.options.auth === 'short-lived'
        const connectFlags = 0x02 | (hasCredentials ? 0xc0 : 0)
        const body = [...encodeString('MQTT'), 4, connectFlags, 0, 30, ...encodeString(this.clientId), ...(hasCredentials ? [...encodeString(this.username), ...encodeString(this.password)] : [])]
        socket.send(packet(0x10, body))
      }
      socket.onmessage = event => {
        const parse = (data: Uint8Array) => this.handlePacket(data, resolve, reject)
        if (event.data instanceof ArrayBuffer) parse(new Uint8Array(event.data))
        else if (event.data instanceof Blob) void event.data.arrayBuffer().then(buffer => parse(new Uint8Array(buffer)))
      }
      socket.onerror = () => { if (!this.connected) reject(new Error('MQTT broker WebSocket failed')) }
      socket.onclose = () => { const notify = this.wasConnected; this.connected = false; this.wasConnected = false; if (this.connectTimer) clearTimeout(this.connectTimer); if (this.keepAliveTimer) clearInterval(this.keepAliveTimer); if (this.credentialExpiryTimer) clearTimeout(this.credentialExpiryTimer); this.connectTimer = null; this.keepAliveTimer = null; this.credentialExpiryTimer = null; if (notify) this.onDisconnect?.() }
    })
  }
  publish(signal: RtcSignal): void { this.publishRaw(signal) }

  /** 发布任意 JSON 负载到 publishTopic（中转通道复用同一连接）。 */
  publishRaw(value: unknown): void {
    if (!this.connected || this.socket?.readyState !== WebSocket.OPEN) throw new Error('MQTT signaling is not connected')
    const body = encoder.encode(JSON.stringify(value)); const topic = encodeString(this.publishTopic)
    this.socket.send(packet(0x30, [...topic, ...body]))
  }
  close(): void { if (this.connectTimer) clearTimeout(this.connectTimer); if (this.keepAliveTimer) clearInterval(this.keepAliveTimer); if (this.credentialExpiryTimer) clearTimeout(this.credentialExpiryTimer); this.connectTimer = null; this.keepAliveTimer = null; this.credentialExpiryTimer = null; this.connected = false; this.wasConnected = false; this.socket?.close(); this.socket = null }
  private handlePacket(bytes: Uint8Array, resolve: () => void, reject: (error: Error) => void): void {
    if (!bytes.length) return
    const decoded = readRemainingLength(bytes, 1); if (!decoded || decoded.next + decoded.length > bytes.length) return
    const type = bytes[0] >> 4, body = bytes.subarray(decoded.next, decoded.next + decoded.length)
    if (type === 2) {
      if (body.length < 2 || body[1] !== 0) { reject(new Error('MQTT broker rejected signaling connection')); return }
      this.connected = true; this.wasConnected = true; const id = this.nextPacketId()
      this.socket?.send(packet(0x82, [(id >> 8) & 255, id & 255, ...encodeString(this.topic), 0]))
      return
    }
    if (type === 9) {
      if (!body.length || body[body.length - 1] === 0x80) { reject(new Error('MQTT signaling subscription rejected')); return }
      if (this.connectTimer) clearTimeout(this.connectTimer); this.connectTimer = null; this.keepAliveTimer = setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(packet(0xc0, [])) }, 15000); resolve(); return
    }
    if (type === 3) {
      const topic = readString(body, 0); if (!topic || topic.value !== this.topic) return
      try { const signal = JSON.parse(decoder.decode(body.subarray(topic.next))) as RtcSignal; if (signal?.v === 1) this.handler(signal) } catch { /* Ignore malformed signaling frame. */ }
    }
    if (type === 13) return
  }
  private nextPacketId(): number { this.packetId = (this.packetId % 65535) + 1; return this.packetId }
}

export function mqttSignalTopic(room: string): string {
  const cleanRoom = room.trim()
  if (!/^[a-f0-9]{32,96}$/i.test(cleanRoom)) throw new Error('Signaling room must be an opaque hex identifier')
  return 'coomi-sync/v1/' + cleanRoom + '/signal'
}
