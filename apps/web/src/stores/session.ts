import { defineStore } from 'pinia'
import { ref, computed, shallowRef, watch } from 'vue'
import { createTransport, type Transport } from '@/bridge'
import { authedFetch, apiGet, isCloudConnectionMode } from '@/bridge/http'
import { isDemoMode } from '@/bridge/demoMode'
import type { AgentEvent, PlanStepItem } from '@/protocol/events'
import type { ReasoningEffortStats } from '@/protocol/events'
import type { ReasoningEffort } from '@/protocol/commands'
import type { InboundEnvelope } from '@/protocol/commands'
import { nextId } from '@/bridge/envelope'
import { createSeqGate, readEventSeq } from '@/utils/eventSeq'
import { flushHydrationOnOpen } from '@/utils/hydration'
import { turnBlockReason } from '@/utils/sendGuard'
import { configPromptFor, type ConfigPrompt } from '@/utils/configPrompt'
import { stripPlanModePrefix } from '@/utils/planPrefix'
import { resetTransientUiState } from '@/utils/processState'
import { useConnectionStore } from './connection'
import { useConfigStore } from './config'
import { useSessionsStore } from './sessions'
import { isGlobalSession as isGlobalSessionId } from '@/bridge/life'
import { router } from '@/router'
import {
  hasValidConsent,
  writeConsent,
  readConsent,
  normalizeFlavor,
  experimentsToSegments,
  REVERSE_CONSENT_VERSION,
  type ReverseFlavor,
} from '@/utils/reverseMode'
import type { AssistantMessage, LoopProgress, QuestionCard, ReasoningBlock, RunState, Timelineitem, ToolCard, ToolDiagnosticTrace, TurnAction, TurnFileChange, UserMessage } from './viewModel'

/** 附件文件 chip 类型 */
export interface AttachedFile {
  id: string
  path: string
  name: string
  size: number
  mimeType?: string
  isDir?: boolean
}

/** 本轮被中断（上游不可用 / 工具轮次用尽）时引擎发来的可操作现场。 */
export interface RetryConfirmationState {
  message: string
  detail?: string
  reason?: string
  roundsUsed: number | null
  roundsLimit: number | null
  lastTool: string
  resumable: boolean
}



