import { describe, expect, it } from 'vitest'
import { CONNECTION_MODE_KEY, readStoredMode, writeStoredMode } from '@/utils/connectionMode'

/**
 * 连接模式持久化的读写对称性。
 *
 * 背景：device store 用 persist()（JSON.stringify）写 coomi.connectionMode，
 * 读出的是带引号的 `"cloud"`，而初始化比较用裸字符串 'cloud' —— 重载即退回本地，
 * 侧边栏把本地历史重新铺出来（用户反复报「切到云端侧边栏还有历史条目」）。
 */
describe('连接模式持久化', () => {
  function storage(seed: Record<string, string> = {}) {
    const values = new Map<string, string>(Object.entries(seed))
    return {
      get length() { return values.size },
      clear: () => values.clear(),
      getItem: (key: string) => values.get(key) ?? null,
      key: (index: number) => [...values.keys()][index] ?? null,
      removeItem: (key: string) => { values.delete(key) },
      setItem: (key: string, value: string) => { values.set(key, String(value)) },
    } as Storage
  }

  it('旧版本 JSON 带引号的 "cloud" 仍读成云端（重载不再退回本地）', () => {
    const s = storage({ [CONNECTION_MODE_KEY]: '"cloud"' })
    expect(readStoredMode(s)).toBe('cloud')
  })

  it('裸字符串 cloud / local 原样读回', () => {
    expect(readStoredMode(storage({ [CONNECTION_MODE_KEY]: 'cloud' }))).toBe('cloud')
    expect(readStoredMode(storage({ [CONNECTION_MODE_KEY]: 'local' }))).toBe('local')
    expect(readStoredMode(storage({}))).toBe('local')
  })

  it('写入永远是裸字符串（读写对称，重载后模式不变）', () => {
    const s = storage()
    writeStoredMode(s, 'cloud')
    expect(s.getItem(CONNECTION_MODE_KEY)).toBe('cloud')
    expect(readStoredMode(s)).toBe('cloud')
    writeStoredMode(s, 'local')
    expect(readStoredMode(s)).toBe('local')
  })
})