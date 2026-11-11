import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 云端上下文规则（2026-11-09 调整）：
 *  · 每个设备各有一份**展示快照**（标题/预览），冷启动先铺出来，避免「重启后最近会话整片消失、
 *    连上又莫名恢复」；任何一次成功同步都用引擎列表整体替换。
 *  · 会话正文仍然只活在电脑上：手机不落 transcript。
 *  · 同步失败（弱网/重连中）不清空列表；只有「云端未选设备」这个真正的空上下文才清空。
 */

const authedFetch = vi.fn()

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

vi.mock('@/bridge/http', () => ({
  authedFetch: (...args: unknown[]) => authedFetch(...args),
  apiGet: vi.fn(async () => ({})),
  apiSend: vi.fn(async () => ({})),
}))

async function loadSessionsStore() {
  vi.resetModules()
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useSessionsStore } = await import('@/stores/sessions')
  return useSessionsStore()
}

function engineSession(id: string, title: string) {
  return {
    id, title, provider_id: 'p', model: 'm', cwd: 'G:/work',
    updated_at: new Date(2_000).toISOString(), created_at: new Date(1_000).toISOString(),
    preview: 'hi', summary: '', title_manually_set: true, pinned: false,
  }
}

describe('云端会话历史隔离', () => {
  beforeEach(() => {
    authedFetch.mockReset()
    vi.stubGlobal('localStorage', storage({ 'coomi.connectionMode': 'cloud', 'coomi.deviceId': 'desktop-1' }))
    vi.stubGlobal('location', { search: '', hash: '' })
  })

  it('切进云端上下文时先铺该设备上次的快照，同步成功后整体替换', async () => {
    const store = storage({
      'coomi.connectionMode': 'cloud',
      'coomi.deviceId': 'desktop-1',
      'coomi.sessions.v1:cloud:desktop-1': JSON.stringify([{ id: 'old', title: '上次连电脑时的列表', createdAt: 1, updatedAt: 1, turns: 3, pinned: false }]),
    })
    vi.stubGlobal('localStorage', store)
    const sessions = await loadSessionsStore()
    sessions.switchContext('cloud:desktop-1')

    // 冷启动首屏：先显示这台电脑上一次的快照（不再整片空白）。
    expect(sessions.metas.map(meta => meta.id)).toEqual(['old'])

    authedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [engineSession('s1', '电脑上的会话')] }), { status: 200 }))
    expect(await sessions.syncFromEngine({ replace: true })).toBe(true)
    // 同步成功：以电脑端为准，不混入快照里的旧条目。
    expect(sessions.metas.map(meta => meta.id)).toEqual(['s1'])
  })

  it('云端只落展示快照，会话正文不写进手机存储', async () => {
    const sessions = await loadSessionsStore()
    sessions.switchContext('cloud:desktop-1')
    sessions.ensure('s-cloud', '云端会话')
    sessions.touch('s-cloud', { turns: 2 })
    sessions.saveTranscript('s-cloud', [
      { kind: 'user', id: 'm1', mid: 'm1', content: '电脑上的对话正文' },
    ])

    // 标题/预览快照可以落盘（首屏用）。
    expect(localStorage.getItem('coomi.sessions.v1:cloud:desktop-1')).not.toBeNull()
    // 正文绝不落手机。
    expect(localStorage.getItem('coomi.transcript.cloud:desktop-1.s-cloud')).toBeNull()
    expect(sessions.loadTranscript('s-cloud')).toEqual([])
  })

  it('云端同步失败时保留上一轮列表，不清空侧栏', async () => {
    const sessions = await loadSessionsStore()
    sessions.switchContext('cloud:desktop-1')

    authedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessions: [engineSession('s1', '电脑上的会话')] }), { status: 200 }))
    expect(await sessions.syncFromEngine({ replace: true })).toBe(true)
    expect(sessions.metas.map(meta => meta.id)).toEqual(['s1'])

    authedFetch.mockRejectedValueOnce(new Error('云端未连接电脑：请求没有发出'))
    expect(await sessions.syncFromEngine({ replace: true })).toBe(false)
    // 弱网/重连中的一次失败不能让最近会话消失（旧行为会清空、下一次成功又全部出现）。
    expect(sessions.metas.map(meta => meta.id)).toEqual(['s1'])
  })

  it('本地模式同步失败仍然保留本机历史', async () => {
    vi.stubGlobal('localStorage', storage({ 'coomi.connectionMode': 'local' }))
    const sessions = await loadSessionsStore()
    sessions.ensure('s-local', '本机会话')
    sessions.touch('s-local', { turns: 1 })

    authedFetch.mockRejectedValueOnce(new Error('引擎没起来'))
    expect(await sessions.syncFromEngine()).toBe(false)
    expect(sessions.metas.map(meta => meta.id)).toEqual(['s-local'])
  })
})