export const useSessionStore = defineStore('session', () => {
  const connection = useConnectionStore()
  const config = useConfigStore()
  const sessions = useSessionsStore()

  const sessionId = ref(readActiveSessionId())
  const mode = ref<'agent' | 'team' | 'life'>(sessions.find(sessionId.value)?.mode ?? 'agent')
  const timeline = ref<Timelineitem[]>(sessions.loadTranscript(sessionId.value))
  const runState = ref<RunState>('idle')
  /**
   * 正在打开另一条会话（历史尚未落位/尚未量完）。渲染层据此把列表先遮住，
   * 等测量稳定再揭幕 —— 否则用户会看到旧列表残留、新列表逐条蹦出来。
   */
  const restoring = ref(false)
  /** 打开会话的代数：异步恢复回来时代数已变 = 用户又切走了，这轮结果必须丢弃。 */
  let openEpoch = 0
  /** 引擎历史恢复的最长等待：超过就先拿本机缓存顶上，不让切会话被慢 HTTP 拖住。 */
  const RESTORE_TIMEOUT_MS = 2500
  const usage = ref<{
    total: number; input: number; output: number; contextRatio: number
    contextUsed: number; contextWindow: number
    cachedInput: number; cacheHitRate: number | null; cacheDataAvailable: boolean
    turnCacheHitRate: number | null; turnCacheDataAvailable: boolean
    reasoningEfforts: Partial<Record<ReasoningEffort, ReasoningEffortStats>>
    contextCategories: Partial<Record<'system_tools' | 'messages' | 'skills' | 'mcp_tools' | 'system_prompt' | 'other', number>>
    firstTokenLatencyMs: number | null
    outputTokensPerSecond: number | null
    turnTotalTokens: number | null
  } | null>(null)
  /**
   * 会话计时（引擎口径，毫秒）。
   * 以前是用 `Date.now() - createdAt` 减工具耗时推出来的：那是会话档案年龄
   * （停着不动也涨），而且工具耗时是秒 —— 两项相减之后「LLM 用时」永远等于总时长。
   * 现在只累加引擎在 turn_end 给的真实值，切会话时用 /timing 校准。
   */
  const timing = ref<{ elapsedMs: number; llmMs: number; toolMs: number; turns: number } | null>(null)
  let timingEpoch = 0
  const timingRefreshTimer = { value: null as ReturnType<typeof setTimeout> | null }

  async function refreshTiming(id: string) {
    const epoch = ++timingEpoch
    try {
      const data = await apiGet<{
        available?: boolean; elapsed_ms?: number; llm_ms?: number; tool_ms?: number; turns?: number
      }>(`/api/sessions/${encodeURIComponent(id)}/timing`)
      if (epoch !== timingEpoch || id !== sessionId.value) return
      if (!data?.available) { timing.value = null; return }
      timing.value = {
        elapsedMs: data.elapsed_ms ?? 0,
        llmMs: data.llm_ms ?? 0,
        toolMs: data.tool_ms ?? 0,
        turns: data.turns ?? 0,
      }
    } catch { /* 引擎离线：保留上一次的值，不把 0 当成真实结果 */ }
  }

  /** 本轮结束：先按事件累加（即时），再延迟向引擎校准（权威）。 */
  function addTurnTiming(elapsedMs: number | undefined, llmMs: number | undefined, toolMs: number | undefined) {
    if (typeof elapsedMs !== 'number') return
    const prev = timing.value
    timing.value = {
      elapsedMs: (prev?.elapsedMs ?? 0) + elapsedMs,
      llmMs: (prev?.llmMs ?? 0) + (llmMs ?? 0),
      toolMs: (prev?.toolMs ?? 0) + (toolMs ?? 0),
      turns: (prev?.turns ?? 0) + 1,
    }
    if (timingRefreshTimer.value) clearTimeout(timingRefreshTimer.value)
    const id = sessionId.value
    timingRefreshTimer.value = setTimeout(() => { void refreshTiming(id) }, 600)
  }

  /** 本轮被中断的现场（retry_confirmation 事件）：可操作卡片的数据源。 */
  const retryConfirmation = ref<RetryConfirmationState | null>(null)
  /** 当前会话的工作目录（会话标记路径，绑定为会话执行目录）。 */
  const cwd = ref('')
  const loop = ref<LoopProgress>({ active: false, currentStep: 0, totalSteps: 0, status: '' })
  /**
   * 计划的完整步骤（来自引擎 plan_updated）。空数组表示这一轮没有计划。
   * loop 仍保留给「第 N / 共 M 步」这种旧展示；胶囊以 plan 为准。
   */
  const plan = ref<{ steps: PlanStepItem[]; completed: number; total: number; explanation: string }>(
    { steps: [], completed: 0, total: 0, explanation: '' },
  )
  const collaboration = ref({ active: false, phase: '', cycle: 0, cycles: 0, status: '', review: '' })
  /** 当前会话已添加的文件附件（显示为 chip，发送时自动引用）。 */
  const attachedFiles = ref<AttachedFile[]>([])

  function addAttachedFile(path: string) {
    const id = `f_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const parts = path.split('/')
    const name = parts[parts.length - 1] || path
    const isDir = path.endsWith('/') || name.indexOf('.') < 0
    // 同步获取文件大小：优先 Android 原生桥
    let size = 0
    if (typeof window !== 'undefined' && (window as any).CoomiAndroid?.getFileSize) {
      try { size = (window as any).CoomiAndroid.getFileSize(path) ?? 0 } catch { /* ignore */ }
    }
    const entry: AttachedFile = { id, path, name, size, isDir }
    attachedFiles.value.push(entry)
    // 异步回退：如果原生桥没拿到大小，通过 API 获取后更新
    if (size === 0 && typeof window !== 'undefined' && (window as any).CoomiBridge?.fetch) {
      ;(window as any).CoomiBridge.fetch(`/api/fs/get?path=${encodeURIComponent(path)}`)
        .then((r: any) => r.json().then((d: any) => {
          if (d.size != null && d.size > 0) {
            entry.size = d.size
            // 触发响应式更新
            attachedFiles.value = [...attachedFiles.value]
          }
        }))
        .catch(() => { /* stat 失败也无所谓，显示 0 B */ })
    }
  }

  function removeAttachedFile(id: string) {
    const idx = attachedFiles.value.findIndex(f => f.id === id)
    if (idx >= 0) attachedFiles.value.splice(idx, 1)
  }

  function clearAttachedFiles() {
    attachedFiles.value = []
  }

  /** 生命体待投递问候（队列唯一 pending → 气泡/开场问候的数据源）。 */
  const lifeUnread = ref<LifeUnreadItem[]>([])
  const lifeUnreadName = ref('')
  const lifeDelivering = ref(false)
  /** 本次打开会话是否已做过开场问候（避免轮询重复触发投递）。 */
  let lifeAutoSent = false
  /** 编辑覆盖状态：非空表示输入框正处于「编辑上一条消息」模式。 */
  const pendingEdit = ref<{ mid: string; content: string } | null>(null)
  /** 编辑重发前保留的旧版本分支（点开即切過去）。 */
  const branchNotice = ref<{ id: string; title: string } | null>(null)
  const branchSaving = ref(false)
  /** 回撤确认弹窗状态：非空表示等待用户确认回撤该轮。 */
  const undoConfirm = ref<{ mid: string } | null>(null)

  /**
   * 正在收字的那条助手消息。用 shallowRef 而不是裸 let：渲染层（逐字揭示 / 折叠栏）
   * 要能**响应式地**知道「引擎现在在往哪条消息上追加」—— 这是"哪条在生成"的唯一
   * 权威证据。真机上 isBusy 偶尔不置位，只靠它判活会把流式正文整段放出来。
   * shallowRef 不深包：值本身就是从 timeline 里取出来的响应式代理，改它照样触发渲染。
   */
  const currentAssistant = shallowRef<AssistantMessage | null>(null)
  let connectedSessionId = ''
  let persistTimer: ReturnType<typeof setTimeout> | null = null
  let turnToolTrace: ToolDiagnosticTrace[] = []
  let consecutiveToolFailures = 0
  let maxConsecutiveToolFailures = 0
  let failureNoticeCreated = false
  const transport = shallowRef<Transport | null>(null)
  // ── 事件顺序门（移动网络下收益最大）：见 connect() 与 applyEvent ──
  /** 只把严格连续递增的 event_seq 交给 applyEvent：重复帧丢弃、缺口帧暂存等补帧。 */
  const seqGate = createSeqGate<AgentEvent>()
  /** 顺序门当前绑定的会话：换会话必须复位（新会话的 event_seq 从 1 重新起）。 */
  let gateSessionId = ''
  /** 已按序处理到的 seq（= 已确认游标）。 */
  let ackedSeq = 0
  /** 上一次真正发出去的 ack，避免周期性 ack 空转。 */
  let lastSentAck = 0
  /** 距上次 ack 已处理的事件数：满 50 条就提前 ack 一次。 */
  let ackBatch = 0
  let ackTimer: ReturnType<typeof setInterval> | null = null
  const ACK_BATCH = 50
  const ACK_INTERVAL_MS = 5000
  /** 新连接上的第一帧：用来识别「引擎重启后 event_seq 从 1 重新计数」（与桌面端同机制）。 */
  let firstEventOnConnection = false
  /** resync 最小间隔：缺口可能连着来好几帧，不能每帧都发一条（补帧在途时也无需重复请求）。 */
  let resyncRequestedAt = 0
  const RESYNC_MIN_INTERVAL_MS = 500

  // ── 后台会话：per-session 传输（多会话同时流式） ──────────────────────
  //
  // 引擎按会话并行跑任务，但前端只有一条 WS：切走的会话虽然还在跑，事件却没人
  // 接收、没人 ack，切回来只能整段回读，看起来像「不能并行」。这里给每个仍在跑
  // 的会话保留自己的连接：切走时不关，后台继续收事件、ack、更新一份时间线并落盘；
  // 切回时直接复用同一条连接继续收流，不再重连/重放。
  interface BackgroundWorker {
    id: string
    transport: Transport
    timeline: Timelineitem[]
    usage: SessionUsage | null
    loop: LoopProgress
    retry: RetryConfirmationState | null
    banner: string
    runState: RunState
    /** false = 已被前台收回，后台 handler 立刻停止写入。 */
    active: boolean
    ackSeq: number
    createdAt: number
    persistTimer: ReturnType<typeof setInterval> | null
    ackTimer: ReturnType<typeof setInterval> | null
    closeTimer: ReturnType<typeof setTimeout> | null
  }
  type SessionUsage = NonNullable<typeof usage.value>

  const backgroundWorkers = new Map<string, BackgroundWorker>()
  const MAX_BACKGROUND_WORKERS = 4
  const WORKER_ACK_MS = 5000
  const WORKER_PERSIST_MS = 15000
  const WORKER_LINGER_MS = 10000

  function bgAppendAssistant(worker: BackgroundWorker, chunk: string): void {
    if (!chunk) return
    const last = worker.timeline[worker.timeline.length - 1]
    if (last?.kind === 'assistant' && last.streaming) { last.content += chunk; return }
    worker.timeline.push({ kind: 'assistant', id: nextId(), mid: '', content: chunk, streaming: true, startedAt: Date.now() })
  }
  function bgEndAssistant(worker: BackgroundWorker): void {
    for (let i = worker.timeline.length - 1; i >= 0; i--) {
      const item = worker.timeline[i]
      if (item.kind !== 'assistant') continue
      if (item.streaming) { item.streaming = false; item.endedAt = Date.now() }
      break
    }
  }
  function bgAppendReasoning(worker: BackgroundWorker, content: string): void {
    if (!content) return
    const last = worker.timeline[worker.timeline.length - 1]
    if (last?.kind === 'reasoning') { last.content += content; return }
    worker.timeline.push({ kind: 'reasoning', id: nextId(), content, expanded: false })
  }
  function bgPatchTool(worker: BackgroundWorker, callId: string, fn: (card: ToolCard) => void): boolean {
    for (let i = worker.timeline.length - 1; i >= 0; i--) {
      const item = worker.timeline[i]
      if (item.kind === 'tool' && item.callId === callId) { fn(item); return true }
    }
    return false
  }
  function bgPushNotice(worker: BackgroundWorker, tone: 'info' | 'warn' | 'error' | 'success', text: string): void {
    if (!text.trim()) return
    worker.timeline.push({ kind: 'notice', id: nextId(), tone, text })
  }

  /**
   * 后台事件的精简归约：只维护「切回去要立刻看到的内容」。
   * 审批/提问/重试等交互仍以引擎侧为准，切回时 restoreFromEngine 或用户操作会补齐；
   * 这里不复制前台的全部副作用（通知去重、端到端接力、逆向模式等）。
   */
  function bgApplyEvent(worker: BackgroundWorker, ev: AgentEvent): void {
    switch (ev.event_type) {
      case 'text_chunk':
        if (!String(ev.content ?? '')) break
        if (worker.runState === 'idle') worker.runState = 'thinking'
        bgAppendAssistant(worker, ev.content)
        break
      case 'reasoning_chunk':
        if (worker.runState === 'idle') worker.runState = 'thinking'
        bgAppendReasoning(worker, ev.content)
        break
      case 'tool_start':
        bgEndAssistant(worker)
        worker.timeline.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'starting' })
        worker.runState = 'executing'
        break
      case 'tool_running':
        bgPatchTool(worker, ev.call_id, card => { card.status = 'running' })
        worker.runState = 'executing'
        break
      case 'tool_done':
        bgPatchTool(worker, ev.call_id, card => {
          card.status = ev.is_error ? 'error' : 'success'
          card.elapsed = ev.elapsed
          card.resultPreview = ev.result_preview
          card.resultFull = ev.result_full ?? ev.result_preview
          card.resultTruncated = ev.result_truncated === true
          card.isError = ev.is_error
          if (Array.isArray(ev.images) && ev.images.length > 0) card.images = ev.images
        })
        worker.runState = 'thinking'
        break
      case 'tool_cache_hit':
        bgPatchTool(worker, ev.call_id, card => { card.status = 'cache_hit' })
        break
      case 'tool_approval_request':
        bgEndAssistant(worker)
        if (!bgPatchTool(worker, ev.call_id, card => {
          card.status = 'awaiting_approval'; card.access = ev.access; card.riskSummary = ev.risk_summary
        })) {
          worker.timeline.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'awaiting_approval', access: ev.access, riskSummary: ev.risk_summary })
        }
        worker.runState = 'awaiting_approval'
        break
      case 'user_question_request':
        bgEndAssistant(worker)
        worker.timeline.push({ kind: 'question', callId: ev.call_id, questions: ev.questions, answered: false })
        worker.runState = 'awaiting_question'
        break
      case 'usage_update': {
        const previous = worker.usage
        worker.usage = {
          total: ev.usage.total_tokens ?? previous?.total ?? 0,
          input: ev.usage.input_tokens ?? previous?.input ?? 0,
          output: ev.usage.output_tokens ?? previous?.output ?? 0,
          contextRatio: ev.usage.context_ratio ?? previous?.contextRatio ?? 0,
          contextUsed: ev.usage.context_used_tokens ?? previous?.contextUsed ?? 0,
          contextWindow: ev.usage.context_window_tokens ?? previous?.contextWindow ?? 0,
          cachedInput: ev.usage.cached_input_tokens ?? previous?.cachedInput ?? 0,
          cacheHitRate: ev.usage.cache_hit_rate ?? previous?.cacheHitRate ?? null,
          cacheDataAvailable: ev.usage.cache_data_available ?? previous?.cacheDataAvailable ?? false,
          turnCacheHitRate: ev.usage.turn_cache_hit_rate ?? previous?.turnCacheHitRate ?? null,
          turnCacheDataAvailable: ev.usage.turn_cache_data_available ?? previous?.turnCacheDataAvailable ?? false,
          reasoningEfforts: ev.reasoning_efforts ?? previous?.reasoningEfforts ?? {},
          contextCategories: ev.context_categories ?? previous?.contextCategories ?? {},
          firstTokenLatencyMs: ev.usage.first_token_latency_ms === undefined ? previous?.firstTokenLatencyMs ?? null : ev.usage.first_token_latency_ms,
          outputTokensPerSecond: ev.usage.output_tokens_per_second === undefined ? previous?.outputTokensPerSecond ?? null : ev.usage.output_tokens_per_second,
          turnTotalTokens: ev.usage.turn_total_tokens === undefined ? previous?.turnTotalTokens ?? null : ev.usage.turn_total_tokens,
        }
        break
      }
      case 'compression':
        bgPushNotice(worker, 'info', `上下文已压缩 ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)}`)
        break
      case 'loop_progress':
        worker.loop = { active: ev.status !== 'done', currentStep: ev.current_step, totalSteps: ev.total_steps, status: ev.status, currentDescription: worker.loop.currentDescription }
        break
      case 'loop_step_start':
        worker.loop = { ...worker.loop, active: true, totalSteps: ev.total_steps, currentStep: ev.step_index, currentDescription: ev.step_description }
        break
      case 'turn_notice':
        if (ev.kind === 'empty-response-retry' || ev.kind === 'empty-output' || ev.kind === 'upstream-error' || ev.kind === 'turn-budget') {
          bgPushNotice(worker, 'warn', ev.message)
        } else if (ev.kind === 'compaction') {
          bgPushNotice(worker, 'info', ev.message)
        }
        break
      case 'agent_error':
        bgEndAssistant(worker)
        bgPushNotice(worker, 'error', ev.message)
        worker.banner = String(ev.message || '')
        if (ev.is_fatal) worker.runState = 'idle'
        break
      case 'agent_cancelled':
        bgEndAssistant(worker)
        for (const item of worker.timeline) {
          if (item.kind === 'tool' && (item.status === 'running' || item.status === 'starting')) item.status = 'cancelled'
        }
        bgPushNotice(worker, 'warn', '已停止本轮执行')
        worker.runState = 'idle'
        break
      case 'stream_reset':
        bgEndAssistant(worker)
        while (worker.timeline.length > 0) {
          const last = worker.timeline[worker.timeline.length - 1]
          if (last.kind === 'assistant' || last.kind === 'reasoning') worker.timeline.pop()
          else break
        }
        break
      case 'retry_confirmation':
        bgEndAssistant(worker)
        worker.runState = 'idle'
        worker.retry = {
          message: ev.message,
          detail: ev.detail,
          reason: ev.reason,
          roundsUsed: typeof ev.rounds_used === 'number' ? ev.rounds_used : null,
          roundsLimit: typeof ev.rounds_limit === 'number' ? ev.rounds_limit : null,
          lastTool: typeof ev.last_tool === 'string' ? ev.last_tool : '',
          resumable: ev.resumable !== false,
        }
        break
      case 'life_delivered': {
        const last = worker.timeline[worker.timeline.length - 1]
        if (last?.kind === 'assistant') last.life = true
        break
      }
      case 'turn_end':
        addTurnTiming(ev.elapsed_ms, ev.llm_ms, ev.tool_ms)
        bgEndAssistant(worker)
        for (const item of worker.timeline) {
          if (item.kind === 'tool' && (item.status === 'running' || item.status === 'starting')) item.status = 'cancelled'
        }
        worker.runState = 'idle'
        sessions.markRunning(worker.id, false)
        bgPersist(worker)
        if (typeof document !== 'undefined' && document.visibilityState !== 'visible') {
          window.CoomiAndroid?.notifyUser?.('Coomi 任务完成', '点开继续对话', worker.id)
        }
        // 轮已结束：再留 10 秒收尾（usage 等尾帧），之后释放连接。
        if (worker.closeTimer) clearTimeout(worker.closeTimer)
        worker.closeTimer = setTimeout(() => closeBackgroundWorker(worker.id), WORKER_LINGER_MS)
        break
      default:
        break
    }
  }

  function bgPersist(worker: BackgroundWorker): void {
    if (isDemoMode()) return
    const persisted = worker.timeline.filter(item => item.kind !== 'notice')
    if (persisted.length === 0) return
    sessions.saveTranscript(worker.id, persisted)
    sessions.touch(worker.id, { turns: persisted.filter(item => item.kind === 'user').length })
  }

  function startBackgroundWorker(
    id: string,
    t: Transport,
    snapshot: Timelineitem[],
    snapshotUsage: SessionUsage | null,
    snapshotRunState: RunState,
    snapshotLoop: LoopProgress,
    snapshotRetry: RetryConfirmationState | null,
    snapshotBanner: string,
  ): void {
    if (backgroundWorkers.has(id)) return
    // 上限之外的先关最旧的：连接数受控，切回时按需重连即可。
    if (backgroundWorkers.size >= MAX_BACKGROUND_WORKERS) {
      const oldest = [...backgroundWorkers.values()].sort((a, b) => a.createdAt - b.createdAt)[0]
      if (oldest) closeBackgroundWorker(oldest.id)
    }
    const worker: BackgroundWorker = {
      id, transport: t, timeline: snapshot, usage: snapshotUsage, loop: snapshotLoop,
      retry: snapshotRetry, banner: snapshotBanner, runState: snapshotRunState,
      active: true, ackSeq: 0, createdAt: Date.now(), persistTimer: null, ackTimer: null, closeTimer: null,
    }
    backgroundWorkers.set(id, worker)
    if (worker.runState !== 'idle') sessions.markRunning(id, true)
    t.onMessage(env => {
      if (!worker.active || env.type !== 'event') return
      const seq = readEventSeq(env.payload as unknown as Record<string, unknown>)
      if (seq != null) worker.ackSeq = Math.max(worker.ackSeq, seq)
      bgApplyEvent(worker, env.payload as AgentEvent)
    })
    worker.persistTimer = setInterval(() => bgPersist(worker), WORKER_PERSIST_MS)
    worker.ackTimer = setInterval(() => {
      if (worker.active && worker.ackSeq > 0) worker.transport.send({ command: 'ack', seq: worker.ackSeq })
    }, WORKER_ACK_MS)
  }

  /** 把当前正在跑的会话交给后台：保留连接与时间线，不发 switch_session、不 close。 */
  function detachCurrentToBackground(): boolean {
    const id = sessionId.value
    const t = transport.value
    if (!id || !t || connectedSessionId !== id || !isBusy.value) return false
    startBackgroundWorker(id, t, timeline.value.slice(), usage.value, runState.value,
      { ...loop.value }, retryConfirmation.value ? { ...retryConfirmation.value } : null, errorBanner.value ?? '')
    transport.value = null
    connectedSessionId = ''
    return true
  }

  /** 取回后台会话的连接与时间线；返回 null 表示它不在后台。 */
  function adoptBackgroundWorker(id: string): BackgroundWorker | null {
    const worker = backgroundWorkers.get(id)
    if (!worker) return null
    worker.active = false
    if (worker.persistTimer) { clearInterval(worker.persistTimer); worker.persistTimer = null }
    if (worker.ackTimer) { clearInterval(worker.ackTimer); worker.ackTimer = null }
    if (worker.closeTimer) { clearTimeout(worker.closeTimer); worker.closeTimer = null }
    backgroundWorkers.delete(id)
    if (worker.ackSeq > 0) worker.transport.send({ command: 'ack', seq: worker.ackSeq })
    return worker
  }

  function closeBackgroundWorker(id: string): void {
    const worker = backgroundWorkers.get(id)
    if (!worker) return
    backgroundWorkers.delete(id)
    worker.active = false
    if (worker.persistTimer) { clearInterval(worker.persistTimer); worker.persistTimer = null }
    if (worker.ackTimer) { clearInterval(worker.ackTimer); worker.ackTimer = null }
    if (worker.closeTimer) { clearTimeout(worker.closeTimer); worker.closeTimer = null }
    bgPersist(worker)
    if (worker.ackSeq > 0) worker.transport.send({ command: 'ack', seq: worker.ackSeq })
    if (worker.runState === 'idle') sessions.markRunning(id, false)
    worker.transport.close()
  }

  function closeAllBackgroundWorkers(): void {
    for (const id of [...backgroundWorkers.keys()]) closeBackgroundWorker(id)
  }

  function isBackgroundRunning(id: string): boolean {
    const worker = backgroundWorkers.get(id)
    return Boolean(worker && worker.runState !== 'idle')
  }


  // syncing 是「正在恢复历史」的等待窗口，不是一轮生成：这段时间不能亮「停止」，
  // 也不能让状态条显示运行中，否则切会话会闪一下“正在思考”。
  const isBusy = computed(() => runState.value !== 'idle' && runState.value !== 'syncing')
  /**
   * 正在收字的那条助手消息（ currentAssistant 指针本身，带失效校验）。
   * 切会话 / 时间线整表重建后旧指针已不在数组里，此时返回 null ——
   * 恢复出来的历史消息因此绝不会被当成「在生成」（硬要求：历史不重播逐字动画）。
   */
  const activeAssistant = computed<AssistantMessage | null>(() => {
    const cur = currentAssistant.value
    if (!cur) return null
    const items = timeline.value
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i]
      if (item.kind === 'assistant') return item === cur ? cur : null
    }
    return null
  })
  /** activeAssistant 的 id 形式（渲染层比对用的稳定键）。 */
  const activeAssistantId = computed(() => activeAssistant.value?.id ?? '')
  /**
   * 会话里还有没有正在生成的正文：runState 处于生成态（不含 syncing），
   * 或末位助手消息还没收尾。第二条是给「runState 没跟上」的真机留的兜底。
   * 两条都不成立（= 本轮真的结束了 / 只是切会话）时，渲染层据此切正式 markdown、
   * 把过程栏收起来。
   */
  const streamActive = computed(() => isBusy.value || activeAssistantId.value !== '')
  const pendingApproval = computed(() => timeline.value.find((t): t is ToolCard => t.kind === 'tool' && t.status === 'awaiting_approval'))
  const pendingQuestion = computed(() => timeline.value.find((t): t is QuestionCard => t.kind === 'question' && !t.answered))
  /** 时间线里最新的用户消息（仅它可「编辑重发」）。 */
  const lastUserMessage = computed(() => {
    for (let i = timeline.value.length - 1; i >= 0; i--) {
      if (timeline.value[i].kind === 'user') return timeline.value[i]
    }
    return null
  })
  /** 时间线里最新的助手消息（仅它可「回撤」）。 */
  const lastAssistantMessage = computed(() => {
    for (let i = timeline.value.length - 1; i >= 0; i--) {
      if (timeline.value[i].kind === 'assistant') return timeline.value[i]
    }
    return null
  })

  persistActiveSessionId(sessionId.value)
  if (typeof window !== 'undefined') {
    ;(window as Window & { __coomiActiveSessionId?: string }).__coomiActiveSessionId = sessionId.value
  }

  // Native task status is derived from /api/tasks in the sessions store. A
  // foreground idle session must not overwrite another session's running state.

  /** 通道没打开就别把消息写进时间线：静默丢弃只会被当成「引擎卡住」。 */
  const turnBlock = computed(() => turnBlockReason({ state: connection.state, hasTransport: transport.value !== null, demo: connection.demo }))
  function blockTurn(): boolean {
    if (!turnBlock.value) return false
    pushNotice('error', turnBlock.value)
    return true
  }

  /**
   * 引擎说「还没有可用的模型配置」时的挂起提示。
   * 旧代码在这里直接 router.push——用户正在别的页面打字，页面自己跳走，
   * 看着就像 bug；云端模式下这条事件还是对面那台电脑发来的。
   * 现在只把话和入口挂出来，走不走由用户按。
   */
  const configPrompt = ref<ConfigPrompt | null>(null)
  /** 厂商/引擎错误（429/500 等）的粘性提示：时间线里的 notice 会滚走，这条贴住输入框。 */
  const errorBanner = ref<string | null>(null)
  /** 本轮是否真的产生过正文；turn_end 用它兜底“空回复却显示成功”。 */
  let turnHadAssistantText = false
  function dismissErrorBanner(): void { errorBanner.value = null }
  function configureModel(): void {
    const route = configPrompt.value?.action?.route
    configPrompt.value = null
    if (route) void router.push(route)
  }
  function dismissConfigPrompt(): void { configPrompt.value = null }

  /** 发送内置引导（EmptyState 引导卡）：先置用户标题消息，再让引擎流式推正文。 */
  const GUIDE_TITLES: Record<string, string> = {
    newbie: 'CoomiPlus 新手使用指南',
    extension: '自定义拓展进化指南',
  }
  function sendGuide(key: string) {
    if (blockTurn()) return
    const trimmed = (GUIDE_TITLES[key] ?? 'CoomiPlus 指南').trim()
    // 仅在「新对话」且非全局/已命名时自动取标题；常驻会话不被覆盖。
    const isFirst = !timeline.value.some(t => t.kind === 'user')
    if (isFirst) maybeAutoTitle(trimmed)
    timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed })
    runState.value = 'thinking'
    transport.value?.send({ command: 'send_guide', key })
    persistSoon()
  }

  /** 常驻/已命名会话不自动改名。 */
  function maybeAutoTitle(text: string) {
    if (isGlobalSessionId(sessionId.value)) return
    const meta = sessions.ensure(sessionId.value)
    if (meta.renamed) return
    if (meta.title && meta.title !== '新对话') return
    sessions.touch(sessionId.value, { title: sessions.deriveTitle(text) })
  }

  /** 时间线写回 localStorage 有节流：流式期间不要每个 chunk 都序列化。 */
  function persistSoon() {
    flushAssistantPending()
    if (isDemoMode()) return // 演示内容不该混进真实历史
    if (persistTimer) return
    persistTimer = setTimeout(() => {
      persistTimer = null
      // 落盘前过滤 notice：提示是“派生显示”，不是会话内容。
      // 存进去会在下次历史恢复时被当作时间线的一部分再叠加一条，越恢复越多。
      const persisted = timeline.value.filter(t => t.kind !== 'notice')
      if (persisted.length === 0) return
      sessions.touch(sessionId.value, { turns: persisted.filter(t => t.kind === 'user').length })
      sessions.saveTranscript(sessionId.value, persisted)
    }, 1200)
  }

  function flushPersistence() {
    flushAssistantPending()
    if (persistTimer) {
      clearTimeout(persistTimer)
      persistTimer = null
    }
    if (isDemoMode()) return
    const persisted = timeline.value.filter(t => t.kind !== 'notice')
    if (persisted.length === 0) return
    sessions.touch(sessionId.value, { turns: persisted.filter(t => t.kind === 'user').length })
    sessions.saveTranscript(sessionId.value, persisted)
  }

  /** 复位事件游标（换会话 / 引擎重启）：新进程的 event_seq 从 1 重新起。 */
  function resetEventStream() {
    seqGate.reset()
    ackedSeq = 0
    lastSentAck = 0
    ackBatch = 0
    resyncRequestedAt = 0
    // 复位后下一个到达的事件就是「新坐标系」的第一帧（与桌面端同一约定）。
    firstEventOnConnection = true
  }

  /**
   * 请求补帧：把本地「已按序处理到的最后一条」报给引擎，它按原顺序重发之后所有未确认事件。
   * force=true 用于「刚重连」这一次：必须发，不能被节流拦住；缺口触发的那几次才需要节流。
   */
  function requestResync(force = false) {
    if (!transport.value) return
    const last = seqGate.last()
    // last=0 没有可补的基线（引擎的 seq 可能早已涨过），补帧反而会把整段历史再灌一遍。
    if (last <= 0) return
    const now = Date.now()
    if (!force && now - resyncRequestedAt < RESYNC_MIN_INTERVAL_MS) return
    resyncRequestedAt = now
    transport.value.send({ command: 'resync', after_seq: last })
  }

  /** 把已处理游标确认给引擎，让它裁剪未确认队列。批量满 / 定时都会调。 */
  function flushAck(force: boolean) {
    if (!transport.value || ackedSeq <= lastSentAck) return
    if (!force && ackBatch < ACK_BATCH) return
    transport.value.send({ command: 'ack', seq: ackedSeq })
    lastSentAck = ackedSeq
    ackBatch = 0
  }

  function startAckTimer() {
    if (ackTimer) return
    // 每 5 秒兜一次：批量阈值没到也不能让引擎的未确认队列一直涨。
    ackTimer = setInterval(() => flushAck(true), ACK_INTERVAL_MS)
  }

  function stopAckTimer() {
    if (ackTimer) { clearInterval(ackTimer); ackTimer = null }
  }

  /** 换 sessionId 后必须重连：WS 的路径里带着 session id。 */
  function connect(wsUrl?: string) {
    // 幂等：已连着「当前会话」且 transport 还活着（没停摆、会自动恢复）时直接跳过。
    // ChatView 每次挂载都会调 connect —— 运行中切页回来不该把活连接拆掉重建，
    // 重建会让引擎重放未确认事件，重放过的帧虽然会被顺序门判重丢弃，
    // 但 turn 中途重放仍可能画出重复/错位的内容。
    if (transport.value && connectedSessionId === sessionId.value && transport.value.isAlive()) return
    const targetSessionId = sessionId.value
    const previous = transport.value
    transport.value = null
    connectedSessionId = ''
    previous?.close()
    if (wsUrl) connection.setWsUrl(wsUrl)
    const t = createTransport(targetSessionId, wsUrl)
    transport.value = t
    connectedSessionId = targetSessionId
    // 换会话（不是重连）：顺序门必须复位 —— 新会话任务的 event_seq 从 1 重新起，
    // 留着旧的 last 会把新一轮的帧全判成重复帧。重连同一会话**不要**复位，要留 last 给 resync。
    if (gateSessionId !== targetSessionId) {
      gateSessionId = targetSessionId
      resetEventStream()
    }
    startAckTimer()
    t.onStateChange(status => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      connection.setStatus(status)
      if (status.state === 'open') {
        // 通道真正打开过一次，才补那些「启动时没赶上」的加载（历史列表、模型列表）。
        void flushHydrationOnOpen()
        // 连接（重）建立：标记「新连接的第一帧」（用来识别引擎重启后 seq 归零），
        // 并以顺序门已处理的最后一个 seq 为游标补发缺口。引擎在 socket 打开时也会
        // 自动重放未确认队列，这里再要一次是幂等的（重复帧由顺序门丢弃），
        // 但能覆盖「重放半路又断了」的情况。
        firstEventOnConnection = true
        requestResync(true)
        // 云端：电脑宿主只服务它当前的活动会话。把手机正在看的会话 id 同步过去，
        // 电脑端收到后若不同会切换会话并重绑通道（同 id 幂等，不会来回重连）。
        // LAN/本机直连没有宿主，这条命令只会被引擎当成未知指令 —— 见 Transport.hostCommands。
        if (isCloudConnectionMode() && t.hostCommands !== false) t.send({ command: 'switch_session', session_id: targetSessionId })
        t.send({ command: 'set_permission_mode', mode: config.permissionMode })
        t.send({ command: 'set_session_mode', mode: mode.value })
        const meta = sessions.find(targetSessionId)
        const providerId = meta?.providerId || config.currentProviderId
        const model = meta?.model || config.currentModel
        if (providerId && model) {
          t.send({ command: 'select_model', provider_id: providerId, model })
        }
        t.send({ command: 'set_reasoning_effort', effort: config.reasoningEffort })
        t.send({ command: 'set_end_to_end_mode', enabled: endToEndMode.value })
        // 重连必须重述逆向意图：engine 的 SessionTask 可能已经重建（进程重启/换设备），
        // 不补这一条，UI 显示开着但引擎实际是关的 —— 直到用户手动再点一次才发现。
        if (config.reverseModeTarget) {
          t.send({ command: 'set_reverse_mode', enabled: true, flavor: config.reverseFlavor })
        }
      }
    })
    t.onMessage(env => {
      if (transport.value !== t || sessionId.value !== targetSessionId) return
      if (env.type === 'event') {
        const seq = readEventSeq(env.payload as unknown as Record<string, unknown>)
        if (seq != null) {
          // 新连接的第一帧：seq 比本地已处理游标还小 = 引擎重启过（SessionTask 重建、
          // event_seq 从 1 重新计数）。必须立刻复位顺序门，否则这一轮所有帧都会被当成
          // 重复帧丢掉；connection_heartbeat 的 next_seq 兜底可能来得太晚（首帧先到）。
          if (firstEventOnConnection) {
            firstEventOnConnection = false
            if (seq < seqGate.last()) resetEventStream()
          }
          const outcome = seqGate.push(seq, env.payload)
          // 重复 / 迟到的旧帧：不再画第二条气泡，也不动 ack 游标。
          if (outcome.duplicate) return
          // 缺口：本帧已暂存，请引擎补发 last 之后的事件；等补帧按序补齐再统一放行。
          // **不能**先收下本帧，否则补回来的缺口帧会被当成重复帧永久丢掉。
          if (outcome.gap) {
            requestResync()
            return
          }
          // 顺序门保证 ready 是严格连续的若干帧；每帧只在这里处理一次。
          for (const event of outcome.ready) applyEvent(event)
          ackedSeq = seqGate.last()
          ackBatch += outcome.ready.length
          if (ackBatch >= ACK_BATCH) flushAck(true)
          return
        }
      }
      onInbound(env)
    })
    t.connect()
  }

  /**
   * 引擎重启通知（coomi:engine-ready）：强制重建 WS。
   * 优先走 transport.forceReconnect()（原地重建，保留 lastEventSeq）；
   * 若 transport 不支持则整体 reconnect()。
   */
  function onEngineReady() {
    // 引擎是新进程：SessionTask 重建、event_seq 从 1 重新计数，旧游标必须复位，
    // 否则新一轮的帧会因「seq <= last」被顺序门当成重复帧全部丢掉。
    resetEventStream()
    // 后台会话的轮次也随旧进程一起结束：收尾后落盘，避免永远停在「运行中」。
    for (const worker of backgroundWorkers.values()) {
      bgEndAssistant(worker)
      worker.runState = 'idle'
      bgPersist(worker)
    }
    const t = transport.value
    if (t?.forceReconnect) {
      t.forceReconnect()
      return
    }
    // 无 transport 或不支持 forceReconnect：走完整 reconnect
    if (!t) {
      connect(connection.wsUrl || undefined)
      return
    }
    reconnect()
  }

  // 注册引擎就绪监听（仅一次；组件卸载不会清理，因 store 是单例）
  if (typeof window !== 'undefined') {
    window.addEventListener('coomi:engine-ready', onEngineReady)
  }

  function disconnect() { stopAckTimer(); transport.value?.close(); transport.value = null; connectedSessionId = ''; closeAllBackgroundWorkers() }

  /** Recreate the active socket so newly saved retry settings take effect immediately. */
  function reconnect() {
    const previous = transport.value
    transport.value = null
    connectedSessionId = ''
    previous?.close()
    connect(connection.wsUrl || undefined)
  }

  function onInbound(env: InboundEnvelope) {
    if (env.type === 'event') applyEvent(env.payload)
    else if (env.type === 'error') pushNotice('error', env.payload.message)
  }

  function applyEvent(ev: AgentEvent) {
    switch (ev.event_type) {
      // 兜底：turn_end 之后又开始吐字（引擎续了一轮），状态得跟着回到忙。
      case 'text_chunk': {
        // 空增量（部分网关会先发一帧 content:""）不是正文：
        // 既不能创建空助手气泡，也不能把“本轮有文字”置真。
        const chunk = typeof ev.content === 'string' ? ev.content : ''
        if (!chunk) break
        if (chunk.trim()) turnHadAssistantText = true
        connection.setRetry(null)
        if (runState.value === 'idle') runState.value = 'thinking'
        appendAssistant(chunk)
        break
      }
      case 'reasoning_chunk': if (runState.value === 'idle') runState.value = 'thinking'; appendReasoning(ev.content); break
      case 'tool_start':
        connection.setRetry(null)
        endAssistantStream()
        timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'starting', expanded: ev.tool_name === 'show_image' })
        turnToolTrace.push({
          callId: ev.call_id,
          sequence: turnToolTrace.length + 1,
          tool: sanitizeToolName(ev.tool_name),
          argumentShape: summarizeArguments(ev.arguments),
          status: 'running',
        })
        runState.value = 'executing'
        break
      case 'tool_running': patchTool(ev.call_id, c => c.status = 'running'); runState.value = 'executing'; break
      case 'tool_done':
        patchTool(ev.call_id, c => {
          c.status = ev.is_error ? 'error' : 'success'
          c.elapsed = ev.elapsed
          c.resultPreview = ev.result_preview
          c.resultFull = ev.result_full ?? ev.result_preview
          c.resultTruncated = ev.result_truncated === true
          c.isError = ev.is_error
          // 工具产生的图片：瀑布流渲染（历史恢复时由 messages.images 补回）
          if (Array.isArray(ev.images) && ev.images.length > 0) c.images = ev.images
        })
        // 工具跑完不等于一轮结束 —— 模型接着想下一步。回 idle 只认 turn_end /
        // 取消 / 致命错误，否则输入区会在循环中途闪回「下达任务」和发送箭头。
        runState.value = 'thinking'
        {
          const trace = turnToolTrace.find(item => item.callId === ev.call_id)
          if (trace) {
            trace.status = ev.is_error ? 'error' : 'success'
            trace.elapsedMs = Math.max(0, Math.round(ev.elapsed * 1000))
            if (ev.is_error) {
              consecutiveToolFailures += 1
              maxConsecutiveToolFailures = Math.max(maxConsecutiveToolFailures, consecutiveToolFailures)
              trace.category = classifyToolError(ev.result_preview)
              trace.errorSummary = sanitizeDiagnosticText(ev.result_preview)
              if (maxConsecutiveToolFailures >= 3 && !failureNoticeCreated) {
                failureNoticeCreated = true
                timeline.value.push({
                  kind: 'notice', id: nextId(), tone: 'warn',
                  text: `同一任务链连续 ${maxConsecutiveToolFailures} 次工具调用失败，请检查工具参数或稍后重试。`,
                })
              }
            } else consecutiveToolFailures = 0
          }
        }
        break
      case 'tool_cache_hit':
        patchTool(ev.call_id, c => c.status = 'cache_hit')
        {
          const trace = turnToolTrace.find(item => item.callId === ev.call_id)
          if (trace) trace.status = 'success'
          consecutiveToolFailures = 0
        }
        break
      case 'tool_approval_request':
        endAssistantStream()
        if (!patchTool(ev.call_id, c => { c.status = 'awaiting_approval'; c.access = ev.access; c.riskSummary = ev.risk_summary; c.expanded = true })) {
          timeline.value.push({ kind: 'tool', callId: ev.call_id, toolName: ev.tool_name, arguments: ev.arguments, status: 'awaiting_approval', access: ev.access, riskSummary: ev.risk_summary, expanded: true })
        }
        runState.value = 'awaiting_approval'
        break
      case 'user_question_request':
        endAssistantStream()
        timeline.value.push({ kind: 'question', callId: ev.call_id, questions: ev.questions, answered: false })
        runState.value = 'awaiting_question'
        break
      case 'file_transfer_request':
        if (ev.operation === 'import') {
          window.CoomiAndroid?.importFilesForRequest?.(ev.request_id)
        } else if (ev.path) {
          window.CoomiAndroid?.exportFileForRequest?.(
            ev.request_id,
            ev.path,
            ev.suggested_name ?? ev.path.split('/').pop() ?? 'coomi-export',
          )
        }
        break
      case 'usage_update': {
        const previous = usage.value
        usage.value = {
          total: ev.usage.total_tokens ?? previous?.total ?? 0,
          input: ev.usage.input_tokens ?? previous?.input ?? 0,
          output: ev.usage.output_tokens ?? previous?.output ?? 0,
          contextRatio: ev.usage.context_ratio ?? previous?.contextRatio ?? 0,
          contextUsed: ev.usage.context_used_tokens ?? previous?.contextUsed ?? estimateContextTokens(),
          contextWindow: ev.usage.context_window_tokens ?? previous?.contextWindow ?? 0,
          cachedInput: ev.usage.cached_input_tokens ?? previous?.cachedInput ?? 0,
          cacheHitRate: ev.usage.cache_hit_rate ?? previous?.cacheHitRate ?? null,
          cacheDataAvailable: ev.usage.cache_data_available ?? previous?.cacheDataAvailable ?? false,
          turnCacheHitRate: ev.usage.turn_cache_hit_rate ?? previous?.turnCacheHitRate ?? null,
          turnCacheDataAvailable: ev.usage.turn_cache_data_available ?? previous?.turnCacheDataAvailable ?? false,
          reasoningEfforts: ev.reasoning_efforts ?? previous?.reasoningEfforts ?? {},
          contextCategories: ev.context_categories ?? previous?.contextCategories ?? {},
          // `null` is an intentional reset at the start of a new turn. Only
          // retain the previous value when an older engine omitted the field.
          firstTokenLatencyMs: ev.usage.first_token_latency_ms === undefined
            ? previous?.firstTokenLatencyMs ?? null
            : ev.usage.first_token_latency_ms,
          outputTokensPerSecond: ev.usage.output_tokens_per_second === undefined
            ? previous?.outputTokensPerSecond ?? null
            : ev.usage.output_tokens_per_second,
          turnTotalTokens: ev.usage.turn_total_tokens === undefined
            ? previous?.turnTotalTokens ?? null
            : ev.usage.turn_total_tokens,
        }
        // 速率可能比 turn_end 晚到：给最后一条已结束但还没速率的回复补写一次
        if (usage.value.outputTokensPerSecond != null) {
          for (let i = timeline.value.length - 1; i >= 0; i -= 1) {
            const item = timeline.value[i]
            if (item.kind !== 'assistant') continue
            if (item.streaming || item.endedAt === undefined) break
            if (item.speedTps == null) item.speedTps = usage.value.outputTokensPerSecond
            break
          }
        }
        break
      }
      case 'compression': pushNotice('info', `上下文已压缩 ${fmtTokens(ev.before)} → ${fmtTokens(ev.after)}`); break
      case 'connection_retry': connection.setRetry(`${ev.message}（${ev.attempt}/${ev.max_attempts}）`); break
      case 'connection_heartbeat': {
        // 引擎重启 / 会话任务重建会让 next_seq 从 1 重新计数。明显倒退就复位顺序门，
        // 否则新一轮的帧会因「seq <= last」被当成重复帧全部丢掉
        //（coomi:engine-ready 通知万一没到，这里是兜底）。
        // next_seq = 已发出的最大 seq + 1，正常永远 > last，所以不会误判。
        if (typeof ev.next_seq === 'number' && ev.next_seq > 0 && ev.next_seq <= seqGate.last()) resetEventStream()
        break
      }
      case 'stream_reset':
        endAssistantStream()
        while (timeline.value.length > 0) {
          const last = timeline.value[timeline.value.length - 1]
          if (last.kind === 'assistant' || last.kind === 'reasoning') timeline.value.pop()
          else break
        }
        break
      case 'retry_confirmation':
        endAssistantStream()
        runState.value = 'idle'
        // 事件带机器可读现场：原因 / 已用轮次 / 上限 / 最后在跑的工具 / 能否继续。
        retryConfirmation.value = {
          message: ev.message,
          detail: ev.detail,
          reason: ev.reason,
          roundsUsed: typeof ev.rounds_used === 'number' ? ev.rounds_used : null,
          roundsLimit: typeof ev.rounds_limit === 'number' ? ev.rounds_limit : null,
          lastTool: typeof ev.last_tool === 'string' ? ev.last_tool : '',
          resumable: ev.resumable !== false,
        }
        if (ev.reason === 'upstream_unavailable') {
          const detail = String(ev.detail || ev.message || '上游服务不可用')
          pushNotice('error', `上游服务不可用：${detail}`)
          setErrorBanner(detail)
        }
        break
      case 'agent_error':
        endAssistantStream()
        pushNotice('error', ev.message)
        setErrorBanner(String(ev.message || ''))
        if (ev.is_fatal) runState.value = 'idle'
        // 端到端模式：先重试同一模型，连续失败达到阈值后切换到接力模型。
        if (endToEndMode.value && runState.value === 'idle' && transport.value) {
          _errorRetryCount++
          const threshold = config.endToEndFailThreshold
          if (config.endToEndFallbacks.length > 0 && _errorRetryCount >= threshold) {
            _errorRetryCount = 0
            cycleEndToEndModel()
          } else {
            pushNotice('info', `端到端模式：检测到错误，自动重试 (#${_errorRetryCount})...`)
          }
          if (_errorRetryTimer) clearTimeout(_errorRetryTimer)
          _errorRetryTimer = setTimeout(() => {
            _errorRetryTimer = null
            transport.value?.send({ command: 'retry_turn' as const })
            runState.value = 'thinking'
          }, 2000)
        }
        persistSoon()
        break
      case 'turn_notice': {
        // 引擎此前已经发过这些提示，但 store 没有分支，全部静默丢弃。
        // 空回复重试/输出上限/任务未完成继续执行都是用户需要知道的中间态。
        const kind = ev.kind || ''
        if (kind === 'empty-response-retry' || kind === 'empty-output') {
          pushNotice('warn', ev.message)
        } else if (kind === 'upstream-error') {
          pushNotice('warn', ev.message)
          setErrorBanner(String(ev.message || ''))
        } else if (kind === 'output-limit' || kind === 'continue-execution' || kind === 'compaction') {
          pushNotice('info', ev.message)
        } else if (kind === 'turn-budget') {
          pushNotice('warn', ev.message)
        }
        break
      }
      case 'loop_guard':
        pushNotice('warn', ev.message)
        break
      case 'configuration_required': endAssistantStream(); runState.value = 'idle'; configPrompt.value = configPromptFor(ev); break
      case 'agent_cancelled': endAssistantStream(); cancelRunningTools(); pushNotice('warn', '已停止本轮执行'); break
      // ── 排队 / 插话 / 打断 / 重新同步：以前这些事件后端会发、前端没有 case，
      //    用户看不到任何反馈（尤其“消息已插入当前轮”与“已打断”）。
      case 'turn_interrupted':
        pushNotice('info', ev.message || '已打断当前轮，正在按新消息继续')
        break
      case 'interjection_queued':
        pushNotice('info', '消息已插入当前轮，模型会在下一个安全点处理')
        break
      case 'message_queued':
        pushNotice('info', typeof ev.index === 'number' && ev.index > 0 ? `消息已排队（第 ${ev.index} 位）` : '消息已排队，本轮结束后自动开始')
        break
      case 'queue_cleared':
        if ((ev.removed ?? 0) > 0) pushNotice('info', `已停止本轮，清除了 ${ev.removed} 条排队消息`)
        break
      case 'resync_result':
        if (ev.truncated) pushNotice('warn', '部分历史事件已过期，已按服务端最新状态同步')
        break
      case 'bg_task_detached': pushNotice('info', `↪ 已转入后台任务 #${ev.task_id}（${ev.tool_name}）`); break
      case 'bg_task_completed': pushNotice(ev.is_error ? 'error' : 'success', `后台任务 #${ev.task_id} ${ev.is_error ? '失败' : '完成'}`); break
      case 'loop_progress':
        loop.value = { active: ev.status !== 'done', currentStep: ev.current_step, totalSteps: ev.total_steps, status: ev.status, currentDescription: loop.value.currentDescription }
        break
      case 'plan_updated':
        plan.value = {
          steps: ev.steps ?? [],
          completed: ev.completed ?? 0,
          total: ev.total ?? (ev.steps?.length ?? 0),
          explanation: ev.explanation ?? '',
        }
        loop.value = { ...loop.value, active: (ev.completed ?? 0) < (ev.total ?? 0), totalSteps: ev.total ?? 0, currentStep: ev.completed ?? 0 }
        break
      case 'loop_step_start':
        loop.value = { ...loop.value, active: true, totalSteps: ev.total_steps, currentStep: ev.step_index, currentDescription: ev.step_description }
        break
      case 'life_delivered': {
        // 气泡投递完成：把最后一条 assistant 标记为生命体气泡并复位投递态。
        lifeDelivering.value = false
        const last = timeline.value[timeline.value.length - 1]
        if (last?.kind === 'assistant') last.life = true
        void refreshLifeUnread()
        break
      }
      case 'collaboration_started':
        collaboration.value = { active: true, phase: '', cycle: 0, cycles: ev.cycles, status: 'started', review: '' }
        break
      case 'collaboration_phase':
        collaboration.value = { ...collaboration.value, active: true, phase: ev.phase, cycle: ev.cycle, status: ev.status }
        break
      case 'collaboration_review':
        collaboration.value = { ...collaboration.value, active: true, phase: 'reviewer', cycle: ev.cycle, status: ev.status, review: ev.content }
        break
      case 'collaboration_finished':
        collaboration.value = { ...collaboration.value, active: false, phase: 'reviewer', cycle: ev.cycle ?? collaboration.value.cycle, status: ev.status ?? collaboration.value.status, review: ev.summary ?? collaboration.value.review }
        break
      // 协同工作台 v3 从其独立任务 API 拉取权威状态；WS 事件只负责提醒页面尽快刷新。
      case 'collab_agent_status':
      case 'collab_agent_chunk':
      case 'collab_agent_reasoning':
      case 'collab_agent_message':
      case 'collab_agent_tool':
      case 'collab_task_started':
      case 'collab_file_read':
      case 'collab_file_write':
      case 'collab_architecture_ready':
      case 'collab_task_assigned':
      case 'collab_plan_ready':
      case 'collab_subtask_status':
      case 'collab_orchestration_phase':
      case 'collab_merge_result':
      case 'collab_finished':
        window.dispatchEvent(new CustomEvent('coomi:collab-event', { detail: ev }))
        break
      case 'turn_end': {
        addTurnTiming(ev.elapsed_ms, ev.llm_ms, ev.tool_ms)
        // 先把改动汇总挂到这一轮的助手气泡上（清空助手气泡之前），再走原来的收尾。
        const artifacts = ev.artifacts ?? []
        const actions = ev.actions ?? []
        if (artifacts.length) {
          for (let i = timeline.value.length - 1; i >= 0; i--) {
            const item = timeline.value[i]
            if (item.kind === 'assistant') { item.files = artifacts; item.actions = actions; break }
          }
        }
      }
      case 'turn_end':
        endAssistantStream(); cancelRunningTools(); connection.setRetry(null); runState.value = 'idle'
        {
          const failures = turnToolTrace.filter(item => item.status === 'error').length
          if (maxConsecutiveToolFailures >= 3 && !failureNoticeCreated) {
            timeline.value.push({
              kind: 'notice', id: nextId(), tone: 'warn',
              text: `同一任务链连续 ${maxConsecutiveToolFailures} 次工具调用失败，请检查工具参数或稍后重试。`,
            })
          }
          // 终态兜底：旧引擎即使把空回复标成 succeeded，也必须有可见结果。
          const status = typeof ev.status === 'string' ? ev.status : ''
          // 清掉空助手气泡（空 delta / 中断留下的占位）。
          timeline.value = timeline.value.filter(item =>
            !(item.kind === 'assistant' && !item.streaming && !item.content.trim()))
          if (status === 'completed_without_text') {
            // 不再依赖 turnHadAssistantText：它会被空 delta 或一句开场白污染，
            // 而“工具做完了但没有最终正文”本身就必须让用户看见。
            const text = '工具已执行完成，但模型没有返回文字总结。可发送“继续”让它总结结果。'
            if (!timeline.value.some(item => item.kind === 'notice' && item.text === text)) {
              pushNotice('warn', text)
            }
          } else if (status === 'failed' && !errorBanner.value && !retryConfirmation.value) {
            pushNotice('error', ev.reason ? `本轮已停止：${ev.reason}` : '本轮已停止，但没有返回错误详情。')
          } else if (!turnHadAssistantText && turnToolTrace.length === 0 && status !== 'cancelled' && !retryConfirmation.value) {
            pushNotice('warn', '本轮没有产生可显示的文字回复。可重试，或更换模型后再试。')
          }
          // 后台完成 → 系统通知续聊
          notifyUserIfBackground('Coomi 任务完成', '点开继续对话')
        }
        turnToolTrace = []
        turnHadAssistantText = false
        consecutiveToolFailures = 0
        maxConsecutiveToolFailures = 0
        failureNoticeCreated = false
        // 轮到真实边界了：把生成期间攒下的逆向开关意图落地。
        // 必须在这个位置（persistSoon 之前、runState 已回 idle），
        // 否则引擎侧下一轮仍会用旧的 system prompt。
        if (reverseModePending.value) flushReverseMode()
        persistSoon()
        break
      case 'reverse_state': {
        // 引擎口径的回执：以它为准，不用本地意图覆盖。
        // 这是唯一能区分「开着但环境受限」与「真的在跑」的信号。
        const r = ev.reverse
        reverseHealth.value = r.health
        reverseModeCommitted.value = r.enabled
        reverseServerFlavors.value = r.flavors ?? []
        // 契约摘要与已注入片段：给实验性选项页做诊断展示。
        if (typeof r.contractDigest === 'string') {
          reverseContractDigest.value = r.contractDigest
        }
        if (Array.isArray(r.activeSegments)) {
          reverseActiveSegments.value = r.activeSegments
        }
        if (r.flavor) config.setReverseFlavor(normalizeFlavor(r.flavor))
        break
      }
      case 'session_state': {
        // 重连后引擎告知本会话是否仍在后台执行（切走会话后任务继续跑）。
        sessions.refreshRunning()
        runState.value = ev.running ? 'thinking' : 'idle'
        break
      }
      case 'session_loaded': {
        // 打开历史会话时，引擎把持久化的累计用量推过来，避免显示 0。
        const u = ev.usage ?? {}
        usage.value = {
          total: u.total_tokens ?? usage.value?.total ?? 0,
          input: u.input_tokens ?? usage.value?.input ?? 0,
          output: u.output_tokens ?? usage.value?.output ?? 0,
          contextRatio: usage.value?.contextRatio ?? 0,
          contextUsed: usage.value?.contextUsed ?? 0,
          contextWindow: usage.value?.contextWindow ?? 0,
          cachedInput: usage.value?.cachedInput ?? 0,
          cacheHitRate: usage.value?.cacheHitRate ?? null,
          cacheDataAvailable: usage.value?.cacheDataAvailable ?? false,
          turnCacheHitRate: usage.value?.turnCacheHitRate ?? null,
          turnCacheDataAvailable: usage.value?.turnCacheDataAvailable ?? false,
          reasoningEfforts: usage.value?.reasoningEfforts ?? {},
          contextCategories: usage.value?.contextCategories ?? {},
          firstTokenLatencyMs: usage.value?.firstTokenLatencyMs ?? null,
          outputTokensPerSecond: usage.value?.outputTokensPerSecond ?? null,
          turnTotalTokens: usage.value?.turnTotalTokens ?? null,
        }
        if (typeof ev.cwd === 'string' && ev.cwd) cwd.value = ev.cwd
        break
      }
    }
  }

  function activateSession(id: string) {
    sessionId.value = id
    timing.value = null
    timingEpoch++
    void refreshTiming(id)
    // 换会话 = 作废所有在途的历史恢复（含被慢 HTTP 拖住的那次）。
    openEpoch++
    restoring.value = false
    if (typeof window !== 'undefined') {
      ;(window as Window & { __coomiActiveSessionId?: string }).__coomiActiveSessionId = id
    }
    mode.value = resolveLifeMode(id)
    collaboration.value = { active: false, phase: '', cycle: 0, cycles: 0, status: '', review: '' }
    // 缺配置的提示属于刚才那一轮，切到别的会话不该继续挂在输入框上。
    configPrompt.value = null
    branchNotice.value = null
    // 折叠/工具详情的 key 只在会话内唯一，切会话必须清掉，否则旧状态会串进新会话。
    resetTransientUiState()
    persistActiveSessionId(id)
    lifeAutoSent = false
  }

  /**
   * 会话模式决议：生命体人格只属于「常驻会话」；「用于全局会话」开关开启后所有会话都带人格。
   * 历史会话即使曾被切成 life，关闭全局开关后也强制回到 agent（人格只活在它该在的地方）。
   */
  function resolveLifeMode(id: string): 'agent' | 'team' | 'life' {
    if (config.digitalLifeEnabled && (isGlobalSessionId(id) || config.lifeGlobalMode)) return 'life'
    return sessions.find(id)?.mode === 'team' ? 'team' : 'agent'
  }

  const isGlobalSession = computed(() => isGlobalSessionId(sessionId.value))

  /** 「重试」：让引擎按磁盘上最后一条用户消息重跑中断的这一轮（引擎 retry_turn）。 */
  function retryInterruptedTurn() {
    retryConfirmation.value = null
    turnHadAssistantText = false
    runState.value = 'thinking'
    transport.value?.send({ command: 'retry_turn' })
  }

  /**
   * 「继续这一轮」：不是重跑，而是把「继续」当作**新一轮**发出去 ——
   * 与桌面端 resumeInterruptedTurn → send('继续') 同义。引擎侧就是一条普通 send_message，
   * 带着上一轮上下文接着往下做；复用 sendMessage 的乐观气泡与附件清理。
   */
  function continueInterruptedTurn() {
    retryConfirmation.value = null
    sendMessage('继续')
  }

  function dismissRetry() { retryConfirmation.value = null }

  function setReasoningEffort(effort: ReasoningEffort) {
    config.setReasoningEffort(effort)
    transport.value?.send({ command: 'set_reasoning_effort', effort })
  }

  /** 后台完成时系统通知（点开续聊）。仅 App 不在前台时发，避免前台打扰。 */
  function notifyUserIfBackground(title: string, body: string) {
    if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
    window.CoomiAndroid?.notifyUser?.(title, body, sessionId.value)
  }

  function cancelRunningTools() {
    // 停止后引擎可能不会逐个补发 tool_done：把仍在运行/准备中的工具卡片
    // 收尾为「已取消」，否则卡片会永远停在旋转的「运行中」状态。
    let changed = false
    for (const item of timeline.value) {
      if (item.kind === 'tool' && (item.status === 'running' || item.status === 'starting')) {
        item.status = 'cancelled'
        item.isError = true
        changed = true
      }
    }
    if (changed) persistSoon()
  }

  /** 通过当前加密通道上传附件（P2P 直连或加密中转），返回电脑端路径。 */
  async function uploadAttachment(file: Blob, name: string, onProgress?: (percent: number) => void): Promise<{ path: string; name: string }> {
    const t = transport.value
    if (!t || typeof t.uploadFile !== 'function') throw new Error('当前连接不支持文件上传（需要直连或加密中转）')
    const result = await t.uploadFile(file, name, p => onProgress?.(p.percent))
    const path = result.path || ''
    if (!path) throw new Error('电脑端没有返回文件路径')
    return { path, name: result.filename || name }
  }

  function sendMessage(text: string) {
    errorBanner.value = null
    turnHadAssistantText = false
    const trimmed = text.trim()
    if (!trimmed && attachedFiles.value.length === 0) return
    if (blockTurn()) return
    // 用户重新发起了这一轮：上一轮的「缺配置」提示作废（真缺的话引擎会再说一次）。
    configPrompt.value = null
    // 编辑覆盖模式：截断目标轮次（与引擎 edit_turn 行为一致），以新文本重新执行。
    const edit = pendingEdit.value
    if (edit) {
      pendingEdit.value = null
      let cutAt = -1
      if (edit.mid) cutAt = timeline.value.findIndex(t => t.kind === 'user' && t.mid === edit.mid)
      if (cutAt < 0) {
        for (let i = timeline.value.length - 1; i >= 0; i--) {
          if (timeline.value[i].kind === 'user') { cutAt = i; break }
        }
      }
      // 被替换的旧回答只在内存里有：先让引擎把「改写前」的整段存成独立分支，
      // 再执行 edit_turn。否则截断一落地，旧版本就再也找不回来了。
      const hasReplacedTail = cutAt >= 0 && timeline.value
        .slice(cutAt + 1)
        .some(t => t.kind === 'assistant' || t.kind === 'tool' || t.kind === 'reasoning')
      // 记下被替换的旧文本，气泡下方才能给出 < n/N > 切换。
      const replaced = cutAt >= 0 ? timeline.value[cutAt] : null
      const previousVersions = replaced?.kind === 'user'
        ? [...(replaced.versions ?? []), replaced.content]
        : []
      if (cutAt >= 0) timeline.value.splice(cutAt)
      const files = attachedFiles.value.length ? attachedFiles.value.map(f => ({ name: f.name, path: f.path, size: f.size, isDir: f.isDir })) : undefined
      timeline.value.push({
        kind: 'user', id: nextId(), mid: '', content: trimmed, attachedFiles: files,
        versions: previousVersions.length ? [...previousVersions, trimmed] : undefined,
      })
      runState.value = 'thinking'
      const sendEdit = () => {
        runState.value = 'thinking'
        transport.value?.send({ command: 'edit_turn', msg_id: edit.mid, text: trimmed })
      }
      if (hasReplacedTail) {
        branchSaving.value = true
        void saveEditBranch().finally(() => { branchSaving.value = false; sendEdit() })
      } else {
        sendEdit()
      }
      persistSoon()
      clearAttachedFiles()
      return
    }
    // 仅在「新对话」且非全局/已命名时自动取标题。
    const isFirst = !timeline.value.some(t => t.kind === 'user')
    if (isFirst) maybeAutoTitle(trimmed)
    if (isBusy.value) {
      const files = attachedFiles.value.length ? attachedFiles.value.map(f => ({ name: f.name, path: f.path, size: f.size, isDir: f.isDir })) : undefined
      timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed, attachedFiles: files })
      transport.value?.send({ command: 'jump_in', text: trimmed })
      persistSoon()
      clearAttachedFiles()
      return
    }
    const files = attachedFiles.value.length ? attachedFiles.value.map(f => ({ name: f.name, path: f.path, size: f.size, isDir: f.isDir })) : undefined
    timeline.value.push({ kind: 'user', id: nextId(), mid: '', content: trimmed, attachedFiles: files })
    runState.value = 'thinking'
    transport.value?.send({ command: 'send_message', text: trimmed, attached_files: files })
    persistSoon()
    clearAttachedFiles()
  }

  function cancel() { transport.value?.send({ command: 'cancel' }) }
  function approve(callId: string, decision: 'allow' | 'deny' | 'always') {
    patchTool(callId, c => { c.status = decision === 'deny' ? 'error' : 'running'; if (decision === 'deny') { c.resultPreview = '（用户拒绝执行）'; c.isError = true } })
    transport.value?.send({ command: 'approve_tool', call_id: callId, decision })
    if (runState.value === 'awaiting_approval') runState.value = 'executing'
  }
  function answerQuestion(callId: string, answers: Record<string, string>, comments?: Record<string, string>) {
    patchQuestion(callId, q => { q.answered = true; q.answers = answers; if (comments) q.comments = comments })
    transport.value?.send({ command: 'answer_question', call_id: callId, answers, ...(comments ? { comments } : {}) })
    if (runState.value === 'awaiting_question') runState.value = 'thinking'
  }
  function setPermissionMode(mode: 'ask' | 'auto' | 'full') { config.setPermissionMode(mode); transport.value?.send({ command: 'set_permission_mode', mode }) }
  function togglePlanMode() { const entering = !config.planMode; config.togglePlanMode(); transport.value?.send({ command: entering ? 'enter_plan_mode' : 'exit_plan_mode' }) }
  async function selectModel(providerId: string, model: string) {
    if (!(await config.validateAndSelectModel(providerId, model))) {
      pushNotice('error', config.lastError || '模型凭据验证失败，未切换模型')
      return
    }
    transport.value?.send({ command: 'select_model', provider_id: providerId, model })
    sessions.setModel(sessionId.value, providerId, model)
  }
  function setSessionMode(value: 'agent' | 'team' | 'life') {
    if (isBusy.value || mode.value === value) return
    mode.value = value
    sessions.setMode(sessionId.value, value)
    transport.value?.send({ command: 'set_session_mode', mode: value })
  }
  /** 按「人格只属于常驻会话 / 用于全局会话开关」重算当前会话模式并同步引擎。 */
  function syncLifeMode() {
    if (isBusy.value) return
    const next = resolveLifeMode(sessionId.value)
    if (mode.value === next) return
    mode.value = next
    sessions.setMode(sessionId.value, next)
    transport.value?.send({ command: 'set_session_mode', mode: next })
  }
  function completeFileTransfer(requestId: string, paths: string[]) {
    transport.value?.send({ command: 'file_transfer_result', request_id: requestId, paths })
  }

  /** 生命体未读问候（/api/life/unread）：窗口轮询 + 打开会话时刷新。 */
  async function refreshLifeUnread() {
    try {
      const data = await apiGet<{ pending: LifeUnreadItem | null; lifeName?: string } | null>('/api/life/unread')
      const pending = data?.pending ?? null
      lifeUnread.value = pending ? [pending] : []
      lifeUnreadName.value = pending?.lifeName ?? ''
      if (!pending) {
        // 引擎侧已无未读（可能已投递/过期）：复位投递态，允许后续再触发。
        lifeDelivering.value = false
        lifeAutoSent = true
      }
    } catch {
      /* 引擎未就绪时保持上次状态 */
    }
  }

  /** 手动投递（气泡 pill）：引擎侧把队列第一条写入本会话并流式推送。 */
  function deliverLife() {
    if (!lifeUnread.value.length || lifeDelivering.value) return
    lifeDelivering.value = true
    lifeAutoSent = true
    transport.value?.send({ command: 'deliver_life' })
  }

  /**
   * 开场问候：常驻会话已打开且引擎已连、有未读时自动投递一次。
   * 由 ChatView 常驻轮询每 2s 调用；lifeDelivering/lifeAutoSent 防止重复触发。
   * 主动消息只在常驻会话出现，其他会话永不投递。
   */
  function autoDeliverLifeIfReady() {
    if (lifeAutoSent || lifeDelivering.value) return
    if (!isGlobalSessionId(sessionId.value)) return
    if (mode.value !== 'life' || !lifeUnread.value.length || isBusy.value) return
    if (!connection.isOpen) return
    deliverLife()
    void refreshLifeUnread()
  }

  function newSession() {
    errorBanner.value = null
    // 当前会话还在跑：让它继续在后台收流，别在「新建」时把连接掐掉。
    const handedOff = detachCurrentToBackground()
    flushPersistence()
    // 已交给后台的会话不能在这里收尾：把它最后一条 assistant 标成结束，
    // 后台下一段正文就会另起气泡，切回来像被截断过。
    if (!handedOff) endAssistantStream()
    timeline.value = []; usage.value = null
    loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }; runState.value = 'idle'
    pendingEdit.value = null
    undoConfirm.value = null
    const nextId = createSessionId()
    const previous = transport.value
    if (isCloudConnectionMode() && previous?.isAlive() && previous.hostCommands !== false && connectedSessionId !== nextId) {
      previous.send({ command: 'switch_session', session_id: nextId })
    }
    activateSession(nextId)
    cwd.value = ''
    connect()
    // 旧机制：每个对话在根目录下有自己的幕布目录。这里先把它建出来，
    // 不等第一条消息——用户在空态就能看到自己的工作目录，第一条命令也不会
    // 先落到根目录再跳走。
    void ensureSessionWorkspace(nextId)
  }

  /**
   * 创建并绑定本会话的独立目录（`<根目录>/<session-id>`）。
   * 引擎不可用时静默跳过：下一条消息的 run_turn 仍会按同一规则建目录。
   */
  async function ensureSessionWorkspace(id: string): Promise<void> {
    try {
      const res = await authedFetch(`/api/sessions/${id}/workspace`)
      if (!res.ok) return
      const data = await res.json() as { workspace?: string }
      const path = data.workspace?.trim() ?? ''
      if (!path || sessionId.value !== id) return
      cwd.value = path
      const meta = sessions.find(id)
      if (meta) meta.cwd = path
      // 注意：不要写 sessions.currentCwd。那是**项目根**（用于分组），
      // 把它改成会话幕布目录会让「对话」分组消失、侧栏目录显示错。
    } catch { /* 引擎未就绪：保持空 cwd，发送时会再建 */ }
  }

  /**
   * 从引擎 /api/sessions/{id} 恢复完整历史；成功返回 true。
   *
   * epoch = 打开会话时的代数。等 HTTP 的这段时间里用户可能又切走了、或者已经
   * 在这条会话里发了新消息 —— 迟到的响应绝不能覆盖别人已经摆好的时间线，
   * 所以落库前把「代数 / 当前会话 / 是否仍在恢复态」三项都校验一遍。
   * 另外最多等 RESTORE_TIMEOUT_MS：引擎慢或离线时先让本机缓存顶上，
   * 不让切会话被一个卡住的 HTTP 拖住十几秒。
   */
  /**
   * 历史会话的文件改动：引擎在 turn_end 时落了 `file-changes.jsonl`，
   * 按 assistant 的 message id 贴回气泡（顺序猜会错位 —— 没改动的轮次不落记录）。
   */
  async function hydrateFileChanges(id: string, epoch: number): Promise<void> {
    try {
      const data = await apiGet<{
        records?: { message_id?: string; files?: TurnFileChange[]; actions?: TurnAction[] }[]
      }>(`/api/sessions/${encodeURIComponent(id)}/file-changes`)
      if (epoch !== openEpoch || id !== sessionId.value) return
      const records = data.records ?? []
      if (!records.length) return
      for (const record of records) {
        const mid = record.message_id
        if (!mid || !record.files?.length) continue
        const target = [...timeline.value]
          .reverse()
          .find(item => item.kind === 'assistant' && item.mid === mid)
        if (target?.kind === 'assistant') {
          target.files = record.files
          target.actions = record.actions ?? []
        }
      }
    } catch { /* 老会话没有记录是正常的 */ }
  }

  async function restoreFromEngine(id: string, epoch: number): Promise<boolean> {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
    let timer: ReturnType<typeof setTimeout> | null = null
    const timeout = new Promise<null>(resolve => {
      timer = setTimeout(() => { controller?.abort(); resolve(null) }, RESTORE_TIMEOUT_MS)
    })
    // 超时后请求还可能再失败一次：这里兜掉，避免留下未处理的 rejection。
    const request = authedFetch(`/api/sessions/${id}`, controller ? { signal: controller.signal } : undefined)
      .then(res => (res.ok ? res.json() : null))
      .catch(() => null)
    try {
      const session = await Promise.race([request, timeout])
      if (!session || epoch !== openEpoch || id !== sessionId.value) return false
      // 等待期间已经开始新一轮（用户直接发了消息）：实时时间线优先，历史不再回灌。
      if (runState.value !== 'syncing') return false
      mode.value = resolveLifeMode(id)
      sessions.setMode(id, mode.value)
      // 会话自己的幕布目录是权威值：打开历史时必须恢复它，
      // 否则正文里的相对图片路径会按引擎根目录解析（图就找不到了）。
      if (typeof session.cwd === 'string' && session.cwd) {
        // 会话自己的幕布目录是权威值；项目根只由 health.cwd 提供。
        cwd.value = session.cwd
      }
      const live = (session.messages ?? []) as ChatMessageJson[]
      // 压缩后的会话：引擎把被摘要掉的原文留在 archived_messages（只读存档，
      // 不参与模型请求）。这里按 id 去重后拼回时间线，压缩过的会话重开时
      // 仍然能看到完整历史，而不是只剩「摘要 + 当前轮」。
      const archived = (session.archived_messages ?? []) as ChatMessageJson[]
      const liveIds = new Set(live.map(m => m.id).filter(Boolean))
      const messages = archived.length
        ? [...archived.filter(m => !m.id || !liveIds.has(m.id)), ...live]
        : live
      if (messages.length === 0) return false
      if (live.some(m => m.compaction_summary)) {
        // 上下文已压缩：引擎只剩摘要 + 截断的部分历史。前端从未收到压缩版，
        // 本机 localStorage 缓存仍是完整时间线 —— 优先用它恢复展示，
        // 并把压缩摘要折叠成一条提示附在末尾。
        const cached = sessions.loadTranscript(id)
        if (cached && cached.length > 0) {
          // 只取当前上下文里的摘要：archived_messages 里还留着历次压缩的旧摘要。
          const summaries = live.filter(m => m.compaction_summary)
          const detail = summaries[summaries.length - 1]?.content ?? ''
          // 缓存里可能已经有旧提示：先过滤掉再追加，避免每次恢复多叠一条。
          const cachedItems = cached.filter(item => item.kind !== 'notice')
          timeline.value = [
            // 旧缓存里可能还带着计划模式前缀；展示前统一剥掉。
            ...cachedItems.map(item => item.kind === 'user'
              ? { ...item, content: stripPlanModePrefix(item.content) }
              : item),
            { kind: 'notice', id: nextId(), tone: 'info', text: '（上下文已压缩 · 点击查看摘要）', detail },
          ]
          return true
        }
      }
      timeline.value = messagesToTimeline(messages)
      void hydrateFileChanges(id, epoch)
      return true
    } catch {
      return false
    } finally {
      if (timer) clearTimeout(timer)
    }
  }

  /** 把引擎磁盘会话消息转换为前端时间线（含工具调用卡片与结果回填）。 */
  function messagesToTimeline(messages: ChatMessageJson[]): Timelineitem[] {
    const items: Timelineitem[] = []
    const toolResults = new Map<string, string>()
    const toolImages = new Map<string, string[]>()
    // 引擎可能同时保留「旧摘要 + 新摘要」两条 compaction_summary。
    // 只渲染一条提示（取最新摘要）——否则一次压缩会在界面上出现两个灰气泡。
    let compactionDetail = ''
    for (const m of messages) {
      if (m.internal) continue
      if (m.compaction_summary) {
        compactionDetail = m.content ?? compactionDetail
        continue
      }
      if (m.role === 'user') {
        items.push({ kind: 'user', id: 'm' + (m.id ?? nextId()), mid: m.id ?? '', content: stripPlanModePrefix(m.content) })
      } else if (m.role === 'assistant') {
        // 旧会话的思考内容：先按「可折叠思考块」入列，再放正文 —— 与实时 reasoning_chunk
        // 的 appendReasoning 同构（TimelineBlock 已分发 kind==='reasoning'）；空思考不建空块。
        if (m.reasoning && m.reasoning.trim()) {
          items.push({ kind: 'reasoning', id: nextId(), content: m.reasoning, expanded: false })
        }
        // 工具卡先于正文入列：历史恢复的顺序与实时路径一致（思考 → 工具 → 正文），
        // 分组层据此把「最后一段正文」判成答案，正文不会被打进过程折叠体里。
        for (const tc of m.tool_calls ?? []) {
          items.push({
            kind: 'tool', callId: tc.id, toolName: tc.name,
            arguments: tc.arguments as Record<string, unknown>,
            status: 'success', expanded: tc.name === 'show_image',
            images: (tc.images ?? []).map((img: { media_type: string; data: string }) =>
              `data:${img.media_type};base64,${img.data}`),
          })
        }
        if (m.content) items.push({ kind: 'assistant', id: 'm' + (m.id ?? nextId()), mid: m.id ?? '', content: m.content, streaming: false, life: m.life_proactive === true })
      } else if (m.role === 'tool' && m.tool_call_id) {
        toolResults.set(m.tool_call_id, m.content)
        if (m.images?.length) {
          toolImages.set(m.tool_call_id, m.images.map((img: { media_type: string; data: string }) =>
            `data:${img.media_type};base64,${img.data}`))
        }
      }
    }
    // 压缩提示只加一条，放在时间线末尾（与实时路径一致）。
    if (compactionDetail) {
      items.push({ kind: 'notice', id: nextId(), tone: 'info', text: '（上下文已压缩 · 点击查看摘要）', detail: compactionDetail })
    }
    for (const item of items) {
      if (item.kind === 'tool') {
        const result = toolResults.get(item.callId)
        if (result != null) {
          // 折叠行不需要正文，但展开态必须拿到全文；以前这里只存 200 字，
          // 打开历史会话后工具卡永远显示不全（数据并未丢失，只是被前端砍了）。
          item.resultPreview = result.length > 1040 ? result.slice(0, 1040) + '…' : result
          item.resultFull = result
          item.isError = /error|fail|exception|panic/i.test(result.slice(0, 500))
        } else {
          // 没有结果回填（比如被取消/未执行）的调用收尾为已取消
          item.status = 'cancelled'
          item.isError = true
        }
        const imgs = toolImages.get(item.callId)
        if (imgs?.length) {
          item.images = imgs
        } else if (item.toolName === 'show_image' && item.expanded && item.status === 'success') {
          // show_image 历史恢复但图片数据不可用（如已被上下文压缩清理）
          item.imageMissing = true
        }
      }
    }
    return items
  }

  /**
   * 打开一条历史会话：优先从引擎磁盘拉完整历史（权威源，修复“会话消失/串话”），
   * 引擎不可用才回退本机 localStorage 记录。
   *
   * 切会话期间 restoring=true：渲染层据此先把列表遮住，等历史落位、量完再揭幕，
   * 用户看到的是一次完整的“换页”，而不是旧列表残留 + 新列表逐条蹦出。
   * 本机缓存会先顶上，避免恢复慢时整页空白。
   */
  async function openSession(id: string) {
    errorBanner.value = null
    if (id === sessionId.value) return
    const targetId = isUuid(id) ? id : sessions.migrateId(id, createSessionId())
    // 当前会话还在跑：先把它连同 WS 交给后台 worker（不 close、不发 switch_session），
    // 这样切走以后它的流不会断，切回来还能接着看。
    const handedOff = detachCurrentToBackground()
    // 目标会话若正在后台跑：取回同一条连接和实时时间线，避免重连与整段回放。
    const worker = adoptBackgroundWorker(targetId)
    flushPersistence()
    if (!worker) {
      // 已交给后台的旧会话不收尾（否则会切断它正在长的正文）。
      if (!handedOff) endAssistantStream()
      usage.value = null
    }
    loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }
    pendingEdit.value = null
    undoConfirm.value = null
    runState.value = worker ? (worker.runState === 'idle' ? 'idle' : worker.runState) : 'syncing'
    // 云端：先让电脑端切会话（新 transports 打开时还会补发一次，这里是抢时间）。
    const previous = transport.value
    if (isCloudConnectionMode() && previous?.isAlive() && previous.hostCommands !== false && connectedSessionId !== targetId) {
      previous.send({ command: 'switch_session', session_id: targetId })
    }
    // activateSession 会作废之前所有在途恢复，新的代数在它之后取。
    activateSession(targetId)
    // 先用本机缓存里的会话目录顶上（绝不拿项目根回填）：冷启动时正文里的
    // 相对图片/文件路径从第一帧起就按会话幕布解析；引擎回来后再校准。
    cwd.value = sessions.find(targetId)?.cwd ?? ''
    if (worker) {
      transport.value = worker.transport
      connectedSessionId = targetId
      gateSessionId = targetId
      resetEventStream()
      timeline.value = worker.timeline
      usage.value = worker.usage
      loop.value = worker.loop
      retryConfirmation.value = worker.retry
      errorBanner.value = worker.banner || null
      restoring.value = false
      // 让前台流式游标落在后台正在增长的那条 assistant 上，否则新到的 delta 会另起气泡。
      const streaming = [...worker.timeline].reverse().find(item => item.kind === 'assistant' && item.streaming)
      currentAssistant.value = streaming && streaming.kind === 'assistant' ? streaming : null
      turnHadAssistantText = worker.timeline.some(item => item.kind === 'assistant' && item.content.trim().length > 0)
      turnToolTrace = []
      connect()
      return
    }
    const epoch = openEpoch
    restoring.value = true
    // 先摆本机缓存：引擎慢/离线时也有内容可量、可揭幕；引擎结果回来再整表替换。
    timeline.value = sessions.loadTranscript(targetId)
    let restoredFromEngine = false
    try {
      restoredFromEngine = await restoreFromEngine(targetId, epoch)
    } finally {
      // 期间又切走了：收尾归新的那次调用，这里不碰任何共享状态。
      if (epoch === openEpoch) {
        if (runState.value === 'syncing') runState.value = 'idle'
        restoring.value = false
        connect()
      }
    }
    if (epoch !== openEpoch || restoredFromEngine) return
    // 恢复期间用户已经发了消息（runState 不再是 idle）：实时时间线优先，不再回灌缓存。
    if (runState.value !== 'idle') return
    if (timeline.value.length > 0) {
      timeline.value.push({
        kind: 'notice', id: nextId(), tone: 'info',
        text: '已恢复本机记录。若引擎重启过，模型这边的上下文可能已经清空。',
      })
    }
  }

  function deleteSession(id: string) {
    // 先停掉待落盘的持久化定时器：被删会话不应再写回（否则会“复活”成空标题的新会话）。
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null }
    closeBackgroundWorker(id)
    if (id === sessionId.value) {
      // 删除的是当前会话：先切到新会话并重连（关闭旧 id 的 WS 连接、清空时间线），
      // 避免 flushPersistence 把已删会话写回，也避免引擎在文件删除后重建同 id 会话。
      endAssistantStream(); timeline.value = []; usage.value = null
      loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }; runState.value = 'idle'
      activateSession(createSessionId())
      connect()
    }
    sessions.remove(id)
    try { localStorage.removeItem(`coomi.draft.${id}`) } catch { /* ignore */ }
  }

  async function clearSessionData(id: string): Promise<boolean> {
    if (!window.confirm('清空该会话的消息、工具记录和上下文？会保留标题、置顶、模型与人格设置。')) return false
    try {
      const response = await authedFetch(`/api/sessions/${encodeURIComponent(id)}/clear`, { method: 'POST' })
      if (!response.ok) return false
      sessions.clearTranscript(id)
      sessions.touch(id, { turns: 0 })
      if (id === sessionId.value) {
        endAssistantStream()
        timeline.value = []
        usage.value = null
        loop.value = { active: false, currentStep: 0, totalSteps: 0, status: '' }
        runState.value = 'idle'
        reconnect()
      }
      return true
    } catch {
      return false
    }
  }

  /** 更新当前会话的工作目录（会话标记路径）。成功后引擎后续 turn 都在该目录执行。 */
  async function setSessionCwd(path: string): Promise<boolean> {
    const id = sessionId.value
    try {
      const res = await authedFetch(`/api/sessions/${id}/cwd`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: path }),
      })
      if (!res.ok) return false
      cwd.value = path
      const meta = sessions.find(id)
      if (meta) meta.cwd = path
      return true
    } catch {
      return false
    }
  }

  /** 编辑单条消息正文（改文本），成功后从引擎重新拉取时间线。 */
  /** 进入编辑模式：把旧文本回填到输入框，发送时覆盖该轮重新执行。 */
  function startEditMessage(mid: string, content: string) {
    if (isBusy.value) return
    pendingEdit.value = { mid, content }
    window.dispatchEvent(new CustomEvent('coomi:prefill-draft', {
      detail: { sessionId: sessionId.value, text: content },
    }))
  }

  /** 在气泡下方切换这一轮的历史版本（只读回看，不改执行）。 */
  function selectVersion(item: UserMessage, index: number) {
    const versions = item.versions
    if (!versions?.length) return
    const next = Math.max(0, Math.min(versions.length - 1, index))
    item.content = versions[next]
  }

  /** 取消编辑模式（输入框内容保留，可继续作为普通新消息发送）。 */
  function cancelEditMessage() {
    pendingEdit.value = null
  }

  /**
   * 编辑重发前的旧版本备份：引擎 /api/sessions/{id}/branch 会把当前磁盘上的
   * 整段会话复制成一个「· 分支」会话。必须在 edit_turn 之前完成 ——
   * 那个请求一落地就会把原文截断，之后再拷就只剩改写后的版本了。
   */
  async function saveEditBranch(): Promise<void> {
    try {
      const res = await authedFetch(`/api/sessions/${encodeURIComponent(sessionId.value)}/branch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) return
      const data = await res.json().catch(() => ({})) as { id?: string; title?: string }
      if (!data.id) return
      branchNotice.value = { id: data.id, title: data.title || '分支' }
      void sessions.syncFromEngine()
    } catch {
      /* 备份失败不阻塞编辑重发：至少新版本还能正常执行 */
    }
  }

  function openBranch() {
    const target = branchNotice.value
    branchNotice.value = null
    if (target) void openSession(target.id)
  }

  function dismissBranchNotice() {
    branchNotice.value = null
  }

  /** 点击「回撤」：先弹确认，避免误触后无法找回。 */
  function requestUndo(mid: string) {
    undoConfirm.value = { mid }
  }

  /** 确认回撤：执行截断，返回选定轮之前的状态。 */
  function confirmUndo() {
    const target = undoConfirm.value
    undoConfirm.value = null
    if (target) undoTurn(target.mid)
  }

  function cancelUndo() {
    undoConfirm.value = null
  }

  /** 回撤一轮：截断该轮 user 提问及其后的所有消息（含工具执行过程），不重新执行。 */
  function undoTurn(mid: string) {
    if (isBusy.value) return
    let cutAt = -1
    if (mid) {
      const aiIdx = timeline.value.findIndex(t => t.kind === 'assistant' && t.mid === mid)
      if (aiIdx >= 0) {
        for (let i = aiIdx; i >= 0; i--) {
          if (timeline.value[i].kind === 'user') { cutAt = i; break }
        }
      }
    }
    if (cutAt < 0) {
      for (let i = timeline.value.length - 1; i >= 0; i--) {
        if (timeline.value[i].kind === 'user') { cutAt = i; break }
      }
    }
    if (cutAt >= 0) timeline.value.splice(cutAt)
    runState.value = 'idle'
    pendingEdit.value = null
    transport.value?.send({ command: 'undo_turn', msg_id: mid })
    persistSoon()
  }

  // ── §1 平滑输出：chunk 先进缓冲，泵每拍放一批（多字一起出现）。
  //    批量大 → 快节奏（80ms）；批量小（生成慢/稀疏）→ 放慢（160ms）。
  //    流结束/持久化/换会话前全量落盘，一个字不丢。 ──
  let smoothPending = ''
  let smoothTimer: ReturnType<typeof setTimeout> | null = null
  /**
   * partial=true 时**一字一字**放：正常每拍 1 字，只有积压很大（模型吐得飞快）才小幅加速到 3 字/拍。
   * 以前按「缓冲的 1/4」放，一个 chunk 里常带换行 —— 于是多行同时出字，看着就不是逐字。
   * 收尾（默认 false）一次放完，一个字不丢。
   */
  function flushAssistantPending(partial = false) {
    if (smoothTimer) { clearTimeout(smoothTimer); smoothTimer = null }
    if (!smoothPending) return
    let chunk = smoothPending
    if (partial && smoothPending.length > 0) {
      const take = Math.max(1, Math.min(3, Math.ceil(smoothPending.length / 60)))
      chunk = smoothPending.slice(0, take)
      smoothPending = smoothPending.slice(take)
    } else {
      smoothPending = ''
    }
    // 指针失效（切会话/时间线重建）时不能把这段 pending 丢掉 ——
    // 重新锚定到新的末位助手块继续落字，否则用户会看到「正文少了一截」。
    if (!currentAssistant.value || !timeline.value.includes(currentAssistant.value)) {
      const lastAssistant = [...timeline.value].reverse().find(item => item.kind === 'assistant')
      if (lastAssistant) currentAssistant.value = lastAssistant
    }
    const anchor = currentAssistant.value
    if (anchor && timeline.value.includes(anchor)) anchor.content += chunk
  }
  /** 16ms 一拍 ≈ 60 字/秒，肉眼就是连续逐字；积压很大时提到 8ms 追赶（最多约 250 字/秒）。 */
  function pumpSmooth() {
    if (smoothTimer) return
    smoothTimer = setTimeout(() => {
      smoothTimer = null
      flushAssistantPending(true)
      if (smoothPending) pumpSmooth()
    }, smoothPending.length > 120 ? 8 : 16)
  }
  /** 流式诊断：记录每个 delta 的到达时间与长度（控制台可读 window.__coomiStreamStats）。 */
/** 上下文估算：CJK 约 1 字 1 token，ASCII 约 4 字符 1 token（引擎没发 usage 时的兜底）。 */
function estimateContextTokens(): number {
  let tokens = 0
  try {
    for (const item of timeline.value as Array<{ content?: string }>) {
      const text = item && typeof item.content === 'string' ? item.content : ''
      for (const ch of text) {
        tokens += ch.charCodeAt(0) > 0x2e80 ? 1 : 0.25
      }
    }
  } catch {
    return 0
  }
  return Math.round(tokens)
}

function noteStreamDelta(chars: number) {
  if (typeof window === 'undefined') return
  const w = window as unknown as { __coomiStreamStats?: { count: number; chars: number; firstAt: number; lastAt: number } }
  if (!w.__coomiStreamStats) w.__coomiStreamStats = { count: 0, chars: 0, firstAt: Date.now(), lastAt: Date.now() }
  const s = w.__coomiStreamStats
  s.count += 1
  s.chars += chars
  s.lastAt = Date.now()
  if (s.count % 20 === 0) console.info('[stream] deltas=' + s.count + ' chars=' + s.chars + ' span=' + (s.lastAt - s.firstAt) + 'ms')
}

function appendAssistant(content: string) {
    // 空串不建气泡：否则时间线里会留一个永远没有内容的 assistant 块，
    // 既占位置又会把“本轮没有正文”的判断弄反。
    if (!content) return
    // 流式取证：每个 delta 的到达时间与长度都记账（控制台可读 window.__coomiStreamStats）
    // —— 「正文整段闪现」这类问题就是靠它分清「一次到达」还是「被渲染层吞了」。
    noteStreamDelta(content.length)
    // 指针防失效：若时间线被整表重建（历史恢复/清空）而流式仍在收（切走不中断流式，
    // store 继续收），旧指针指向的对象已不在数组里 —— 重新锚定到新的末位助手块，
    // 不能往孤儿对象里攒字（切回来就看不到）。
    let anchor = currentAssistant.value
    if (!anchor || !timeline.value.includes(anchor)) {
      timeline.value.push({ kind: 'assistant', id: nextId(), mid: '', content: '', streaming: true, startedAt: Date.now() })
      // 必须拿 push 之后数组里的那个对象：ref 会把它包成代理，
      // 直接改 push 进去的原始对象不触发渲染，流式文本就只会停在第一片。
      anchor = timeline.value[timeline.value.length - 1] as AssistantMessage
      currentAssistant.value = anchor
    }
    if (!config.smoothOutput) { anchor.content += content; return }
    smoothPending += content
    pumpSmooth()
  }
  function endAssistantStream() {
    flushAssistantPending()
    // 同样先确认指针仍属于当前时间线：孤儿对象（已被整表重建淘汰）没有收尾的意义。
    const cur = currentAssistant.value
    if (cur) {
      if (timeline.value.includes(cur)) {
        cur.streaming = false
        if (cur.endedAt === undefined) {
          cur.endedAt = Date.now()
          cur.speedTps = usage.value?.outputTokensPerSecond ?? null
        }
      }
      currentAssistant.value = null
    }
  }
  function appendReasoning(content: string) {
    const last = timeline.value[timeline.value.length - 1]
    if (last && last.kind === 'reasoning') { (last as ReasoningBlock).content += content }
    else { timeline.value.push({ kind: 'reasoning', id: nextId(), content, expanded: false }) }
  }
  function patchTool(callId: string, fn: (c: ToolCard) => void): boolean {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'tool' && t.callId === callId) { fn(t); return true } }
    return false
  }
  function patchQuestion(callId: string, fn: (q: QuestionCard) => void) {
    for (let i = timeline.value.length - 1; i >= 0; i--) { const t = timeline.value[i]; if (t.kind === 'question' && t.callId === callId) { fn(t); return } }
  }
  /**
   * 同一条错误会在多个事件里重复到达（turn_end 的 upstream_unavailable、
   * agent_error、turn_notice 的 upstream-error），以前每条都写进时间线，
   * 用户看到三张一样的红色提示。这里按文本做 20s 去重，只留一条。
   */
  let lastErrorNotice = { text: '', at: 0 }
  function pushNotice(tone: 'info' | 'warn' | 'error' | 'success', text: string) {
    if (tone === 'error') {
      const now = Date.now()
      const normalized = text.trim()
      if (normalized && normalized === lastErrorNotice.text && now - lastErrorNotice.at < 20_000) return
      lastErrorNotice = { text: normalized, at: now }
    }
    timeline.value.push({ kind: 'notice', id: nextId(), tone, text })
  }

  /** 错误横幅也只留一条：同一文本 30s 内不重复刷新（避免重试时闪同一句话）。 */
  let lastBanner = { text: '', at: 0 }
  function setErrorBanner(message: string): void {
    const text = String(message || '').trim()
    if (!text) return
    const now = Date.now()
    if (text === lastBanner.text && now - lastBanner.at < 30_000) return
    lastBanner = { text, at: now }
    errorBanner.value = text.slice(0, 400)
  }

  async function consentToolFailureFeedback(noticeId: string): Promise<boolean> {
    const notice = timeline.value.find(item => item.kind === 'notice' && item.id === noticeId)
    if (notice?.kind !== 'notice' || !notice.analysisTrace?.length) return false
    if (!['consent', 'failed'].includes(notice.analysisStatus ?? '')) return false
    const trace = notice.analysisTrace
    const failureCount = notice.failureCount ?? trace.filter(item => item.status === 'error').length
    updateAnalysisNotice(noticeId, {
      analysisStatus: 'analyzing', feedbackEligible: false, detail: undefined,
      text: '正在后台轻量整理工具调用错误，完成后将自动上传。您可以继续对话。',
    })
    persistSoon()
    try {
      const response = await authedFetch('/api/tool-failure-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider_id: config.currentProviderId,
          trace: trace.map(({ callId: _callId, ...item }) => item),
        }),
      })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const data = await response.json()
      const analysis = typeof data.analysis === 'string' ? data.analysis.trim() : ''
      if (!analysis) throw new Error('empty analysis')
      updateAnalysisNotice(noticeId, {
        analysisStatus: 'ready', feedbackEligible: false,
        text: `已完成 ${failureCount} 次工具失败的脱敏整理，正在自动上传。`,
        detail: `${analysis}\n\n${buildLocalEvidence(trace)}`,
      })
      persistSoon()
      return true
    } catch (error) {
      updateAnalysisNotice(noticeId, {
        analysisStatus: 'failed', feedbackEligible: true, detail: undefined,
        text: `反馈整理失败，未上传任何内容：${error instanceof Error ? error.message : String(error)}。可点击重试。`,
      })
      persistSoon()
      return false
    }
  }

  function finishToolFailureFeedback(noticeId: string, ok: boolean, reason = '') {
    updateAnalysisNotice(noticeId, ok ? {
      analysisStatus: 'complete', feedbackEligible: false,
      text: '工具调用错误记录已完成脱敏整理并自动上传，感谢您的反馈。',
      analysisTrace: undefined,
    } : {
      analysisStatus: 'ready', feedbackEligible: true,
      text: `整理已完成，但自动上传失败${reason ? `：${reason}` : ''}。可直接重试上传，无需再次调用模型。`,
    })
    persistSoon()
  }

  // ── 端到端模式：失败后按配置的接力模型切换重试 ──────────────────────────
  const endToEndMode = ref(false)
  let _errorRetryCount = 0
  let _fallbackIndex = -1
  let _errorRetryTimer: ReturnType<typeof setTimeout> | null = null

  function toggleEndToEndMode() {
    endToEndMode.value = !endToEndMode.value
    transport.value?.send({ command: 'set_end_to_end_mode', enabled: endToEndMode.value })
    if (!endToEndMode.value) {
      _errorRetryCount = 0
      _fallbackIndex = -1
      if (_errorRetryTimer) clearTimeout(_errorRetryTimer)
    }
  }

  function resetErrorRetry() {
    _errorRetryCount = 0
    _fallbackIndex = -1
    if (_errorRetryTimer) clearTimeout(_errorRetryTimer)
  }

  // ── 逆向模式 ────────────────────────────────────────────────────────────
  //
  // 三态：意图(config.reverseModeTarget) / 生效(reverseModeCommitted) / 待生效(pending)
  //
  // 为什么要三态而不是一个布尔：run_turn 在**本轮开始时**就拼好了 system prompt，
  // 生成中翻开关对这一轮没有意义。所以生成中只记 pending，等 turn_end 再下发，
  // 引擎侧也独立做了同一道闸（多设备同时连一个会话时，别的客户端无法绕过前端）。
  const reverseModeCommitted = ref(false)
  const reverseModePending = ref(false)
  // 统一从这里取 localStorage：SSR / 隐私模式下 window 可能不存在，
  // 传进去的是 undefined，工具函数内部会安全地返回 false/null。
  const storage = typeof localStorage !== 'undefined' ? localStorage : undefined
  const reverseConsented = ref(hasValidConsent(storage))
  const reverseSheetOpen = ref(false)
  const reverseServerFlavors = ref<string[]>([])
  const reverseHealth = ref<'off' | 'active' | 'restricted' | 'broken'>(
    config.reverseModeTarget && hasValidConsent(storage) ? 'active' : 'off',
  )
  const reverseConsentAt = ref<number | null>(readConsent(storage)?.at ?? null)
  /** 引擎回报的契约摘要（SHA-256 前 8 位）。实验性选项页的诊断区用它。 */
  const reverseContractDigest = ref('')
  /** 引擎回报的「已注入片段」中文名列表。 */
  const reverseActiveSegments = ref<string[]>([])

  /** 真正把意图下发给引擎。生成中不允许调用 —— 只改 pending。 */
  function commitReverseMode(enabled: boolean, flavor?: ReverseFlavor) {
    reverseModeCommitted.value = enabled
    config.setReverseModeTarget(enabled)
    transport.value?.send({
      command: 'set_reverse_mode',
      enabled,
      flavor: flavor ?? config.reverseFlavor,
      // 严格模式（实验性）：随开关一起下发。引擎侧据此选「常规 / 严格」那一套掩码资产。
      segments: experimentsToSegments(config.reverseExperiments),
    })
  }

  /** 把攒下的 pending 落地（turn_end 时调用）。 */
  function flushReverseMode() {
    if (!reverseModePending.value) return
    reverseModePending.value = false
    commitReverseMode(config.reverseModeTarget)
  }

  /**
   * 用户点 pill。返回这次操作是否已生效（false = 生成中，等本轮结束）。
   *
   * 未同意免责声明时只打开面板，不改变任何状态 —— 避免「看起来开了」。
   */
  function toggleReverseMode() {
    if (!reverseConsented.value) {
      reverseSheetOpen.value = true
      return false
    }
    const next = !config.reverseModeTarget
    if (runState.value === 'idle') {
      reverseModePending.value = false
      commitReverseMode(next)
      reverseHealth.value = next ? 'active' : 'off'
      return true
    }
    // 生成中：只记意图。health 保持现状，pill 会显示「待生效」。
    config.setReverseModeTarget(next)
    reverseModePending.value = true
    return false
  }

  /** 用户同意风险提示。同意后才允许开启。 */
  function acceptReverseConsent() {
    // 存秒级时间戳：与 readConsent 的返回值同单位，避免两处混用毫秒/秒。
    const at = Math.floor(Date.now() / 1000)
    const record = writeConsent(storage, at)
    reverseConsented.value = record !== null
    reverseConsentAt.value = record?.at ?? null
    // 同意即视为本次开启的意图。生成中同样走 pending 分支。
    if (runState.value === 'idle') {
      commitReverseMode(true)
      reverseHealth.value = 'active'
    } else {
      config.setReverseModeTarget(true)
      reverseModePending.value = true
    }
    reverseSheetOpen.value = false
    return true
  }

  /** 用户拒绝。直接关面板，不写任何状态。 */
  function declineReverseConsent() {
    reverseSheetOpen.value = false
  }

  /** 长按选口味。引擎活着就立刻下发；生成中则等本轮结束。 */
  function chooseReverseFlavor(flavor: ReverseFlavor) {
    config.setReverseFlavor(flavor)
    if (!config.reverseModeTarget) {
      reverseSheetOpen.value = false
      return
    }
    if (runState.value === 'idle') {
      commitReverseMode(true, flavor)
    } else {
      reverseModePending.value = true
    }
    reverseSheetOpen.value = false
  }

  /**
   * 严格模式开关变了：把当前状态重发一遍，让引擎切到另一套资产。
   *
   * 为什么不并进 chooseReverseFlavor：严格模式与口味是两条正交的轴 ——
   * 用户可能只想开硬条款而不换口味。生成中同样走 pending，等本轮结束才落地。
   */
  function resyncReverseStrict() {
    if (!config.reverseModeTarget) return
    if (runState.value === 'idle') {
      commitReverseMode(true)
    } else {
      reverseModePending.value = true
    }
  }

  function openReverseSheet() { reverseSheetOpen.value = true }
  function closeReverseSheet() { reverseSheetOpen.value = false }


  /** 端到端：当前模型连续失败达到阈值时，切换到下一个接力模型并重试。 */
  function cycleEndToEndModel() {
    const fallbacks = config.endToEndFallbacks
    if (fallbacks.length === 0) return
    _fallbackIndex = (_fallbackIndex + 1) % fallbacks.length
    const next = fallbacks[_fallbackIndex]
    if (!next) return
    config.selectModel(next.providerId, next.model)
    transport.value?.send({ command: 'select_model', provider_id: next.providerId, model: next.model })
    sessions.setModel(sessionId.value, next.providerId, next.model)
    pushNotice('info', `端到端模式：切换接力模型 ${next.model} 后重试`)
  }

  function updateAnalysisNotice(id: string, patch: Partial<Extract<Timelineitem, { kind: 'notice' }>>) {
    const notice = timeline.value.find(item => item.kind === 'notice' && item.id === id)
    if (notice?.kind === 'notice') Object.assign(notice, patch)
  }

  return { sessionId, mode, timeline, plan, isBackgroundRunning, uploadAttachment, runState, restoring, usage, timing, refreshTiming, retryConfirmation, cwd, loop, collaboration, isBusy, turnBlock, configPrompt, configureModel, dismissConfigPrompt, activeAssistantId, streamActive, pendingEdit, branchNotice, branchSaving, openBranch, dismissBranchNotice, undoConfirm, lastUserMessage, lastAssistantMessage, pendingApproval, pendingQuestion, errorBanner, dismissErrorBanner, lifeUnread, lifeUnreadName, lifeDelivering, isGlobalSession, resolveLifeMode, syncLifeMode, refreshLifeUnread, deliverLife, autoDeliverLifeIfReady, connect, reconnect, disconnect, flushPersistence, sendMessage, cancel, approve, answerQuestion, setPermissionMode, setReasoningEffort, setSessionMode, togglePlanMode, selectModel, retryInterruptedTurn, continueInterruptedTurn, dismissRetry, completeFileTransfer, newSession, openSession, deleteSession, clearSessionData, setSessionCwd, startEditMessage, cancelEditMessage, selectVersion, requestUndo, confirmUndo, cancelUndo, undoTurn, sendGuide, consentToolFailureFeedback, finishToolFailureFeedback, attachedFiles, addAttachedFile, removeAttachedFile, clearAttachedFiles, endToEndMode, toggleEndToEndMode, resetErrorRetry, notifyUserIfBackground,
    reverseModeCommitted, reverseModePending, reverseConsented, reverseSheetOpen,
    reverseHealth, reverseConsentAt, reverseServerFlavors,
    reverseContractDigest, reverseActiveSegments,
    toggleReverseMode, acceptReverseConsent, declineReverseConsent,
    chooseReverseFlavor, openReverseSheet, closeReverseSheet, resyncReverseStrict,
  }
})

function fmtTokens(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n) }

/** 生命体待投递问候（/api/life/unread 返回的 pending 项）。 */
interface LifeUnreadItem {
  id: string
  text: string
  trigger: string
  lifeName?: string
  createdAtMs?: number
}

function sanitizeToolName(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'unknown_tool'
}

function classifyToolError(message: string): string {
  const text = message.toLowerCase()
  if (/permission|denied|allowed area/.test(text)) return 'permission_or_sandbox'
  if (/timeout|timed out/.test(text)) return 'timeout'
  if (/not found|enoent/.test(text)) return 'not_found'
  if (/invalid|schema|argument|parse/.test(text)) return 'invalid_arguments'
  if (/network|connect|dns|http/.test(text)) return 'network_or_upstream'
  return 'execution_error'
}

function summarizeArguments(value: unknown, key = '', depth = 0): unknown {
  if (depth > 4) return '[max_depth]'
  if (value === null) return '[null]'
  if (Array.isArray(value)) return value.slice(0, 12).map(item => summarizeArguments(item, key, depth + 1))
  if (typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 30).map(([childKey, child]) => [
      childKey.replace(/[^a-zA-Z0-9_.:-]/g, '').slice(0, 80) || 'field',
      summarizeArguments(child, childKey, depth + 1),
    ]))
  }
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return '[number]'
  if (typeof value !== 'string') return `[${typeof value}]`
  const text = value.trim()
  const lowerKey = key.toLowerCase()
  if (/key|token|secret|password|authorization|credential/.test(lowerKey)) return '[redacted_secret]'
  if (/path|file|dir|cwd|destination|source/.test(lowerKey) || /^(?:\/|[a-z]:\\)/i.test(text)) {
    const extension = text.match(/\.([a-zA-Z0-9]{1,8})$/)?.[1]?.toLowerCase()
    return `[${/^(?:\/|[a-z]:\\)/i.test(text) ? 'absolute' : 'relative'}_path${extension ? ` ext=.${extension}` : ''}]`
  }
  if (/command|cmd|script/.test(lowerKey) || /[\s;&|><]/.test(text)) {
    const tokens = text.split(/\s+/).filter(Boolean)
    const executable = tokens[0]?.split(/[\\/]/).pop()?.replace(/[^a-zA-Z0-9_.+-]/g, '') || 'unknown'
    const flags = tokens.slice(1).filter(token => /^--?[a-zA-Z0-9_-]+$/.test(token)).slice(0, 12)
    return { kind: 'command_shape', executable, flags, token_count: tokens.length, has_shell_operators: /[;&|><]/.test(text) }
  }
  if (/^https?:\/\//i.test(text)) return '[url_redacted]'
  if (/^[a-zA-Z][a-zA-Z0-9_.:-]{0,31}$/.test(text)) return text
  return `[string length=${text.length}]`
}

function sanitizeDiagnosticText(message: string): string {
  return message
    .slice(0, 1200)
    .replace(/\b(?:sk-|Bearer\s+)[a-zA-Z0-9._-]{8,}\b/gi, '[redacted_secret]')
    .replace(/https?:\/\/[^\s"']+/gi, '[redacted_url]')
    .replace(/(?:[a-zA-Z]:\\|\/data\/|\/storage\/|\/sdcard\/|\/home\/)[^\s"']+/g, '[redacted_path]')
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, '[redacted_email]')
    .replace(/\b[0-9a-f]{24,}\b/gi, '[redacted_identifier]')
    .replace(/(["'])(?:(?!\1).){41,}\1/g, '[redacted_text]')
}

function buildLocalEvidence(items: ToolDiagnosticTrace[]): string {
  return [
    '【程序采集的脱敏证据】',
    '不含用户消息、原始参数值、文件内容、真实路径、URL、密钥或模型隐藏思维。',
    ...items.map(item => `#${item.sequence} ${item.tool} | ${item.status}${item.category ? ` | ${item.category}` : ''}${item.elapsedMs !== undefined ? ` | ${item.elapsedMs}ms` : ''}\n参数结构: ${JSON.stringify(item.argumentShape)}${item.errorSummary ? `\n错误摘要: ${item.errorSummary}` : ''}`),
  ].join('\n')
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const ACTIVE_SESSION_KEY = 'coomi.activeSessionId.v1'

function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value)
}

