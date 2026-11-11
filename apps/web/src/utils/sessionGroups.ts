/**
 * 会话列表分组：默认工作目录下的进「对话」，其它工作目录各自成组。
 *
 * 桌面（React）和手机（Vue）共用这一份。以前两边各写一套：桌面按项目分，
 * 手机按「今天/昨天/7 天内」分 —— 同一份历史在两端长成两棵树，用户以为没同步。
 */
export interface GroupableSession {
  id: string
  cwd?: string
  createdAt?: number
  updatedAt?: number
  pinned?: boolean
}

export interface WorkspaceGroup<T> {
  key: string
  label: string
  path: string
  kind: 'default' | 'project'
  sessions: T[]
}

export interface GroupSessionsOptions<T> {
  /** 默认工作目录（电脑端当前 cwd / 手机端当前项目）。 */
  defaultCwd?: string
  /** 默认根目录：它下面的所有子目录都算「默认分组」（引擎会给每个会话建子目录）。 */
  defaultPrefix?: string
  /** 需要隐藏的会话。 */
  hidden?: (session: T) => boolean
  /** 项目重命名：给定 cwd 返回用户起的名字。 */
  projectName?: (path: string) => string | undefined
  /** 组内排序覆盖；缺省按「置顶优先 → updatedAt 倒序」。 */
  sort?: (list: T[]) => T[]
  /** 默认组的标题。 */
  defaultLabel?: string
}

/** 路径比较只认分隔符与大小写差异，避免同一个目录被拆成两组。 */
export function normCwd(value: string | undefined): string {
  return (value ?? '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
}

function pathTail(path: string, depth: number): string {
  const parts = path.split('/').filter(Boolean)
  return parts.slice(-depth).join('/') || path
}

function defaultSort<T extends GroupableSession>(list: T[]): T[] {
  return [...list].sort((a, b) => {
    const pinned = (a.pinned ? 1 : 0) - (b.pinned ? 1 : 0)
    if (pinned !== 0) return -pinned
    return (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0)
  })
}

export function groupSessionsByWorkspace<T extends GroupableSession>(
  sessions: T[],
  options: GroupSessionsOptions<T> = {},
): WorkspaceGroup<T>[] {
  const def = normCwd(options.defaultCwd)
  const prefix = normCwd(options.defaultPrefix)
  const visible = options.hidden ? sessions.filter(session => !options.hidden!(session)) : sessions
  const sort = options.sort ?? defaultSort
  const inDefault: T[] = []
  const byPath = new Map<string, T[]>()
  const pathByKey = new Map<string, string>()
  for (const session of visible) {
    const cwd = session.cwd ?? ''
    const norm = normCwd(cwd)
    const underDefault = !!prefix && !!norm && (norm === prefix || norm.startsWith(prefix + '/'))
    if (!cwd || (def && norm === def) || underDefault) { inDefault.push(session); continue }
    // 同一个目录的不同写法（尾斜杠/反斜杠/大小写）必须并进同一组
    const key = norm || cwd
    pathByKey.set(key, pathByKey.get(key) ?? cwd)
    const list = byPath.get(key) ?? []
    list.push(session)
    byPath.set(key, list)
  }
  const groups: WorkspaceGroup<T>[] = []
  if (inDefault.length) {
    groups.push({
      key: 'default',
      label: options.defaultLabel ?? '对话',
      path: options.defaultCwd ?? '',
      kind: 'default',
      sessions: sort(inDefault),
    })
  }
  const projects = [...byPath.entries()]
    .map(([key, list]) => {
      const path = pathByKey.get(key) ?? key
      return {
      key: 'proj:' + key,
      label: options.projectName?.(path) || pathTail(path, 2),
      path,
      kind: 'project' as const,
      sessions: sort(list),
      }
    })
    .sort((a, b) => a.label.localeCompare(b.label))
  return [...groups, ...projects]
}
