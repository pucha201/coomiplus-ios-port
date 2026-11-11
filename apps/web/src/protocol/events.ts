export type ToolAccess = 'read_only' | 'write' | 'destructive'

export interface UsageInfo {
  input_tokens: number; output_tokens: number; total_tokens: number
  cached_input_tokens?: number
  cache_hit_rate?: number | null
  cache_data_available?: boolean
  turn_cache_hit_rate?: number | null
  turn_cache_data_available?: boolean
  context_ratio?: number
  context_used_tokens?: number
  context_window_tokens?: number
  first_token_latency_ms?: number | null
  output_tokens_per_second?: number | null
  turn_total_tokens?: number
}
export interface ReasoningEffortStats {
  turns: number
  cache_hit_rate: number | null
  average_duration_ms: number | null
  average_total_tokens: number | null
  cache_available: boolean
}

export interface TextChunkEvent { event_type: 'text_chunk'; content: string }
export interface ReasoningChunkEvent { event_type: 'reasoning_chunk'; content: string }
export interface ToolStartEvent { event_type: 'tool_start'; call_id: string; tool_name: string; arguments: Record<string, unknown> }
export interface ToolRunningEvent { event_type: 'tool_running'; call_id: string; tool_name: string }
export interface ToolDoneEvent { event_type: 'tool_done'; call_id: string; tool_name: string; elapsed: number; result_preview: string; result_full?: string; result_truncated?: boolean; is_error: boolean; images?: string[] }
export interface ToolCacheHitEvent { event_type: 'tool_cache_hit'; call_id: string; tool_name: string }
export interface UsageUpdateEvent {
  event_type: 'usage_update'
  usage: UsageInfo
  reasoning_efforts?: Partial<Record<'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra', ReasoningEffortStats>>
  context_categories?: Partial<Record<'system_tools' | 'messages' | 'skills' | 'mcp_tools' | 'system_prompt' | 'other', number>>
}
export interface ConnectionRetryEvent { event_type: 'connection_retry'; attempt: number; max_attempts: number; delay?: number; delay_ms?: number; message: string }
export interface StreamResetEvent { event_type: 'stream_reset' }
export interface CompressionEvent { event_type: 'compression'; before: number; after: number }
export interface AgentErrorEvent { event_type: 'agent_error'; message: string; is_fatal: boolean }
/**
 * 引擎跑不动这一轮，因为模型配置不可用。reason 由引擎给出：
 * 'not_configured' = 从来没配过；'invalid_config' = 配过但文件读不出来。
 * route 只是候选入口，前端只认白名单，且绝不自动跳（见 utils/configPrompt.ts）。
 */
export interface ConfigurationRequiredEvent {
  event_type: 'configuration_required'
  message: string
  route?: string
  reason?: 'not_configured' | 'invalid_config'
}
/**
 * 本轮被中断（上游不可用 / 安全上限 / 时间用量兜底）：引擎在**不发 agent_error** 的情况下暂停任务。
 * 字段已与 apps/coomi-rs/ui/src/web/mod.rs 的 push_event 对齐：
 *   reason: 'tool_round_ceiling' | 'turn_budget' | 'upstream_unavailable'；rounds_used / rounds_limit: u64；
 *   last_tool: 中断瞬间正在跑的工具名（可能是空串）；resumable: 能否继续。
 * 工具次数不设上限：tool_round_ceiling 只是空转死循环的安全哨兵。
 */
