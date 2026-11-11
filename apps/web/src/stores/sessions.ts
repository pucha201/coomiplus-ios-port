import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import { isDemoMode } from '@/bridge/demoMode'
import { apiGet, apiSend, authedFetch } from '@/bridge/http'
import { GLOBAL_SESSION_ID } from '@/bridge/life'
import type { Timelineitem } from './viewModel'
import { parseTranscript, transcriptTail } from '@/utils/chatTimeline'
import { isPlanModeTitle, stripPlanModePrefix } from '@/utils/planPrefix'

/**
 * 会话历史（纯本机）。
 *
 * bridge 没有「列出会话」接口，引擎侧 SessionManager 也只把会话放在内存里
 * （coomi/engine/session.py:110），所以历史列表只能由前端自己维护：
 *   - 元数据存 localStorage，抽屉据此分组渲染；
 *   - 时间线也存一份，重开旧会话时先把本机记录铺回来；
 *   - 重连用同一个 sessionId，引擎进程没重启的话上下文是真的接上了，
 *     重启过就只剩本机这份记录 —— 这一点由 ChatView 明确提示用户。
 */

const META_KEY = 'coomi.sessions.v1'
const TRANSCRIPT_PREFIX = 'coomi.transcript.'
/** 已删除、但引擎侧还没确认删掉的会话：同步时过滤，避免「删了又回来」。 */
const TOMBSTONE_KEY = 'coomi.deletedSessions.v1'
/** 只给最近的若干会话留时间线，避免把 localStorage 撑爆。 */
const KEEP_TRANSCRIPTS = 12

/** 当前连接上下文：本地引擎与每台云端电脑各自一份历史缓存，绝不互相混入。 */
function currentContextKey(): string {
  try {
    if (localStorage.getItem('coomi.connectionMode') === 'cloud') {
      const deviceId = localStorage.getItem('coomi.deviceId') ?? ''
      return 'cloud:' + (deviceId || 'unselected')
    }
  } catch { /* storage unavailable */ }
  return 'local'
}
function metaStorageKey(context: string): string {
  return context === 'local' ? META_KEY : META_KEY + ':' + context
}
function transcriptStorageKey(context: string, id: string): string {
  return (context === 'local' ? TRANSCRIPT_PREFIX : TRANSCRIPT_PREFIX + context + '.') + id
}
/** 云端上下文只带只读配对令牌：DELETE/POST 写接口必然 401，且绝不能把「清空手机缓存」变成「清空电脑历史」。 */
function isCloudContext(context: string): boolean {
  return context.startsWith('cloud:')
}

function tombstoneKey(context: string): string {
  return TOMBSTONE_KEY + ':' + context
}
/**
 * 墓碑只挡一小段时间：删除请求失败（引擎离线）时先让它在界面上消失，
 * 但 10 分钟后如果引擎里这条会话还在，就如实放出来 —— 绝不永久隐藏真实数据。
 */
const TOMBSTONE_TTL_MS = 10 * 60 * 1000
function readTombstoneEntries(context: string): Array<{ id: string; at: number }> {
  try {
    const raw = localStorage.getItem(tombstoneKey(context))
    const parsed = raw ? JSON.parse(raw) : null
    return (Array.isArray(parsed) ? parsed : []).filter(
      (entry: unknown): entry is { id: string; at: number } => {
        if (!entry || typeof entry !== 'object') return false
        const { id, at } = entry as { id?: unknown; at?: unknown }
        return typeof id === 'string' && typeof at === 'number'
      },
    )
  } catch {
    return []
  }
}
function readTombstones(context: string): Set<string> {
  const now = Date.now()
  return new Set(
    readTombstoneEntries(context)
      .filter(entry => now - entry.at < TOMBSTONE_TTL_MS)
      .map(entry => entry.id),
  )
}

export interface SessionMeta {
  id: string
  title: string
  createdAt: number
  updatedAt: number
  turns: number
  pinned: boolean
  /** 归档：从默认列表收进「已归档」，可恢复；与置顶互斥。 */
  archived?: boolean
  /** 创建该会话时的工作目录；用于把不同项目的会话隔离开。 */
  cwd?: string
  /** 引擎侧一句话摘要（/api/sessions 的 summary），用于检索与展示。 */
  summary?: string
  /** 引擎侧首条消息预览。 */
  preview?: string
  /** 引擎侧模型名。 */
  model?: string
  /** 引擎侧供应商 ID，与 model 一起组成会话级模型选择。 */
  providerId?: string
  /** 用户手动重命名过：true 时引擎推导的标题不再覆盖。 */
  renamed?: boolean
  /** Versioned conversation mode; older metadata defaults to agent. */
  mode?: 'agent' | 'team' | 'life'
  /** 手动分组 id（对应 localStorage 里 coomi:session-groups 的 id）；缺省表示未归组。 */
  groupId?: string
}

