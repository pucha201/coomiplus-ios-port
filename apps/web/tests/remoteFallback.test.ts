import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTransport } from '../src/bridge/index'
import type { Transport } from '../src/bridge/transport'

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

function makeTransport(): Transport {
  return createTransport('session-1')
}

function connectionState(transport: Transport): string | undefined {
  return (transport as Transport & { connectionStatus?: () => { state: string } }).connectionStatus?.().state
}

describe('RemoteFallbackTransport recovery', () => {
  const openTransports: Transport[] = []

  beforeEach(() => {
    const localStorage = storage()
    localStorage.setItem('coomi.connectionMode', 'cloud')
    localStorage.setItem('coomi.deviceId', 'desktop-1')
    localStorage.setItem('coomi.pairedDevices', JSON.stringify(devices))
    vi.stubGlobal('localStorage', localStorage)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('location', { protocol: 'https:', host: 'phone.local', search: '', hash: '' })
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
  })

  afterEach(() => {
    for (const transport of openTransports.splice(0)) transport.close()
    vi.unstubAllGlobals()
  })

  it('leaves open and starts relay recovery when an established WebRTC channel disconnects', () => {
    const transport = makeTransport()
    openTransports.push(transport)
    const internal = transport as any
    const statuses: string[] = []
    transport.onStateChange(status => statuses.push(status.state))

    internal.remote.statusHandler({ state: 'open' })
    expect(connectionState(transport)).toBe('open')

    internal.remote.statusHandler({ state: 'reconnecting', reason: 'DataChannel closed' })

    expect(internal.phase).toBe('relay')
    expect(statuses.at(-1)).toBe('connecting')
    expect(connectionState(transport)).not.toBe('open')
  })

  it('does not treat an unauthenticated LAN 401 as a usable channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 401 })))
    const transport = makeTransport()
    openTransports.push(transport)
    const internal = transport as any

    await internal.preferLan()

    expect(internal.fallback).toBeNull()
    expect(internal.finished).toBe(false)
  })

  it('reports the real LAN state instead of open merely because a fallback exists', () => {
    const transport = makeTransport()
    openTransports.push(transport)
    const internal = transport as any
    internal.fallback = { isAlive: () => false, close: () => undefined }
    internal.lanState = 'reconnecting'

    expect(connectionState(transport)).toBe('reconnecting')
  })

  it('queues commands sent before any channel is open and flushes them on open', () => {
    const transport = makeTransport()
    openTransports.push(transport)
    const internal = transport as any
    const sent: string[] = []
    internal.remote.isOpen = () => false
    internal.remote.send = (command: { command: string }) => sent.push(command.command)

    transport.send({ command: 'send_message', text: 'hi' } as never)

    expect(sent).toEqual([])

    internal.remote.isOpen = () => true
    internal.remote.statusHandler({ state: 'open' })

    expect(sent).toEqual(['send_message'])
  })

  it('routes file transfers to the channel that is actually carrying the session', async () => {
    const transport = makeTransport()
    openTransports.push(transport)
    const internal = transport as any
    const routed: string[] = []
    internal.remote = { uploadFile: async () => { routed.push('p2p'); return { filename: 'a.txt', size: 1, sha256: 'x' } }, close: () => undefined }
    internal.relay = { uploadFile: async () => { routed.push('relay'); return { filename: 'a.txt', size: 1, sha256: 'x' } }, close: () => undefined }

    internal.relayOpen = true
    await (transport as any).uploadFile(new Blob(['a']), 'a.txt')
    internal.relayOpen = false
    internal.p2pOpen = true
    await (transport as any).uploadFile(new Blob(['a']), 'a.txt')

    expect(routed).toEqual(['relay', 'p2p'])
  })
})
