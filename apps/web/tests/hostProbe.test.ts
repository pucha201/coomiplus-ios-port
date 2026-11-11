import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 后台探活只回答「电脑有没有应答」。它不许改设备在线状态（蜂窝网下必然无应答，
 * 标成离线会把冷启动自动连接打死），也不许把 401 说成「电脑没开」。
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

const DEVICE = {
  id: 'pc-1',
  name: 'PC',
  kind: 'desktop',
  engineBase: 'http://192.168.1.10:8787',
  engineToken: 'pair-token',
  reachability: 'online',
  createdAt: 1,
  updatedAt: 1,
}

async function loadDeviceStore() {
  vi.resetModules()
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useDeviceStore } = await import('@/stores/device')
  return useDeviceStore()
}

describe('云端探活', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    // 设备 store 牵出会话 store → 路由：node 里没有 location，不补就加载不了。
    const location = { protocol: 'http:', href: 'http://localhost/', pathname: '/', search: '', hash: '#/', origin: 'http://localhost', host: 'localhost' }
    const history = { state: null, replaceState: () => {}, pushState: () => {} }
    const document = {
      querySelector: () => null,
      getElementById: () => null,
      createElement: () => ({ content: {}, style: {}, setAttribute: () => {}, appendChild: () => {} }),
      createTextNode: () => ({}),
      documentElement: { style: { setProperty: () => {} }, dataset: {}, setAttribute: () => {}, getAttribute: () => null },
      addEventListener: () => {},
      removeEventListener: () => {},
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
    }
    vi.stubGlobal('document', document)
    // vue-router 读的是 window.location：全局和 window 桩都得给。
    vi.stubGlobal('location', location)
    vi.stubGlobal('history', history)
    vi.stubGlobal('window', Object.assign(new EventTarget(), { localStorage: storage(), matchMedia: undefined, location, history, document }))
    vi.stubGlobal('localStorage', storage({
      'coomi.connectionMode': 'cloud',
      'coomi.deviceId': 'pc-1',
      'coomi.pairedDevices': JSON.stringify([DEVICE]),
    }))
  })

  it('有任何 HTTP 应答就算电脑在线，哪怕这一枪是 401', async () => {
    const fetchSpy = vi.fn(async () => new Response('{"error":"unauthorized"}', { status: 401 }))
    vi.stubGlobal('fetch', fetchSpy)
    const device = await loadDeviceStore()

    await device.probeHost()

    expect(device.hostProbe?.reachable).toBe(true)
    expect(device.devices[0]?.reachability).toBe('online')
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe('http://192.168.1.10:8787/api/device/info')
  })

  it('没有应答时记下离线结论，但不把设备判死', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch') }))
    const device = await loadDeviceStore()

    await device.probeHost()

    expect(device.hostProbe?.reachable).toBe(false)
    expect(device.devices[0]?.reachability).toBe('online')
  })

  it('本机模式不探远端：那台电脑根本不在链路里', async () => {
    const fetchSpy = vi.fn(async () => new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('localStorage', storage({ 'coomi.connectionMode': 'local', 'coomi.pairedDevices': JSON.stringify([DEVICE]) }))
    const device = await loadDeviceStore()

    await device.probeHost()

    expect(device.hostProbe).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })
})