export interface RetryConfirmationEvent {
  event_type: 'retry_confirmation'
  message: string
  detail?: string
  reason?: string
  rounds_used?: number
  rounds_limit?: number
  last_tool?: string
  resumable?: boolean
}
export interface AgentCancelledEvent { event_type: 'agent_cancelled' }
export interface BgTaskDetachedEvent { event_type: 'bg_task_detached'; task_id: string; tool_name: string }
export interface BgTaskCompletedEvent { event_type: 'bg_task_completed'; task_id: string; tool_name: string; is_error: boolean }
export interface PlanStepItem { text: string; status: 'pending' | 'in_progress' | 'completed' }
export interface PlanUpdatedEvent {
  event_type: 'plan_updated'
  explanation?: string | null
  steps: PlanStepItem[]
  completed: number
  total: number
}
export interface LoopStepStartEvent { event_type: 'loop_step_start'; step_index: number; step_description: string; total_steps: number }
export interface LoopStepDoneEvent { event_type: 'loop_step_done'; step_index: number; success: boolean }
export interface LoopProgressEvent { event_type: 'loop_progress'; current_step: number; total_steps: number; status: string }
export interface LoopIssueCreatedEvent { event_type: 'loop_issue_created'; step_index: number; step_description: string }
export interface ToolApprovalRequestEvent { event_type: 'tool_approval_request'; call_id: string; tool_name: string; arguments: Record<string, unknown>; access: ToolAccess; risk_summary?: string; }
export interface UserQuestionOption { label: string; description: string }
export interface UserQuestion { id: string; header: string; question: string; options: UserQuestionOption[] }
export interface UserQuestionRequestEvent { event_type: 'user_question_request'; call_id: string; questions: UserQuestion[] }
export interface FileTransferRequestEvent { event_type: 'file_transfer_request'; request_id: string; operation: 'import' | 'export'; path?: string; suggested_name?: string; multiple: boolean }
export interface TurnEndEvent {
  event_type: 'turn_end'
  artifacts?: { path: string; name: string; size?: number; added?: number; removed?: number; diff?: string; change?: string }[]
  /**
   * 引擎侧真实计时（毫秒）。会话累计值走 `/api/sessions/{id}/timing`；
   * 前端只做「加上本轮」，不再用会话档案年龄推算，也不做秒/毫秒换算。
   */
  elapsed_ms?: number
  llm_ms?: number
  tool_ms?: number
  /** 本轮逐次写入记录（不合并，按发生顺序）。 */
  actions?: { tool?: string; path: string; added?: number; removed?: number; change?: string }[]
  ok?: boolean
  status?: 'succeeded' | 'failed' | 'completed_without_text' | 'cancelled' | string
  reason?: string
  finish_reason?: string
  more_queued?: boolean
}
/** 引擎在轮次内部发出的可见提示（空回复重试 / 输出上限续写 / 目标继续）。 */
export interface TurnNoticeEvent { event_type: 'turn_notice'; kind?: string; message: string }
/** 端到端循环没有新进展或达到上限：以前前端没有分支，事件被静默丢弃。 */
export interface LoopGuardEvent { event_type: 'loop_guard'; message: string }
/** 重连补发：会话是否正在后台执行（切走会话后任务继续跑）。 */
export interface SessionStateEvent { event_type: 'session_state'; running: boolean }
/**
 * 逆向模式的实际状态（引擎口径，不是前端意图）。
 *
 * health 是唯一能证明「契约真的生效了」的信号：
 *   off        未开启
 *   active     契约已注入，正常
 *   restricted 开着但环境受限（只读权限或无可用模型），契约不会注入
 *   broken     契约资产校验失败（被篡改/损坏），注入被拒绝
 * 顶栏盾牌直接映射这四态，用户不必猜。
 */