function readActiveSessionId(): string {
  try {
    const requested = new URLSearchParams(window.location.search).get('session_id') ?? ''
    if (isUuid(requested)) return requested
    const saved = localStorage.getItem(ACTIVE_SESSION_KEY) ?? ''
    if (isUuid(saved)) return saved
  } catch {
    // WebView storage can be unavailable during early startup; create a valid fallback.
  }
  return createSessionId()
}

function persistActiveSessionId(id: string) {
  try {
    localStorage.setItem(ACTIVE_SESSION_KEY, id)
  } catch {
    // Keeping the in-memory id is enough for this process lifetime.
  }
}

/** 引擎磁盘上会话文件的原始消息结构（与 coomi-engine 的 ChatMessage 对应）。 */
interface ChatMessageJson {
  id?: string
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** 模型思考文本：引擎流式产出并在本轮结束落盘（引擎 ChatMessage.reasoning）。 */
  reasoning?: string
  tool_calls?: Array<{
    id: string
    name: string
    arguments: unknown
    images?: Array<{ media_type: string; data: string }>
  }>
  tool_call_id?: string
  compaction_summary?: boolean
  internal?: boolean
  life_proactive?: boolean
  images?: Array<{ media_type: string; data: string }>
}

function createSessionId(): string {
  const cryptoApi = globalThis.crypto
  if (typeof cryptoApi?.randomUUID === 'function') return cryptoApi.randomUUID()
  const bytes = new Uint8Array(16)
  cryptoApi.getRandomValues(bytes)
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}
