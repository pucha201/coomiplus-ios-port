import type { ConnectionMode } from '@/protocol/remote'

export const CONNECTION_MODE_KEY = 'coomi.connectionMode'

/**
 * 读取「本地 / 云端」模式。
 *
 * 历史 bug：device store 曾用 persist()（JSON.stringify）写这个键，值在 localStorage
 * 里是带引号的 `"cloud"`；而读取端用裸字符串 `'cloud'` 比较 —— 于是每次 WebView
 * 重载/App 重启后，云端模式都悄悄退回本地，侧边栏重新铺出本地历史（用户反复报
 * 「切换云端后侧边栏还有历史条目」）。这里兼容带引号的旧值，写入一律裸字符串。
 */
export function readStoredMode(storage: Pick<Storage, 'getItem'>): ConnectionMode {
  try {
    const raw = storage.getItem(CONNECTION_MODE_KEY)
    if (raw === 'cloud' || raw === 'local') return raw
    if (!raw) return 'local'
    const parsed: unknown = JSON.parse(raw)
    return parsed === 'cloud' ? 'cloud' : 'local'
  } catch {
    return 'local'
  }
}

export function writeStoredMode(storage: Pick<Storage, 'setItem'>, mode: ConnectionMode): void {
  try {
    storage.setItem(CONNECTION_MODE_KEY, mode)
  } catch { /* 隐私模式等不可写场景：内存态照常生效，持久化失败不致命 */ }
}