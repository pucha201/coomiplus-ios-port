import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 云端模式的 HTTP 绝不能落回手机同源：那里站着的是本地引擎，
 * 用户看到的「云端会话」其实是从本机读出来的，切不切设备都一样。
 */

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  }
}

interface HttpChannel {
  sent: unknown[]
  isOpen(): boolean
  sendPayload(value: unknown): Promise<void>
  onPayload(handler: (value: unknown) => void): () => void
}

function makeChannel(open: boolean): HttpChannel {
  let handler: ((value: unknown) => void) | null = null
  const sent: unknown[] = []
  return {
    sent,
    isOpen: () => open,
    async sendPayload(value) {
      sent.push(value)
      const request = value as { id?: string }
      handler?.({ kind: 'http:res', id: request.id, status: 200, headers: { 'content-type': 'application/json' }, body: '{"via":"p2p"}' })
    },
    onPayload(next) { handler = next; return () => { handler = null } },
  }
}

/** 每次都要成对取：http.ts 内部 import 的就是这一份 p2pHttp 模块状态。 */
async function loadBridge() {
  vi.resetModules()
  const http = await import('../src/bridge/http')
  const p2p = await import('../src/bridge/p2pHttp')
  return { http, p2p }
}

describe('cloud mode HTTP isolation', () => {
  const fetchSpy = vi.fn(async () => new Response('{"via":"local"}', { status: 200 }))
  let bridge: { http: typeof import('../src/bridge/http'), p2p: typeof import('../src/bridge/p2pHttp') } | null = null

  beforeEach(() => {
    fetchSpy.mockClear()
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage() }))
    vi.stubGlobal('localStorage', storage({ 'coomi.connectionMode': 'cloud', 'coomi.deviceId': 'desktop-1' }))
  })

  afterEach(() => {
    bridge?.p2p.setP2PChannel(null)
    bridge = null
    vi.unstubAllGlobals()
  })

  it('proxies cloud API calls over the encrypted channel even without a saved engine base', async () => {
    bridge = await loadBridge()
    const channel = makeChannel(true)
    bridge.p2p.setP2PChannel(channel)

    const response = await bridge.http.authedFetch('/api/sessions')

    expect(await response.json()).toEqual({ via: 'p2p' })
    expect(channel.sent).toHaveLength(1)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('refuses to read the phone-local engine when the cloud has no channel', async () => {
    bridge = await loadBridge()

    await expect(bridge.http.authedFetch('/api/sessions')).rejects.toThrow(/电脑/)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('keeps local mode on the same-origin engine', async () => {
    vi.stubGlobal('localStorage', storage({ 'coomi.connectionMode': 'local' }))
    bridge = await loadBridge()

    const response = await bridge.http.authedFetch('/api/sessions')

    expect(response.status).toBe(200)
    expect(fetchSpy).toHaveBeenCalledWith('/api/sessions', expect.anything())
  })

  it('uses the selected paired device address when the top-level base key is missing', async () => {
    vi.stubGlobal('localStorage', storage({
      'coomi.connectionMode': 'cloud',
      'coomi.deviceId': 'desktop-1',
      'coomi.pairedDevices': JSON.stringify([{ id: 'desktop-1', name: 'Desktop', engineBase: 'http://192.168.1.20:8787/' }]),
    }))
    bridge = await loadBridge()

    await bridge.http.authedFetch('/api/sessions')

    expect(fetchSpy).toHaveBeenCalledWith('http://192.168.1.20:8787/api/sessions', expect.anything())
  })

  it('signs cloud requests with the selected device pairing secret', async () => {
    vi.stubGlobal('localStorage', storage({
      'coomi.connectionMode': 'cloud',
      'coomi.deviceId': 'desktop-1',
      'coomi.pairedDevices': JSON.stringify([{ id: 'desktop-1', engineBase: 'http://192.168.1.20:8787', pairingSecret: 'pair-token' }]),
    }))
    bridge = await loadBridge()

    await bridge.http.authedFetch('/api/sessions')

    const init = fetchSpy.mock.calls[0][1] as RequestInit
    expect(new Headers(init.headers).get('Authorization')).toBe('Bearer pair-token')
  })
})
