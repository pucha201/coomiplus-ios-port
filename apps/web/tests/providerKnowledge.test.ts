import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 「明明配了模型，切云端却被推进添加模型控制台」的根因在 store：
 * 列表被清空的那一刻，界面无法区分「这台引擎没模型」和「还没读到」。
 * 这里锁住 providersKnown 的三条口径：应答过才算知道、切上下文必须归零、读失败不算知道。
 */

const http = vi.hoisted(() => ({ apiGet: vi.fn(), apiSend: vi.fn() }))
vi.mock('@/bridge/http', () => ({ apiGet: http.apiGet, apiSend: http.apiSend }))

async function loadConfigStore() {
  vi.resetModules()
  const values = new Map<string, string>()
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, String(value)) },
    removeItem: (key: string) => { values.delete(key) },
    clear: () => values.clear(),
  }
  vi.stubGlobal('localStorage', storage)
  // 主题档位优先问原生桥：测试里没有桥，也没有 jsdom，给个最小 window 就够。
  vi.stubGlobal('window', { CoomiAndroid: undefined, localStorage: storage, matchMedia: () => ({ matches: false }) })
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useConfigStore } = await import('@/stores/config')
  return useConfigStore()
}

const PROVIDERS = {
  providers: [{ id: 'openai', name: 'OpenAI', model: 'gpt-4o', models: ['gpt-4o'], baseUrl: 'https://api.openai.com/v1', apiKey: '' }],
  active: 'openai',
}

describe('模型列表的「知不知道」', () => {
  beforeEach(() => {
    http.apiGet.mockReset()
    http.apiSend.mockReset()
  })

  it('刚进 App 一次都没读过：是「不知道」，不是「没模型」', async () => {
    const config = await loadConfigStore()

    expect(config.providers).toEqual([])
    expect(config.providersKnown).toBe(false)
  })

  it('引擎应答过才叫知道，哪怕它报回来的列表是空的', async () => {
    const config = await loadConfigStore()
    http.apiGet.mockResolvedValue({ providers: [], active: '' })

    await config.fetchProviders()

    expect(config.providersKnown).toBe(true)
    expect(config.providers).toEqual([])
  })

  it('切到另一台引擎：上一台的应答对新引擎不作数，重新变回不知道', async () => {
    const config = await loadConfigStore()
    http.apiGet.mockResolvedValue(PROVIDERS)
    await config.fetchProviders()
    expect(config.providersKnown).toBe(true)

    config.switchEngineContext('cloud:dev_1')

    expect(config.providers).toEqual([])
    expect(config.providersKnown).toBe(false)
  })

  it('没连上电脑时读列表失败，不能把失败说成「这台引擎没模型」', async () => {
    const config = await loadConfigStore()
    http.apiGet.mockRejectedValue(new Error('gateway not open'))

    await config.fetchProviders()

    expect(config.providersKnown).toBe(false)
  })
})
