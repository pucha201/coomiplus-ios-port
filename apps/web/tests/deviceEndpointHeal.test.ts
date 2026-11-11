import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「电脑换了 IP / 端口」不该要求用户重新扫码：探活失败时在局域网里按 deviceId
 * 找回新地址，换过去再重试一次。这里用真实 device store + 假的传输层验证整条链路。
 */

const discovery = { discoverDesktops: vi.fn() }
vi.mock('@/bridge/discovery', () => discovery)

const statusCalls: string[] = []
vi.mock('@/bridge/remote', () => ({
  createLocalConnectionClient: () => ({
    engineBase: '',
    async getEngineStatus() { return { engineBase: '', tokenConfigured: true, checkedAt: Date.now() } },
  }),
  RemoteConnectionClient: class {
    engineBase: string
    constructor(options: { engineBase: string }) { this.engineBase = options.engineBase }
    async getEngineStatus() {
      statusCalls.push(this.engineBase)
      if (this.engineBase === 'http://192.168.3.20:1111') throw new Error('connect timeout')
      return { engineBase: this.engineBase, tokenConfigured: true, checkedAt: Date.now() }
    }
  },
}))

vi.mock('@/bridge/http', () => ({
  authedFetch: vi.fn(async () => ({ ok: false, status: 503, json: async () => ({}) })),
  engineToken: () => '',
  setEngineEndpoint: vi.fn(),
}))
vi.mock('@/bridge/p2pHttp', () => ({ hasP2PChannel: () => false }))
vi.mock('@/stores/session', () => ({ useSessionStore: () => ({ reconnect: vi.fn() }) }))
vi.mock('@/utils/brokerConfig', () => ({ brokerUrlFor: () => '' }))

function storage(seed: Record<string, string> = {}): Storage {
  const values = new Map<string, string>(Object.entries(seed))
  return {
    get length() { return values.size },
    clear: () => values.clear(),
    getItem: key => values.get(key) ?? null,
    key: index => [...values.keys()][index] ?? null,
    removeItem: key => { values.delete(key) },
    setItem: (key, value) => { values.set(key, String(value)) },
  } as Storage
}

async function setup() {
  vi.resetModules()
  statusCalls.length = 0
  discovery.discoverDesktops.mockReset()
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('localStorage', storage({
    'coomi.connectionMode': 'cloud',
    'coomi.deviceId': 'dev_1',
    'coomi.engineToken': 'coomi_pair_token',
    'coomi.pairedDevices': JSON.stringify([{
      id: 'dev_1',
      peerId: 'peer_1',
      pairingSecret: 'coomi_pair_token',
      name: '书房电脑',
      kind: 'desktop',
      engineBase: 'http://192.168.3.20:1111',
      reachability: 'unknown',
      createdAt: 1,
      updatedAt: 1,
    }]),
  }))
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useDeviceStore } = await import('@/stores/device')
  return useDeviceStore()
}

describe('电脑换地址后自动找回', () => {
  beforeEach(() => { vi.clearAllMocks() })

  it('探活失败 → 局域网发现同一台电脑 → 换地址并重试成功', async () => {
    const device = await setup()
    discovery.discoverDesktops.mockResolvedValue([
      { deviceId: 'dev_1', name: '书房电脑', host: '192.168.3.99', port: 49217, version: '1.0.0-rc68' },
    ])

    const status = await device.checkEngine()

    expect(status?.error).toBeUndefined()
    expect(device.devices[0].engineBase).toBe('http://192.168.3.99:49217')
    expect(device.engineBase).toBe('http://192.168.3.99:49217')
    expect(device.activeDevice?.reachability).toBe('online')
    expect(statusCalls).toEqual(['http://192.168.3.20:1111', 'http://192.168.3.99:49217'])
  })

  it('局域网里也找不到 → 保持离线、地址不变', async () => {
    const device = await setup()
    discovery.discoverDesktops.mockResolvedValue([])

    const status = await device.checkEngine()

    expect(status?.error).toContain('connect timeout')
    expect(device.devices[0].engineBase).toBe('http://192.168.3.20:1111')
    expect(device.activeDevice?.reachability).toBe('offline')
    expect(statusCalls).toEqual(['http://192.168.3.20:1111'])
  })

  it('发现请求本身失败（本地引擎不可用）也不能把探活打断', async () => {
    const device = await setup()
    discovery.discoverDesktops.mockRejectedValue(new Error('HTTP 401'))

    const status = await device.checkEngine()

    expect(status?.error).toContain('connect timeout')
    expect(device.activeDevice?.reachability).toBe('offline')
  })
})
