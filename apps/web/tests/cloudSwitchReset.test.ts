import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

/**
 * 「本地对话中切到云端，界面必须回到新建对话页」——上下文真的变了，就不得停留在
 * 切换前的那段对话（那是旧上下文的会话）。
 *
 * 通过真实 device + sessions store 与 useConnectionContext 的 watch 链路验证，
 * 而不是只测某个 store 的孤立方法。
 */

const sessionApi = {
  isBusy: false,
  newSession: vi.fn(),
  reconnect: vi.fn(),
  disconnect: vi.fn(),
}

vi.mock('@/stores/session', () => ({
  useSessionStore: () => sessionApi,
}))

vi.mock('@/stores/config', () => ({
  useConfigStore: () => ({
    fetchProviders: vi.fn(async () => undefined),
    switchEngineContext: vi.fn(),
  }),
}))

vi.mock('@/stores/connection', () => ({
  useConnectionStore: () => ({
    setTransport: vi.fn(),
    setStatus: vi.fn(),
    state: 'idle',
  }),
}))

vi.mock('@/bridge/http', () => ({
  authedFetch: vi.fn(async () => ({ ok: false })),
  apiGet: vi.fn(async () => ({})),
  apiSend: vi.fn(async () => ({})),
  engineToken: () => '',
  // 启动加载会先等引擎令牌：mock 缺少它会异步抛未处理异常。
  waitForEngineToken: vi.fn(async () => ''),
  setEngineEndpoint: vi.fn(),
}))

vi.mock('@/bridge/remote', () => ({
  createLocalConnectionClient: vi.fn(),
}))

vi.mock('@/bridge/p2pHttp', () => ({
  hasP2PChannel: () => false,
}))

vi.mock('@/utils/hydration', () => ({
  deferUntilTransportOpen: vi.fn(),
  flushHydrationOnOpen: vi.fn(),
  // useConnectionContext 启动即加载走的是 primeHydration：mock 里缺它会让
  // 组件异步抛 "No export is defined"，vitest 按未处理异常判整轮失败。
  // 真实实现会吞掉失败并留在队列里等重试；mock 也必须吞，否则未处理异常会让整轮判失败。
  primeHydration: vi.fn(async (task: () => unknown) => {
    try { await task() } catch { /* keep pending */ }
  }),
}))

vi.mock('@/utils/hostPresence', () => ({
  shouldProbeHost: () => false,
}))

vi.mock('@/utils/transportAttribution', () => ({
  applyTransportDiagTo: vi.fn(),
}))

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
  vi.stubGlobal('window', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
  vi.stubGlobal('localStorage', storage({
    'coomi.connectionMode': 'local',
    'coomi.sessions.v1': JSON.stringify([
      { id: 'local-1', title: '本地会话', createdAt: 1, updatedAt: 2, turns: 3, pinned: false },
    ]),
  }))
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useDeviceStore } = await import('@/stores/device')
  const { useSessionsStore } = await import('@/stores/sessions')
  const device = useDeviceStore()
  const sessions = useSessionsStore()
  const { useConnectionContext } = await import('@/composables/useConnectionContext')
  useConnectionContext()
  await nextTick()
  return { device, sessions }
}

describe('切换云端回到新建对话页', () => {
  beforeEach(() => {
    sessionApi.newSession.mockReset()
    sessionApi.reconnect.mockReset()
    sessionApi.disconnect.mockReset()
  })

  it('本地对话切到云端（未选设备）→ 清空历史 + 回到新建对话', async () => {
    const { device, sessions } = await setup()
    expect(sessions.metas.length).toBe(1)

    device.setMode('cloud')
    await nextTick()
    await nextTick()

    expect(sessions.metas.length).toBe(0)
    expect(sessionApi.newSession).toHaveBeenCalledTimes(1)
  })

  it('云端切回本地同样回到新建对话（不残留云端对话）', async () => {
    const { device, sessions } = await setup()
    device.setMode('cloud')
    await nextTick()
    await nextTick()
    const callsAfterCloud = sessionApi.newSession.mock.calls.length

    device.setMode('local')
    await nextTick()
    await nextTick()

    expect(sessionApi.newSession.mock.calls.length).toBe(callsAfterCloud + 1)
    expect(sessions.context).toBe('local')
  })

  it('启动时上下文没变就不重置（避免每次冷启动都丢当前对话）', async () => {
    const { sessions } = await setup()
    expect(sessions.context).toBe('local')
    expect(sessionApi.newSession).not.toHaveBeenCalled()
  })
})