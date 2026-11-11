import { afterEach, describe, expect, it, vi } from 'vitest'
import { hasP2PChannel, p2pFetch, setP2PChannel } from '../src/bridge/p2pHttp'

afterEach(() => setP2PChannel(null))

describe('P2P HTTP channel liveness', () => {
  it('does not advertise a channel whose structured state is closed', () => {
    setP2PChannel({
      isOpen: () => false,
      sendPayload: vi.fn(async () => undefined),
      onPayload: () => () => undefined,
    })

    expect(hasP2PChannel()).toBe(false)
  })

  it('rejects immediately instead of sending over a closed channel', async () => {
    const sendPayload = vi.fn(async () => undefined)
    setP2PChannel({ isOpen: () => false, sendPayload, onPayload: () => () => undefined })

    await expect(p2pFetch('/api/runtime/health')).rejects.toThrow('P2P 通道未连接')
    expect(sendPayload).not.toHaveBeenCalled()
  })

  it('rejects pending requests as soon as the active channel is removed', async () => {
    setP2PChannel({ sendPayload: async () => undefined, onPayload: () => () => undefined })
    const request = p2pFetch('/api/slow', {}, 20)

    setP2PChannel(null)

    await expect(request).rejects.toThrow('P2P 通道已关闭')
  })
})
