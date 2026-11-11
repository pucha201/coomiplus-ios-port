import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fake = vi.hoisted(() => {
  class FakeMqttClient {
    static instances: FakeMqttClient[] = []
    connected = false
    closed = false
    readonly publishes: Array<Record<string, unknown>> = []
    private readonly handler: (value: unknown) => void
    private readonly options: { onDisconnect?: () => void }
    constructor(options: { onDisconnect?: () => void }, handler: (value: unknown) => void) {
      this.options = options
      this.handler = handler
      FakeMqttClient.instances.push(this)
    }
    async connect(): Promise<void> { this.connected = true }
    publishRaw(value: unknown): void {
      if (!this.connected) throw new Error('not connected')
      this.publishes.push(value as Record<string, unknown>)
    }
    close(): void { this.closed = true; this.connected = false }
    deliver(value: unknown): void { this.handler(value) }
    drop(): void { this.connected = false; this.options.onDisconnect?.() }
    static reset(): void { FakeMqttClient.instances.length = 0 }
  }
  return { FakeMqttClient }
})

vi.mock('../src/bridge/mqttSignaling', () => ({ MqttSignalClient: fake.FakeMqttClient }))

import { MqttRelayTransport } from '../src/bridge/mqttRelay'

function relay(role: 'host' | 'client'): MqttRelayTransport {
  return new MqttRelayTransport({
    brokerUrl: 'wss://broker.example/mqtt',
    roomId: 'a'.repeat(64),
    localId: role === 'host' ? 'host-1' : 'phone-1',
    peerId: role === 'host' ? 'phone-1' : 'host-1',
    sharedSecret: 'b'.repeat(64),
    role,
  })
}

function frame(value: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, kind: 'relay', from: 'phone-1', to: 'host-1', ...value }
}

/** WebCrypto 的 promise 走线程池，假定时器管不到：交替推进定时器与真实事件循环等它落地。 */
async function settle(instances: unknown[], count = 1): Promise<void> {
  for (let i = 0; i < 40 && instances.length < count; i += 1) {
    await vi.advanceTimersByTimeAsync(25)
    await new Promise(resolve => setImmediate(resolve))
  }
}

describe('MQTT relay liveness', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] })
    fake.FakeMqttClient.reset()
  })
  afterEach(() => { vi.useRealTimers() })

  it('keeps the host on the broker while the phone is away', async () => {
    const host = relay('host')
    const states: string[] = []
    host.onStateChange(status => states.push(status.state))
    host.connect()
    await settle(fake.FakeMqttClient.instances)
    await vi.advanceTimersByTimeAsync(60_000)

    // 电脑端不能因为「手机还没来」就断开 broker：以前的 6 秒超时会让宿主大半时间不在线。
    expect(fake.FakeMqttClient.instances).toHaveLength(1)
    const client = fake.FakeMqttClient.instances[0]
    expect(client.closed).toBe(false)
    expect(client.connected).toBe(true)
    expect(states).not.toContain('reconnecting')
    expect(states).not.toContain('error')
    // 对端没出现就不能谎报 open，但探测 ping 要持续发。
    expect(host.isOpen()).toBe(false)
    expect(client.publishes.filter(item => typeof item.ping === 'number').length).toBeGreaterThanOrEqual(10)
    host.close()
  })

  it('opens on peer evidence and survives a heartbeat gap without dropping the broker', async () => {
    const host = relay('host')
    host.connect()
    await settle(fake.FakeMqttClient.instances)
    const client = fake.FakeMqttClient.instances[0]

    client.deliver(frame({ pong: 1 }))
    expect(host.isOpen()).toBe(true)

    await vi.advanceTimersByTimeAsync(16_000)
    expect(host.isOpen()).toBe(false)
    expect(client.closed).toBe(false)
    expect(fake.FakeMqttClient.instances).toHaveLength(1)

    client.deliver(frame({ ping: 2 }))
    expect(host.isOpen()).toBe(true)
    expect(fake.FakeMqttClient.instances).toHaveLength(1)
    host.close()
  })

  it('reports peer absence once the broker is up instead of staying silent', async () => {
    const host = relay('host')
    const reasons: string[] = []
    host.onStateChange(status => { if (status.reason) reasons.push(status.reason) })
    host.connect()
    await settle(fake.FakeMqttClient.instances)
    await vi.advanceTimersByTimeAsync(9_000)

    // 以前对端缺席时状态永远停在「正在尝试」且不给原因，用户看不出该去看哪一端。
    expect(host.isOpen()).toBe(false)
    expect(reasons.filter(reason => reason === 'relay peer absent')).toHaveLength(1)
    host.close()
  })

  it('reconnects to the broker after the socket drops', async () => {
    const host = relay('host')
    host.connect()
    await settle(fake.FakeMqttClient.instances)
    fake.FakeMqttClient.instances[0].drop()
    await vi.advanceTimersByTimeAsync(2_000)
    await settle(fake.FakeMqttClient.instances, 2)

    expect(fake.FakeMqttClient.instances).toHaveLength(2)
    expect(fake.FakeMqttClient.instances[1].connected).toBe(true)
    host.close()
  })
})
