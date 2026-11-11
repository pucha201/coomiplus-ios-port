import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 生成结束时 syncFromEngine 会把整份会话列表换成新对象。行对象一换身份，
 * 侧栏每一行都重建一次——用户看到的就是「界面整体闪一下」。
 * 这里锁住：内容没变就不许换身份，变了也只改字段。
 */

const authedFetch = vi.fn()
const apiSend = vi.fn(async () => ({}))

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
  apiSend: (...args: unknown[]) => apiSend(...args),
}))

async function loadSessionsStore(seed: Record<string, string> = { 'coomi.connectionMode': 'local' }) {
  vi.resetModules()
  vi.stubGlobal('localStorage', storage(seed))
  vi.stubGlobal('location', { search: '', hash: '' })
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useSessionsStore } = await import('@/stores/sessions')
  return useSessionsStore()
}

function engineSession(id: string, title: string, updatedAt = '2026-01-02T00:00:00Z') {
  return {
    id, title, provider_id: 'p', model: 'm', cwd: 'G:/work',
    updated_at: updatedAt, preview: 'hi', summary: '', created_at: '2026-01-01T00:00:00Z',
    title_manually_set: true, pinned: false,
  }
}

function reply(sessions: unknown[]) {
  authedFetch.mockResolvedValueOnce(new Response(JSON.stringify({ sessions }), { status: 200 }))
}

describe('会话列表刷新不重建行', () => {
  beforeEach(() => {
    authedFetch.mockReset()
    apiSend.mockClear()
  })

  it('引擎回同一份列表时行对象身份保持不变', async () => {
    const sessions = await loadSessionsStore()
    const payload = [engineSession('s1', '第一轮'), engineSession('s2', '第二轮')]
    reply(payload)
    expect(await sessions.syncFromEngine()).toBe(true)
    const before = [...sessions.metas]

    reply(payload)
    expect(await sessions.syncFromEngine()).toBe(true)

    expect(sessions.metas.map(meta => meta.id)).toEqual(['s1', 's2'])
    expect(sessions.metas[0]).toBe(before[0])
    expect(sessions.metas[1]).toBe(before[1])
  })

  it('引擎改了标题时更新字段而不是换掉整行', async () => {
    const sessions = await loadSessionsStore()
    reply([engineSession('s1', '旧标题')])
    await sessions.syncFromEngine()
    const row = sessions.metas[0]

    reply([engineSession('s1', '新标题')])
    await sessions.syncFromEngine()

    expect(sessions.metas[0]).toBe(row)
    expect(sessions.metas[0].title).toBe('新标题')
  })

  it('顺序变了仍复用同一批行对象', async () => {
    const sessions = await loadSessionsStore()
    reply([engineSession('s1', '甲', '2026-01-01T00:00:00Z'), engineSession('s2', '乙', '2026-01-05T00:00:00Z')])
    await sessions.syncFromEngine()
    const [row1, row2] = sessions.metas

    reply([engineSession('s2', '乙', '2026-01-05T00:00:00Z'), engineSession('s1', '甲', '2026-01-01T00:00:00Z')])
    await sessions.syncFromEngine()

    expect(sessions.metas.map(meta => meta.id)).toEqual(['s2', 's1'])
    expect(sessions.metas[0]).toBe(row2)
    expect(sessions.metas[1]).toBe(row1)
  })

  it('不 replace 时本机独有的会话仍然留着', async () => {
    const sessions = await loadSessionsStore()
    sessions.ensure('s-local', '本机独有的')
    sessions.touch('s-local', { turns: 2 })
    const localRow = sessions.metas.find(meta => meta.id === 's-local')

    reply([engineSession('s1', '引擎的')])
    await sessions.syncFromEngine()

    expect(sessions.metas.map(meta => meta.id)).toEqual(['s1', 's-local'])
    expect(sessions.metas[1]).toBe(localRow)
  })
})