export interface SessionGroup {
  label: string
  items: SessionMeta[]
}

export interface TaskInfo {
  task_id: string
  session_id: string
  session_title: string
  status: 'queued' | 'waiting_lock' | 'running' | 'pause_pending' | 'paused' | 'awaiting_approval' | 'awaiting_input' | 'completed' | 'failed' | 'cancelled' | 'interrupted' | 'conflict'
  priority: 'low' | 'normal' | 'high'
  running: boolean
  started_at: number
  current_tool?: string | null
  task_kind?: 'download' | null
  download_label?: string | null
  download_status?: 'downloading' | 'completed' | 'failed' | null
  resources?: Array<{ key: { kind: string; identity: string }; access: 'read' | 'write' }>
  skills?: string[]
  model?: string | null
  retries?: number
  error?: string | null
  lock_wait_ms?: number
}

export interface TaskDetail {
  task: TaskInfo & { kind: string; created_at_ms: number; updated_at_ms: number }
  events: Array<{ at_ms: number; event: string; status: TaskInfo['status']; summary?: string }>
  logs: { events: string; output: string }
}

function readMetas(context: string): SessionMeta[] {
  // 云端上下文的权威列表在电脑上，这里读的是**按设备分开的上一次快照**：
  // 冷启动时先把上次看到的列表铺出来，等电脑连上再用引擎结果整体替换。
  // 旧实现云端一律返回空 —— 重启后（尤其是跨网、iroh 还在建链的几秒里）
  // 最近会话会整片消失，连上之后又「莫名其妙地恢复出现」。
  try {
    const raw = localStorage.getItem(metaStorageKey(context))
    if (!raw) return []
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed)
      ? (parsed as SessionMeta[]).filter(meta => meta.turns > 0 || meta.title !== '新对话')
      : []
  } catch {
    return []
  }
}

function dayStart(offsetDays = 0): number {
  const d = new Date()
  d.setHours(0, 0, 0, 0)
  return d.getTime() - offsetDays * 86400000
}

export function formatSessionTime(ts: number): string {
  const d = new Date(ts)
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  if (ts >= dayStart()) return hm
  if (ts >= dayStart(1)) return `昨天 ${hm}`
  return `${d.getMonth() + 1}月${d.getDate()}日`
}

