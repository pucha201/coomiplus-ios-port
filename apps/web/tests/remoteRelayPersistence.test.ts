import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../src/bridge/index'
import type { Transport } from '../src/bridge/transport'

const fake = vi.hoisted(() => {
  class FakeRelay {
    static instances: FakeRelay[] = []
    readonly options: Record<string, unknown>
    closed = false
    connected = false
    open = false
    private messageHandler?: (value: unknown) => void
    private stateHandler?: (value: { state: string; reason?: string }) => void
    constructor(options: Record<string, unknown>) {
      this.options = options
      FakeRelay.instances.push(this)
    }
    onMessage(handler: (value: unknown) => void): void { this.messageHandler = handler }
    onStateChange(handler: (value: { state: string; reason?: string }) => void): void { this.stateHandler = handler }
    onHostCommand(): void { /* client side only */ }
    onPayload(): () => void { return () => undefined }
    connect(): void { this.connected = true }
    close(): void { this.closed = true; this.connected = false; this.open = false }
    isOpen(): boolean { return this.open && !this.closed }
    isAlive(): boolean { return !this.closed && (this.connected || this.open) }
    async sendPayload(): Promise<void> { /* not exercised here */ }
    emit(state: string, reason?: string): void { this.open = state === 'open'; this.stateHandler?.({ state, reason }) }
    deliver(value: unknown): void { this.messageHandler?.(value) }
    static reset(): void { FakeRelay.instances.length = 0 }
  }
  return { FakeRelay }
})

vi.mock('../src/bridge/mqttRelay', () => ({ MqttRelayTransport: fake.FakeRelay }))

const devices = [{
  id: 'desktop-1', peerId: 'phone-1', name: 'Desktop', kind: 'desktop',
  engineBase: 'http://192.168.1.20:8787', pairingSecret: 'pair-token',
  p2pSecretHash: 'a'.repeat(64), reachability: 'online', createdAt: 1, updatedAt: 1,
}]

function storage(): Storage {
  const values = new Map<string, string>()
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

class FakeSocket {
  static readonly OPEN = 1
  readyState = 0
  constructor(public readonly url: string) {}
  close(): void { this.readyState = 3 }
  send(): void { /* ignore */ }
  addEventListener(): void { /* ignore */ }
}

/** WebCrypto 的 promise 走线程池，假定时器管不到：交替推进定时器与真实事件循环等它落地。 */
async function settle(instances: unknown[], count = 1): Promise<void> {
  for (let i = 0; i < 40 && instances.length < count; i += 1) {
    await vi.advanceTimersByTimeAsync(25)
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('remote relay persistence', () => {
  const openTransports: Transport[] = []

  beforeEach(() => {
    const localStorage = storage()
    localStorage.setItem('coomi.connectionMode', 'cloud')
    localStorage.setItem('coomi.deviceId', 'desktop-1')
    localStorage.setItem('coomi.pairedDevices', JSON.stringify(devices))
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('location', { protocol: 'https:', host: 'phone.local', search: '', hash: '' })
    vi.stubGlobal('WebSocket', FakeSocket)
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('LAN unreachable') }))
    fake.FakeRelay.reset()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
  })

  afterEach(() => {
    for (const transport of openTransports.splice(0)) transport.close()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function cloudTransport(): any {
    const transport = createTransport('session-1')
    openTransports.push(transport)
    return transport
  }

  it('keeps the encrypted relay alive when the LAN is unreachable', async () => {
    const transport = cloudTransport()
    transport.lanProbe = 'unreachable'
    transport.startRelay('session-1', 'P2P connection timed out')
    await settle(fake.FakeRelay.instances)

    expect(fake.FakeRelay.instances).toHaveLength(1)
    const relay = fake.FakeRelay.instances[0]

    // 超过旧版 8 秒中止点很久：跨网络时不能放弃中转去连必然不可达的 LAN。
    await vi.advanceTimersByTimeAsync(120_000)
    expect(transport.fallback).toBeNull()
    expect(transport.relay).toBe(relay)
    expect(relay.closed).toBe(false)
    expect(fake.FakeRelay.instances).toHaveLength(1)
  })

  it('still switches to LAN once the paired desktop is actually reachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 200 })))
    const transport = cloudTransport()
    transport.lanProbe = 'unreachable'
    transport.startRelay('session-1', 'P2P connection timed out')
    await settle(fake.FakeRelay.instances)
    await vi.advanceTimersByTimeAsync(21_000)

    expect(transport.fallback).not.toBeNull()
    expect(transport.relay).toBeNull()
    expect(fake.FakeRelay.instances[0].closed).toBe(true)
  })

  it('keeps the relay object when the peer drops after it was open', async () => {
    const transport = cloudTransport()
    transport.startRelay('session-1', 'P2P connection timed out')
    await settle(fake.FakeRelay.instances)
    const relay = fake.FakeRelay.instances[0]
    relay.emit('open')
    expect(transport.relayOpen).toBe(true)

    relay.emit('reconnecting', 'relay peer heartbeat lost')

    expect(transport.relay).toBe(relay)
    expect(relay.closed).toBe(false)
    expect(transport.connectionStatus()).toEqual({ state: 'reconnecting', reason: 'relay peer heartbeat lost' })

    relay.emit('open')
    expect(transport.connectionStatus().state).toBe('open')
  })
})
