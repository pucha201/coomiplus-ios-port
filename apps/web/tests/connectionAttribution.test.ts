import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 界面上只该有一份「连接到底怎么了」的真相：桥层的通道诊断进 store，
 * 横幅和设备条读同一个 attribution，不再各说各话。
 */

async function loadConnectionStore() {
  vi.resetModules()
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useConnectionStore } = await import('@/stores/connection')
  return useConnectionStore()
}

describe('云端连接可归因', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.stubGlobal('location', { search: '', hash: '' })
    vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} })
  })

  it('通道诊断变成界面能直接显示的一句话', async () => {
    const connection = await loadConnectionStore()
    connection.setTransport({ phase: 'relay', state: 'error', reason: 'P2P signaling failed' })

    expect(connection.attribution).toEqual({
      channel: '加密中转',
      detail: '加密中转连不上：信令服务器不可用',
      connected: false,
    })
  })

  it('本机模式没有通道诊断时归因为空，界面不多说什么', async () => {
    const connection = await loadConnectionStore()
    connection.setTransport({ phase: 'webrtc', state: 'open', reason: '' })
    connection.setTransport(null)

    expect(connection.attribution).toBeNull()
  })

  it('重新生成配对码前不把「已连接」的旧状态留着骗人', async () => {
    const connection = await loadConnectionStore()
    connection.setTransport({ phase: 'lan', state: 'open', reason: '' })
    expect(connection.attribution?.connected).toBe(true)

    connection.setStatus({ state: 'closed', reason: 'LAN connection lost' })
    connection.setTransport({ phase: 'webrtc', state: 'connecting', reason: '直连不可用' })

    expect(connection.attribution?.connected).toBe(false)
    expect(connection.attribution?.channel).toBe('WebRTC 直连')
  })

  it('本机模式不收云端通道诊断：旧降级链的迟到事件不许把归因带回来', async () => {
    vi.stubGlobal('window', {
      __coomiTransport: { phase: 'relay', state: 'error', reason: 'P2P signaling failed' },
      localStorage: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
      location: { search: '', hash: '' },
    })
    const connection = await loadConnectionStore()
    const { applyTransportDiagTo } = await import('@/utils/transportAttribution')

    applyTransportDiagTo(connection, 'local')
    expect(connection.transport).toBeNull()

    applyTransportDiagTo(connection, 'cloud')
    expect(connection.attribution?.detail).toBe('加密中转连不上：信令服务器不可用')
  })
})