export interface ReverseStateEvent {
  event_type: 'reverse_state'
  reverse: {
    enabled: boolean
    flavor: string
    flavorLabel: string
    health: 'off' | 'active' | 'restricted' | 'broken'
    flavors: string[]
    /** 当前启用的契约片段（实验性）。旧版引擎不回这几个字段。 */
    segments?: {
      strict: boolean
      thinkingGuide: boolean
      thinkingFree: boolean
      routeGuide?: boolean
    }
    /** 已注入片段的中文名，给诊断区展示。 */
    activeSegments?: string[]
    /** 拼接后契约的 SHA-256 前 8 位。 */
    contractDigest?: string
  }
}
export interface SessionLoadedEvent {
  event_type: 'session_loaded'
  session_id: string
  cwd: string
  usage: { input_tokens: number; output_tokens: number; total_tokens: number }
}
/** 数字生命体主动消息投递完成（气泡/开场问候）。 */
export interface LifeDeliveredEvent {
  event_type: 'life_delivered'
  message_id: string
  trigger: string
  text: string
}
export interface CollaborationStartedEvent { event_type: 'collaboration_started'; cycles: number }
export interface CollaborationPhaseEvent { event_type: 'collaboration_phase'; phase: 'coder' | 'reviewer'; cycle: number; status: string }
export interface CollaborationReviewEvent { event_type: 'collaboration_review'; cycle: number; status: 'approved' | 'findings' | 'error'; content: string }
export interface CollaborationFinishedEvent { event_type: 'collaboration_finished'; cycle?: number; status?: 'approved' | 'findings' | 'error'; summary?: string }
  // ── 协同工作台（Collab 模式）──
  export interface CollabAgentStatusEvent { event_type: "collab_agent_status"; agent_id: string; role_name: string; status: "idle" | "running" | "done" | "error"; current_message: string }
  export interface CollabAgentChunkEvent { event_type: "collab_agent_chunk"; agent_id: string; content: string }
  export interface CollabAgentReasoningEvent { event_type: "collab_agent_reasoning"; agent_id: string; content: string }
  export interface CollabAgentMessageEvent { event_type: "collab_agent_message"; from: string; to: string; content: string; ts: string }
  export interface CollabAgentToolEvent { event_type: "collab_agent_tool"; agent_id: string; tool: Record<string, unknown> }
  export interface CollabTaskStartedEvent { event_type: "collab_task_started"; task_id: string; task_text?: string }
  export interface CollabFinishedEvent2 { event_type: "collab_finished"; summary?: string }
  // ── 文件访问事件 ──
  export interface CollabFileReadEvent { event_type: "collab_file_read"; agent_id: string; file_path: string; ts: string }
  export interface CollabFileWriteEvent { event_type: "collab_file_write"; agent_id: string; file_path: string; mode: "write" | "edit" | "patch"; ts: string }
  export interface CollabArchitectureReadyEvent { event_type: "collab_architecture_ready"; files: string[]; summary: string }
  export interface CollabTaskAssignedEvent { event_type: "collab_task_assigned"; assignments: Array<{ agent_id: string; task: string; priority: number }> }
  // orchestrated：拆解计划 / 子任务状态 / 阶段 / 汇总结果
  export interface CollabPlanReadyEvent { event_type: "collab_plan_ready"; task_id?: string; phase?: string; subtasks: Array<{ id?: string; agent_id?: string; agentId?: string; instruction?: string; status?: string }>; merge_prompt?: string }
  export interface CollabSubtaskStatusEvent { event_type: "collab_subtask_status"; task_id?: string; agent_id: string; subtask_id?: string; status: string; error?: string; output_length?: number }
  export interface CollabOrchestrationPhaseEvent { event_type: "collab_orchestration_phase"; task_id?: string; phase: string }
  export interface CollabMergeResultEvent { event_type: "collab_merge_result"; task_id?: string; content: string }
  /** WebSocket 心跳：含 next_seq 供客户端断线补发对齐。 */
  export interface ConnectionHeartbeatEvent { event_type: "connection_heartbeat"; next_seq?: number; running?: boolean; pong?: boolean }
  // ── 排队 / 插话 / 打断 / 重新同步 ──
  export interface TurnInterruptedEvent { event_type: 'turn_interrupted'; message?: string }
  export interface InterjectionQueuedEvent { event_type: 'interjection_queued'; id?: string; index?: number; text?: string }
  export interface MessageQueuedEvent { event_type: 'message_queued'; index?: number; text?: string }
  export interface QueueClearedEvent { event_type: 'queue_cleared'; removed?: number }
  export interface ResyncResultEvent {
    event_type: 'resync_result'
    requested_after_seq?: number
    oldest_seq?: number
    latest_seq?: number
    truncated?: boolean
  }

export type AgentEvent = (
  | TextChunkEvent | ReasoningChunkEvent | ToolStartEvent | ToolRunningEvent
  | ToolDoneEvent | ToolCacheHitEvent | UsageUpdateEvent | ConnectionRetryEvent | StreamResetEvent
  | CompressionEvent | AgentErrorEvent | ConfigurationRequiredEvent | AgentCancelledEvent | BgTaskDetachedEvent
  | BgTaskCompletedEvent | PlanUpdatedEvent | LoopStepStartEvent | LoopStepDoneEvent | LoopProgressEvent
  | LoopIssueCreatedEvent | RetryConfirmationEvent | ToolApprovalRequestEvent | UserQuestionRequestEvent
  | FileTransferRequestEvent
  | TurnEndEvent | TurnNoticeEvent | LoopGuardEvent
  | SessionStateEvent
  | ReverseStateEvent
  | SessionLoadedEvent
  | LifeDeliveredEvent
  | CollaborationStartedEvent | CollaborationPhaseEvent | CollaborationReviewEvent | CollaborationFinishedEvent | CollabAgentStatusEvent | CollabAgentChunkEvent | CollabAgentReasoningEvent | CollabAgentMessageEvent | CollabAgentToolEvent | CollabTaskStartedEvent | CollabFinishedEvent2 | CollabFileReadEvent | CollabFileWriteEvent | CollabArchitectureReadyEvent | CollabTaskAssignedEvent | CollabPlanReadyEvent | CollabSubtaskStatusEvent | CollabOrchestrationPhaseEvent | CollabMergeResultEvent | ConnectionHeartbeatEvent
  | TurnInterruptedEvent | InterjectionQueuedEvent | MessageQueuedEvent | QueueClearedEvent | ResyncResultEvent
) & { event_seq?: number }

export type AgentEventType = AgentEvent['event_type']
