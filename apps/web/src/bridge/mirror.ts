import type { MirrorEvent, MirrorHello, MirrorMessage } from '@/protocol/remote'

export interface MirrorClientOptions { url: string; deviceId: string; sessionId?: string; token?: string; files?: boolean }
export type MirrorState = 'idle' | 'connecting' | 'open' | 'closed' | 'error'

/** One-way event mirror. It deliberately has no command-send API. */
export class MirrorClient {
  private socket: WebSocket | null = null
  private seq = 0
  private readonly options: MirrorClientOptions
  private stateHandler?: (state: MirrorState) => void
  private eventHandler?: (event: MirrorEvent) => void
  constructor(options: MirrorClientOptions) { this.options = options }
  connect(): void {
    this.close(); this.emit('connecting')
    try { this.socket = new WebSocket(this.withToken(this.options.url)) } catch { this.emit('error'); return }
    this.socket.onopen = () => {
      this.emit('open')
      const hello: MirrorHello = { type: 'mirror_hello', version: 1, deviceId: this.options.deviceId, sessionId: this.options.sessionId, capabilities: { events: true, commands: false, files: this.options.files ?? false } }
      this.socket?.send(JSON.stringify(hello))
    }
    this.socket.onmessage = event => {
      try { const message = JSON.parse(String(event.data)) as MirrorMessage; if (message.type === 'mirror_event') { this.seq = Math.max(this.seq, message.seq); this.eventHandler?.(message); this.socket?.send(JSON.stringify({ type: 'mirror_ack', version: 1, seq: message.seq })) } } catch { /* malformed mirror frames are ignored */ }
    }
    this.socket.onerror = () => this.emit('error')
    this.socket.onclose = () => { this.socket = null; this.emit('closed') }
  }
  close(): void { if (this.socket) { this.socket.onclose = null; this.socket.close(); this.socket = null }; if (this.socket === null) this.emit('closed') }
  onStateChange(handler: (state: MirrorState) => void): void { this.stateHandler = handler }
  onEvent(handler: (event: MirrorEvent) => void): void { this.eventHandler = handler }
  lastSequence(): number { return this.seq }
  private emit(state: MirrorState): void { this.stateHandler?.(state) }
  private withToken(url: string): string {
    if (!this.options.token) return url
    const target = new URL(url, typeof location !== 'undefined' ? location.href : undefined)
    target.searchParams.set('token', this.options.token)
    return target.toString()
  }
}
