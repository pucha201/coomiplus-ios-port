import { describe, expect, it, vi } from 'vitest'
import { installP2PHttpHost } from '../src/bridge/p2pHttp'
import { MqttRelayTransport } from '../src/bridge/mqttRelay'

function relay(): MqttRelayTransport {
  return new MqttRelayTransport({
    brokerUrl: 'wss://broker.invalid/mqtt',
    roomId: 'a'.repeat(64),
    localId: 'desktop-1',
    peerId: 'phone-1',
    sharedSecret: 'b'.repeat(64),
    role: 'host',
  })
}

/** 内部投递：绕过加密层，只验证「同一条中转通道能同时挂多个载荷订阅者」。 */
function deliver(transport: MqttRelayTransport, value: unknown): void {
  const internal = transport as unknown as { notifyPayload(value: unknown): void }
  internal.notifyPayload(value)
}

describe('relay payload fan-out', () => {
  it('delivers one frame to every registered payload consumer', () => {
    const transport = relay()
    const fileHandler = vi.fn()
    const issued = vi.fn(async () => ({ status: 200, headers: {}, body: '' }))

    transport.onPayload(fileHandler)
    installP2PHttpHost(transport, issued)
    deliver(transport, { kind: 'http:req', id: 'r1', method: 'GET', path: '/api/runtime/health', headers: {} })
    deliver(transport, { type: 'file_upload_start', transferId: 't1' })

    expect(issued).toHaveBeenCalledTimes(1)
    expect(fileHandler).toHaveBeenCalledTimes(2)
  })

  it('keeps the file consumer alive when a later consumer unsubscribes', () => {
    const transport = relay()
    const fileHandler = vi.fn()
    transport.onPayload(fileHandler)
    const releaseHttp = installP2PHttpHost(transport, async () => ({ status: 200, headers: {}, body: '' }))

    releaseHttp()
    deliver(transport, { type: 'file_upload_start', transferId: 't1' })

    expect(fileHandler).toHaveBeenCalledTimes(1)
  })
})