export const useSessionsStore = defineStore('sessions', () => {
  /** 当前历史缓存所属的上下文（local / cloud:<deviceId>）。 */
  const context = ref(currentContextKey())
  /** 删除墓碑：删除请求是 fire-and-forget，引擎慢/失败时列表同步会把会话带回来。 */
  const deletedIds = ref<Set<string>>(readTombstones(context.value))
  const metas = ref<SessionMeta[]>(
    readMetas(context.value).filter(meta => !deletedIds.value.has(meta.id)),
  )
  const query = ref('')
  /** 引擎当前工作目录（来自 /api/runtime/health），用于会话按项目隔离。 */
  const currentCwd = ref('')
  /**
   * 引擎的路径命名空间（/api/runtime/health 的 paths + guest_aliases）。
   * 正文里的 `/home/coomi/...`、`/tmp/...` 要靠它映射回宿主路径；
   * `/workspace` 不在这里 —— 它等于**当前会话的 cwd**，由调用方传入。
   */
  const enginePaths = ref<{ runtimeHome?: string; buildKit?: string; tmp?: string; inbox?: string; guest?: boolean }>({})
  function setEnginePaths(paths: { runtimeHome?: string; buildKit?: string; tmp?: string; inbox?: string; guest?: boolean }): void {
    enginePaths.value = paths
  }
  /** 引擎侧正在后台执行的会话 id 集合（/api/sessions 的 running 字段）。 */
  const runningIds = ref<Set<string>>(new Set())
  const tasks = ref<TaskInfo[]>([])
  const taskConcurrencyLimit = ref(5)
  /** Foreground chats stay quiet; a turn running this long gets task status. */
  const LONG_TASK_MS = 10_000

  /** 上一次 /api/tasks 的内容指纹：内容没变就不替换数组，避免每 1.5s 让整页重算。 */
  let lastTasksSignature = ''
  async function refreshTasks() {
    try {
      const data = await apiGet<{ tasks: TaskInfo[]; running_count: number; concurrency_limit: number }>('/api/tasks')
      const nextTasks = data.tasks ?? []
      const nextLimit = data.concurrency_limit || 5
      const signature = JSON.stringify(nextTasks.map(task => [
        task.task_id, task.status, task.running, task.session_id,
        task.current_tool ?? '', task.download_status ?? '', task.error ?? '',
      ])) + '|' + nextLimit
      if (signature === lastTasksSignature) return
      lastTasksSignature = signature
      tasks.value = nextTasks
      taskConcurrencyLimit.value = nextLimit
      runningIds.value = new Set(tasks.value.filter(task => task.running).map(task => task.session_id))
      const activeSessionId = (window as Window & { __coomiActiveSessionId?: string }).__coomiActiveSessionId ?? ''
      const runningTask = tasks.value.find(task => task.running)
      const longTask = tasks.value.find(task => task.running
        && task.started_at > 0
        && Date.now() - task.started_at * 1000 >= LONG_TASK_MS)
      const backgroundTask = tasks.value.find(task => task.running && task.session_id !== activeSessionId)
        ?? longTask
        ?? (document.visibilityState !== 'visible' ? runningTask : undefined)
      const status = data.running_count > 0 ? `running:${data.running_count}` : 'done'
      const sessionId = backgroundTask?.session_id ?? runningTask?.session_id ?? ''
      const background = Boolean(backgroundTask)
      const title = (backgroundTask?.session_title || runningTask?.session_title || '').trim()
      const detail = (backgroundTask?.current_tool
        || backgroundTask?.download_label
        || runningTask?.current_tool
        || '').trim()
      // Prefer the richer island protocol (HyperOS focus extras + enhanced task card).
      // Older Android shells without updateTaskIsland still get the legacy path.
      if (window.CoomiAndroid?.updateTaskIsland) {
        window.CoomiAndroid.updateTaskIsland(JSON.stringify({
          state: data.running_count > 0 ? 'running' : 'done',
          title,
          count: data.running_count,
          sessionId,
          detail,
          background,
        }))
      } else if (window.CoomiAndroid?.updateTaskStatusDetails) {
        window.CoomiAndroid.updateTaskStatusDetails(status, sessionId, background)
      } else {
        window.CoomiAndroid?.updateTaskStatus?.(status)
      }
    } catch {
      /* Keep the last engine-authoritative snapshot while reconnecting. */
    }
  }

  async function cancelTask(sessionId: string): Promise<boolean> {
    try {
      await apiSend<{ cancelled: boolean }>(`/api/tasks/${encodeURIComponent(sessionId)}`, 'DELETE')
      await refreshTasks()
      return true
    } catch {
      return false
    }
  }

  async function taskAction(taskId: string, action: 'pause' | 'resume' | 'cancel' | 'retry' | 'priority', priority?: TaskInfo['priority']): Promise<boolean> {
    try {
      await apiSend(`/api/task-details/${encodeURIComponent(taskId)}/action`, 'POST', { action, ...(priority ? { priority } : {}) })
      await refreshTasks()
      return true
    } catch {
      return false
    }
  }

  async function taskDetail(taskId: string): Promise<TaskDetail | null> {
    try {
      return await apiGet<TaskDetail>(`/api/task-details/${encodeURIComponent(taskId)}`)
    } catch {
      return null
    }
  }

  /** 从引擎刷新各会话的 running 状态（轻量端点，不碰磁盘全文）。引擎不可用时保持原状。 */
  async function refreshRunning() {
    try {
      const res = await authedFetch('/api/sessions/running')
      if (!res.ok) return
      // 隐藏时不做无意义的重建：轮询仍会在回到前台时补一次（ChatView 监听 visibilitychange）。
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
      const data = (await res.json()) as {
        sessions: Array<{ id: string; running?: boolean; updated_at?: string }>
      }
      const next = new Set(
        (data.sessions ?? []).filter(s => s.running !== false).map(s => s.id),
      )
      // 集合没变就不换引用：runningIds 是侧栏每行「转圈」的依赖，
      // 每 2 秒换一个新 Set 会让所有会话行跟着重算一遍。
      const unchanged = next.size === runningIds.value.size
        && [...next].every(id => runningIds.value.has(id))
      if (!unchanged) runningIds.value = next
      // 时间戳合并交给 syncFromEngine（挂载时全量）；轮询不再读磁盘。
    } catch {
      /* 引擎未就绪：静默保持上次状态 */
    }
  }

  function isRunning(id: string): boolean {
    return runningIds.value.has(id)
  }

  /** 前端已知的运行态（后台会话 worker）：让侧栏转圈不必等 2s 轮询。 */
  function markRunning(id: string, running: boolean): void {
    if (!id) return
    const next = new Set(runningIds.value)
    if (running) next.add(id)
    else next.delete(id)
    runningIds.value = next
  }

  function setCurrentCwd(cwd: string) {
    currentCwd.value = cwd
  }

  const sorted = computed(() =>
    [...metas.value].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt - a.updatedAt)
  )

  const filtered = computed(() => {
    const q = query.value.trim().toLowerCase()
    // 全局常驻会话由侧边栏第一行专门渲染，不进分组/搜索。
    const withoutGlobal = sorted.value.filter(m => m.id !== GLOBAL_SESSION_ID)
    if (!q) return withoutGlobal
    // 与 Rust 侧 ranked_sessions 一致：title×5 / summary×3 / preview×1 / model×1 加权打分排序。
    // 注意：必须 Unicode 感知分词（\p{L}\p{N} 含中文 + 技术符号 +.#），
    // 不能用 ASCII 正则 [a-z0-9]，否则中文查询词会被整体拆掉。
    const terms = q.match(/[\p{L}\p{N}_+.#-]{2,}/gu) ?? []
    if (terms.length === 0) return withoutGlobal
    return withoutGlobal
      .map(m => ({ m, score: scoreSession(m, terms) }))
      .filter(x => x.score > 0)
      .sort((a, b) => b.score - a.score)
      .map(x => x.m)
  })

  /**
   * 手机端不分组：引擎给每个会话的工作目录各不相同，按目录分会变成一个会话
   * 一个折叠栏（用户看到的就是「每开一个新会话创建一个文件夹」）。改成单列表，
   * 顺序沿用 filtered 的「置顶优先 → 更新时间倒序」。
   */
  // 归档会话不进主列表：默认收起，侧栏底部「已归档」二级页里看。
  const flat = computed<SessionMeta[]>(() => filtered.value.filter(m => !m.archived))
  /** 已归档会话（按更新时间倒序，搜索时同样参与关键词过滤）。 */
  const archived = computed<SessionMeta[]>(() => filtered.value.filter(m => m.archived))

  function persist() {
    // 云端也落一份「上次看到的快照」（按设备分开）：它只用于冷启动首屏，
    // 任何一次成功的 syncFromEngine(replace) 都会整体覆盖。断线时顶部横幅
    // 已经明确说「电脑离线」，所以这不是「历史还在」的假象，而是不让列表清空。
    try {
      localStorage.setItem(metaStorageKey(context.value), JSON.stringify(metas.value))
    } catch {
      /* 配额满就放弃写入，不影响会话本身 */
    }
  }

  function find(id: string): SessionMeta | undefined {
    return metas.value.find(m => m.id === id)
  }

  /**
   * 演示模式下建/动会话只留在内存里：预览不该往真实历史里塞条目。
   * 用户主动的重命名 / 置顶 / 删除仍然照常落盘。
   */
  function persistMeta() {
    if (!isDemoMode()) persist()
  }

  /** 把会话移到某个手动分组（groupId 为 undefined 表示移出分组）。
   *  纯本地元数据，不走引擎：分组纯粹是客户端的整理偏好。 */
  function setGroup(id: string, groupId: string | undefined): void {
    const m = find(id)
    if (!m) return
    if (groupId) m.groupId = groupId
    else delete m.groupId
    persistMeta()
  }

  /** 第一条用户消息就是标题，截断到一行能放下的长度。 */
  function deriveTitle(text: string): string {
    const t = text.replace(/\s+/g, ' ').trim()
    return t.length > 42 ? t.slice(0, 42) + '…' : t || '新对话'
  }

  /** 会话检索打分：拆词后按 title/summary/preview/model 加权求和（与 Rust 侧一致）。
   *  命中次数加权：同一词出现多次分数更高；紧凑版仅在精确未命中时兜底（权重减半）。 */  function scoreSession(m: SessionMeta, terms: string[]): number {
    const hay = (s?: string) => (s ?? '').toLowerCase()
    const title = hay(m.title)
    const summary = hay(m.summary)
    const preview = hay(m.preview)
    const model = hay(m.model)
    const id = hay(m.id)
    // 紧凑版（去空白）兜底：弥补「B+ 树」与「B+树」这类空白差异，权重减半。
    const compactTitle = title.replace(/\s+/g, '')
    const compactSummary = summary.replace(/\s+/g, '')
    const compactPreview = preview.replace(/\s+/g, '')
    const count = (s: string, t: string) => s.split(t).length - 1
    return terms.reduce((acc, t) => {
      let s = 0
      const th = count(title, t)
      const sh = count(summary, t)
      const ph = count(preview, t)
      if (th > 0) s += th * 5
      else s += count(compactTitle, t) * 2
      if (sh > 0) s += sh * 3
      else s += count(compactSummary, t)
      if (ph > 0) s += ph
      else s += count(compactPreview, t)
      if (model.includes(t)) s += 1
      // uuid 片段匹配要求 ≥6 字符，避免「ab」这类 2 字符词随机命中 uuid 造成误报。
      if (t.length >= 6 && id.includes(t)) s += 1
      return acc + s
    }, 0)
  }

  function ensure(id: string, title = '新对话'): SessionMeta {
    let m = find(id)
    if (!m) {
      // 不拿项目根当会话目录：会话目录由 /api/sessions/{id}/workspace 建好后写回。
      m = { id, title, createdAt: Date.now(), updatedAt: Date.now(), turns: 0, pinned: false, cwd: undefined, mode: 'agent' }
      metas.value.unshift(m)
      persistMeta()
    }
    return m
  }

  /**
   * 会话元数据更新（标题 / 轮数）。【不再刷新 updatedAt】：
   * 排序时间 = 最后一轮 agent 的执行时间，由引擎在任务完成/中断时
   * 落盘到会话 updated_at，前端轮询合并——点击/打开会话不应改变排序。
   */
  function touch(id: string, patch: Partial<Pick<SessionMeta, 'title' | 'turns'>> = {}) {
    const m = ensure(id)
    // Automatic titles may arrive again after reconnecting or syncing with the engine.
    // Once the user has renamed a session, that explicit title always wins.
    if (patch.title && !m.renamed) m.title = patch.title
    if (patch.turns != null) m.turns = patch.turns
    persistMeta()
  }

  function setMode(id: string, mode: 'agent' | 'team' | 'life') {
    ensure(id).mode = mode
    persistMeta()
  }

  function setModel(id: string, providerId: string, model: string) {
    const meta = ensure(id)
    meta.providerId = providerId
    meta.model = model
    persistMeta()
  }

  async function rename(id: string, title: string): Promise<boolean> {
    const m = find(id)
    if (!m) return false
    const next = title.trim()
    if (!next || next === m.title) return true
    const previous = { title: m.title, renamed: m.renamed }
    m.title = next
    m.renamed = true
    persist()
    try {
      const saved = await apiSend<{ title: string; title_manually_set: boolean }>(
        `/api/sessions/${encodeURIComponent(id)}`,
        'POST',
        { title: next },
      )
      m.title = saved.title
      m.renamed = saved.title_manually_set
      persist()
      return true
    } catch {
      m.title = previous.title
      m.renamed = previous.renamed
      persist()
      return false
    }
  }

  async function togglePin(id: string): Promise<boolean> {
    const m = find(id)
    if (!m) return false
    const previous = m.pinned
    m.pinned = !previous
    // 置顶与归档互斥：从归档里恢复置顶时，引擎会清 archived，本地保持一致。
    if (m.pinned) m.archived = false
    persist()
    try {
      const saved = await apiSend<{ pinned: boolean }>(
        `/api/sessions/${encodeURIComponent(id)}`,
        'POST',
        { pinned: m.pinned },
      )
      m.pinned = saved.pinned
      persist()
      return true
    } catch {
      m.pinned = previous
      persist()
      return false
    }
  }

  /** 归档 / 取消归档。优先走引擎（跨端一致），失败回滚本地。 */
  async function setArchived(id: string, archived: boolean): Promise<boolean> {
    const m = find(id)
    if (!m) return false
    const previous = { archived: m.archived, pinned: m.pinned }
    m.archived = archived
    if (archived) m.pinned = false
    persist()
    try {
      const saved = await apiSend<{ archived?: boolean; pinned?: boolean }>(
        `/api/sessions/${encodeURIComponent(id)}`,
        'POST',
        { archived },
      )
      m.archived = saved.archived ?? archived
      m.pinned = saved.pinned ?? m.pinned
      persist()
      return true
    } catch {
      m.archived = previous.archived
      m.pinned = previous.pinned
      persist()
      return false
    }
  }

  function persistTombstones(): void {
    try {
      const now = Date.now()
      const previous = new Map(readTombstoneEntries(context.value).map(entry => [entry.id, entry.at]))
      const entries = [...deletedIds.value].map(id => ({ id, at: previous.get(id) ?? now }))
      localStorage.setItem(tombstoneKey(context.value), JSON.stringify(entries))
    } catch { /* 配额满就算了：墓碑只是防抖，不是数据本身 */ }
  }

  function addTombstone(id: string): void {
    const next = new Set(deletedIds.value)
    next.add(id)
    deletedIds.value = next
    persistTombstones()
  }

  function clearTombstone(id: string): void {
    if (!deletedIds.value.has(id)) return
    const next = new Set(deletedIds.value)
    next.delete(id)
    deletedIds.value = next
    persistTombstones()
  }

  function remove(id: string) {
    metas.value = metas.value.filter(m => m.id !== id)
    try {
      localStorage.removeItem(transcriptStorageKey(context.value, id))
    } catch {
      /* ignore */
    }
    persist()
    // 同步删除引擎磁盘上的会话记录（权威源），否则下次 syncFromEngine 时“复活”。
    // 云端只删掉手机这侧的缓存：配对令牌没有写权限，删的也是电脑端的历史。
    if (isCloudContext(context.value)) return
    // 删除请求可能失败/超时（弱网、引擎忙）。墓碑保证在引擎确认之前，
    // 轮询同步不会把这条会话重新铺回侧栏 —— 用户看到的「删了又回来」。
    addTombstone(id)
    authedFetch(`/api/sessions/${id}`, { method: 'DELETE' })
      .then(res => { if (res.ok || res.status === 404) clearTombstone(id) })
      .catch(() => { /* 保持墓碑，下次删除/重启后再试 */ })
  }

  /** Migrate pre-Rust session ids while preserving the local transcript and metadata. */
  function migrateId(oldId: string, newId: string): string {
    const meta = find(oldId)
    if (!meta) return newId
    meta.id = newId
    try {
      const transcript = localStorage.getItem(transcriptStorageKey(context.value, oldId))
      if (transcript) localStorage.setItem(transcriptStorageKey(context.value, newId), transcript)
      localStorage.removeItem(transcriptStorageKey(context.value, oldId))
    } catch {
      /* Keep the migrated metadata even if WebView storage is temporarily unavailable. */
    }
    persist()
    return newId
  }

  /** 只留最近 KEEP_TRANSCRIPTS 份时间线，老的元数据保留、正文丢弃。 */
  function pruneTranscripts() {
    const keep = new Set(sorted.value.slice(0, KEEP_TRANSCRIPTS).map(m => m.id))
    for (const m of metas.value) {
      if (keep.has(m.id)) continue
      try {
        localStorage.removeItem(transcriptStorageKey(context.value, m.id))
      } catch {
        /* ignore */
      }
    }
  }

  function saveTranscript(id: string, items: Timelineitem[]) {
    if (items.length === 0) return
    // 云端会话的正文不落手机：只留标题/预览快照（persist 那份），
    // 完整对话始终从电脑端的 /api/sessions/{id} 读。
    if (isCloudContext(context.value)) return
    // resultFull 最长 64KB/次工具调用，写进 localStorage 会很快撑爆配额；
    // 本地缓存只留短预览，展开全文由引擎会话接口提供。
    const tail = transcriptTail(items).map(item => item.kind === 'tool'
      ? { ...item, resultFull: undefined, resultTruncated: false }
      : item)
    try {
      localStorage.setItem(transcriptStorageKey(context.value, id), JSON.stringify(tail))
      pruneTranscripts()
    } catch {
      // 配额满：清掉最旧的正文再试一次，仍失败就算了
      pruneTranscripts()
      try {
        localStorage.setItem(transcriptStorageKey(context.value, id), JSON.stringify(tail))
      } catch {
        /* ignore */
      }
    }
  }

  function loadTranscript(id: string): Timelineitem[] {
    // 云端正文不落手机：历史上误写的缓存也不再读出来。
    if (isCloudContext(context.value)) return []
    try {
      const raw = localStorage.getItem(transcriptStorageKey(context.value, id))
      if (!raw) return []
      return parseTranscript(raw)
    } catch {
      return []
    }
  }

  function clearTranscript(id: string) {
    try { localStorage.removeItem(transcriptStorageKey(context.value, id)) } catch { /* ignore */ }
  }

  function clearAll() {
    const cloud = isCloudContext(context.value)
    for (const m of metas.value) {
      try {
        localStorage.removeItem(transcriptStorageKey(context.value, m.id))
      } catch {
        /* ignore */
      }
      // 同 remove()：只清本机会话记录，云端历史由电脑端自己管理。
      if (!cloud) {
        addTombstone(m.id)
        authedFetch(`/api/sessions/${m.id}`, { method: 'DELETE' })
          .then(res => { if (res.ok || res.status === 404) clearTombstone(m.id) })
          .catch(() => { /* 墓碑到期后自动失效 */ })
      }
    }
    metas.value = []
    persist()
  }

  /**
   * 从引擎磁盘拉取会话列表（权威源）并与本地元数据合并。
   * 修复“会话记录消失”：引擎重启/回放后，会话以磁盘为准重新出现；
   * 空会话（turns=0）也保留，不再被过滤。
   */
  /** 切换引擎上下文时立即清空：云端未连接时不能残留本地会话。 */
  function clearSessions(): void {
    metas.value = []
    runningIds.value = new Set()
    tasks.value = []
  }

  /**
   * 切换历史上下文（本地 ↔ 某台电脑）：换掉整份缓存，而不是把两边的会话混在一起。
   * 返回 true 表示上下文真的变了，调用方应重新拉取会话列表。
   */
  function switchContext(next: string = currentContextKey()): boolean {
    if (next === context.value) return false
    context.value = next
    metas.value = readMetas(next)
    deletedIds.value = readTombstones(next)
    runningIds.value = new Set()
    tasks.value = []
    // 不清会把上一台电脑/云端的工作目录带进本地新会话，侧栏/目录 chip 都会错。
    currentCwd.value = ''
    return true
  }

  async function syncFromEngine(options?: { replace?: boolean }): Promise<boolean> {
    /**
     * 云端读不到电脑就是「这台电脑没有可显示的历史」，比留着上一轮抄来的列表诚实；
     * 本地失败则原样保留本机缓存，不能把用户的会话弄丢。
     */
    // 失败时**不**清空列表：弱网/重连中的一次瞬时失败就会让侧栏整片消失，
    // 下一次成功又全部出现（用户看到的「会话莫名消失又恢复」）。
    // 「云端没选电脑」这种真正的空上下文由 shouldClearSessionHistory + clearSessions 负责。
    const giveUp = (): false => false
    try {
      const res = await authedFetch('/api/sessions')
      if (!res.ok) return giveUp()
      const data = await res.json()
      const remote = (data.sessions ?? []) as Array<{
        id: string
        provider_id: string
        model: string
        cwd: string
        updated_at: string
        preview: string
        title: string
        summary: string
        created_at: string
        title_manually_set: boolean
        pinned: boolean
        archived?: boolean
        mode?: 'agent' | 'team' | 'life'
      }>
      const localById = new Map(metas.value.map(m => [m.id, m]))
      const legacyMigrations: Array<Promise<unknown>> = []
      /**
       * 行对象身份要保住：syncFromEngine 每 2 秒轮询、每轮生成结束都会跑一次，
       * 每次 new 一批对象就等于把侧栏整片重建——界面上就是「啪」地闪一下。
       * 内容相同就原样复用，内容变了也只改真的变了的那几个字段。
       */
      let mutated = false
      const applyFields = (target: SessionMeta, next: SessionMeta): SessionMeta => {
        for (const key of Object.keys(next) as Array<keyof SessionMeta>) {
          if (target[key] !== next[key]) {
            Object.assign(target, { [key]: next[key] })
            mutated = true
          }
        }
        return target
      }
      const merged: SessionMeta[] = remote.map(r => {
        const local = localById.get(r.id)
        const updatedAt = Date.parse(r.updated_at) || Date.now()
        const createdAt = local?.createdAt ?? (Date.parse(r.created_at) || updatedAt)
        const legacyTitle = !r.title_manually_set && local?.renamed
          ? (isPlanModeTitle(local.title) ? undefined : local.title)
          : undefined
        const legacyPinned = !r.pinned && local?.pinned ? true : undefined
        // 旧引擎可能把计划模式前缀写进标题/预览（标题还被截断过，无法按完整前缀剥离）。
        const remoteTitle = isPlanModeTitle(r.title) ? '' : r.title
        const localTitle = isPlanModeTitle(local?.title ?? '') ? '' : (local?.title ?? '')
        const preview = stripPlanModePrefix(r.preview || local?.preview || '')
        if (legacyTitle !== undefined || legacyPinned !== undefined) {
          legacyMigrations.push(apiSend(
            `/api/sessions/${encodeURIComponent(r.id)}`,
            'POST',
            {
              ...(legacyTitle !== undefined ? { title: legacyTitle } : {}),
              ...(legacyPinned !== undefined ? { pinned: true } : {}),
              ...(r.archived !== undefined ? { archived: r.archived } : {}),
            },
          ))
        }
        const next: SessionMeta = {
          id: r.id,
          title: r.title_manually_set
            ? r.title
            : (legacyTitle || remoteTitle || localTitle || (preview ? deriveTitle(preview) : '新对话')),
          createdAt,
          updatedAt,
          // 引擎列表不返回轮数。绝不能一律写 0：readMetas 会把「turns=0 且标题=新对话」
          // 当成空草稿丢掉 —— 重启后最近会话会从侧栏消失，等下一次引擎同步才「复活」。
          // 有标题或首条预览就说明这条会话有真实内容。
          turns: local?.turns ?? (preview || r.title ? 1 : 0),
          pinned: r.pinned || Boolean(legacyPinned),
          archived: Boolean(r.archived),
          cwd: r.cwd || local?.cwd,
          summary: r.summary || local?.summary,
          preview,
          model: r.model || local?.model,
          providerId: r.provider_id || local?.providerId,
          renamed: r.title_manually_set || Boolean(legacyTitle),
          mode: r.mode ?? local?.mode ?? 'agent',
        }
        return local ? applyFields(local, next) : next
      })
      // 本地有而引擎暂无的（旧迁移 ID 等）保留，避免吞掉用户数据。
      // 云端模式必须 replace：列表只能来自电脑，否则会混进本地会话。
      if (!options?.replace) {
        const remoteIds = new Set(merged.map(m => m.id))
        for (const m of metas.value) {
          if (!remoteIds.has(m.id)) merged.push(m)
        }
      }
      // 已删但引擎还没确认删掉的：不允许被同步带回来。
      const alive = deletedIds.value.size > 0
        ? merged.filter(meta => !deletedIds.value.has(meta.id))
        : merged
      // 内容没变就不换数组引用：metas 一变，sorted/filtered/flat 与整张侧栏全部重算。
      // 轮询/切页回来时这一步占大头（对象身份已经在上面保住了，这里只是收口）。
      const sameShape = alive.length === metas.value.length
        && alive.every((meta, index) => meta === metas.value[index])
      if (mutated || !sameShape) {
        metas.value = alive
        persist()
      }
      if (legacyMigrations.length > 0) void Promise.allSettled(legacyMigrations)
      return true
    } catch {
      return giveUp()
    }
  }

  return {
    metas, query, sorted, filtered, flat, archived, currentCwd, setCurrentCwd, context,
    enginePaths, setEnginePaths,
    tasks, runningIds, taskConcurrencyLimit, refreshTasks, cancelTask, taskAction, taskDetail,
    syncFromEngine, clearSessions, switchContext,
    ensure, touch, setMode, setModel, rename, togglePin, setArchived, remove, find, deriveTitle, setGroup,
    saveTranscript, loadTranscript, clearTranscript, migrateId, clearAll,
    refreshRunning, isRunning, markRunning,
  }
})
