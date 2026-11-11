/**
 * 侧栏会话分组的手机端适配层。
 *
 * 分两层：
 *  1. 手动分组（localStorage `coomi:session-groups`）：用户自己建的组，置顶显示；
 *  2. 项目分组（复用 sessionGroups.ts 的 groupSessionsByWorkspace）：按 cwd 自动分，
 *     与桌面同一份分组逻辑、同一份项目重命名数据（`meta['proj:'+path].projectName`）。
 *
 * 为什么要拆出来：SideDrawer 只该管渲染，分组的数据读写和排序规则塞进组件里
 * 会变成第二个真相源。桌面端也是这么分的（sessionGroups.ts 纯函数 + 宿主负责持久化）。
 */

export interface ManualGroup {
  id: string
  name: string
  order: number
}

const GROUPS_KEY = 'coomi:session-groups'
const PROJ_META_KEY = 'coomi:project-names.v1'

/** 读手动分组；解析失败按空处理，不让一条坏数据把侧栏搞白。 */
export function readManualGroups(): ManualGroup[] {
  if (typeof localStorage === 'undefined') return []
  try {
    const raw = localStorage.getItem(GROUPS_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const out: ManualGroup[] = []
    for (const row of parsed) {
      if (!row || typeof row !== 'object') continue
      const item = row as Partial<ManualGroup>
      if (typeof item.id !== 'string' || !item.id) continue
      out.push({
        id: item.id,
        name: typeof item.name === 'string' && item.name ? item.name : '未命名分组',
        order: typeof item.order === 'number' ? item.order : 0,
      })
    }
    return out.sort((a, b) => a.order - b.order)
  } catch {
    return []
  }
}

export function writeManualGroups(groups: ManualGroup[]): void {
  if (typeof localStorage === 'undefined') return
  try {
    localStorage.setItem(GROUPS_KEY, JSON.stringify(groups))
  } catch { /* 配额满/隐私模式：忽略，分组只是便利功能 */ }
}

/** 生成一个稳定但不重复的分组 id。 */
export function newGroupId(): string {
  return `g${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

/** 项目重命名表：与桌面同一份键空间（proj:<规范化路径>）。 */
type ProjectNameMap = Record<string, string>

function normPath(path: string): string {
  return path.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

export function readProjectNames(): ProjectNameMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(PROJ_META_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: ProjectNameMap = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) out[key] = value
    }
    return out
  } catch {
    return {}
  }
}

export function projectNameFor(path: string, map: ProjectNameMap = readProjectNames()): string | undefined {
  return map['proj:' + normPath(path)]
}

export function setProjectName(path: string, name: string | null): void {
  if (typeof localStorage === 'undefined') return
  const map = readProjectNames()
  const key = 'proj:' + normPath(path)
  const trimmed = (name ?? '').trim()
  if (trimmed) map[key] = trimmed
  else delete map[key]
  try {
    localStorage.setItem(PROJ_META_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}

/** 折叠状态：key → 是否收起。缺省视为展开。 */
const COLLAPSE_KEY = 'coomi:session-collapsed'

export function readCollapsed(): Record<string, boolean> {
  if (typeof localStorage === 'undefined') return {}
  try {
    const raw = localStorage.getItem(COLLAPSE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    const out: Record<string, boolean> = {}
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (value === true) out[key] = true
    }
    return out
  } catch {
    return {}
  }
}

export function setCollapsed(key: string, collapsed: boolean): void {
  if (typeof localStorage === 'undefined') return
  const map = readCollapsed()
  if (collapsed) map[key] = true
  else delete map[key]
  try {
    localStorage.setItem(COLLAPSE_KEY, JSON.stringify(map))
  } catch { /* ignore */ }
}
