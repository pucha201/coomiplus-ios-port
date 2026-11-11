import type { AgentEvent } from './events'

export type PermissionMode = 'ask' | 'auto' | 'full'
export type ApprovalDecision = 'allow' | 'deny' | 'always'
export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high' | 'xhigh' | 'ultra'
export type SessionMode = 'agent' | 'team' | 'life'

export interface SendMessageCommand { command: 'send_message'; text: string; attached_files?: { name: string; path: string; size: number; isDir?: boolean }[] }
export interface CancelCommand { command: 'cancel' }
export interface JumpInCommand { command: 'jump_in'; text: string }
export interface ApproveToolCommand { command: 'approve_tool'; call_id: string; decision: ApprovalDecision }
export interface AnswerQuestionCommand { command: 'answer_question'; call_id: string; answers: Record<string, string>; comments?: Record<string, string> }
export interface SetPermissionModeCommand { command: 'set_permission_mode'; mode: PermissionMode }
export interface SetSessionModeCommand { command: 'set_session_mode'; mode: SessionMode }
export interface EnterPlanModeCommand { command: 'enter_plan_mode' }
export interface ExitPlanModeCommand { command: 'exit_plan_mode' }
export interface SelectModelCommand { command: 'select_model'; provider_id: string; model: string }
export interface FileTransferResultCommand { command: 'file_transfer_result'; request_id: string; paths: string[] }
export interface SendGuideCommand { command: 'send_guide'; key: string }
export interface RetryTurnCommand { command: 'retry_turn' }
export interface RegenerateResponseCommand { command: 'regenerate_response'; msg_id: string }
export interface EditTurnCommand { command: 'edit_turn'; msg_id: string; text: string }
export interface UndoTurnCommand { command: 'undo_turn'; msg_id: string }
export interface SetReasoningEffortCommand { command: 'set_reasoning_effort'; effort: ReasoningEffort }
export interface SetEndToEndModeCommand { command: 'set_end_to_end_mode'; enabled: boolean }
export interface SetMaxToolRoundsCommand { command: 'set_max_tool_rounds'; rounds: number }
export interface AckEventCommand { command: 'ack_event'; event_seq: number }
/** 应用层心跳：WebView/弱网下主动探活，服务端回 connection_heartbeat。 */
export interface PingCommand { command: 'ping' }
/** 断线重连后按 seq 补发未确认事件。 */
export interface ResyncEventsCommand { command: 'resync_events'; after_seq: number }
/** 顺序门发现缺口：请引擎补发 event_seq > after_seq 的未确认事件（与 ack 配套的新命令）。 */
export interface ResyncCommand { command: 'resync'; after_seq: number }
/** 确认已按序处理到某个 seq：引擎裁掉未确认队列里 <= seq 的部分（与 resync 配套的新命令）。 */
export interface AckCommand { command: 'ack'; seq: number }
/** 数字生命体：把队列里唯一的 pending 问候投递到当前会话（气泡）。 */
export interface DeliverLifeCommand { command: 'deliver_life' }
export interface RunCollabTurnCommand { command: 'run_collab_turn'; text: string; session_id: string }
export interface CancelCollabCommand { command: 'cancel_collab' }
/** 电脑互联宿主控制：让电脑把活动会话切到手机正在看的这一条。引擎本身不识别该命令。 */
export interface SwitchSessionCommand { command: 'switch_session'; session_id: string }
/**
 * 逆向模式开关。
 *
 * 与 set_end_to_end_mode 的关键差别：**可以带 pending 语义**。
 * 引擎在生成中收到该命令时不会立刻改行为（本轮 system prompt 已拼好），
 * 而是记下意图，等本轮 turn_end 之后再生效 —— 见 ui/src/web/mod.rs 的
 * SessionTask::reverse_pending。前端据此显示「待生效」。
 */
export interface SetReverseModeCommand {
  command: 'set_reverse_mode'
  enabled: boolean
  flavor?: string
  /**
   * 契约片段开关（实验性）。引擎侧按这三位把对应掩码片段拼到基础正文后面。
   * 缺省 / 旧客户端只发 strict 布尔时，引擎侧会把它映射成 `strict` 一位。
   */
  segments?: {
    strict?: boolean
    thinkingGuide?: boolean
    thinkingFree?: boolean
    routeGuide?: boolean
  }
  /** 旧字段，仅为兼容早期客户端保留；新代码请用 `segments.strict`。 */
  strict?: boolean
}
/** 确认已阅读逆向模式的风险提示与免责声明。version 用于下次文案变更时重新征询。 */
export interface AckReverseConsentCommand { command: 'ack_reverse_consent'; version: number }
export type AgentCommand =
  | SendMessageCommand | CancelCommand | JumpInCommand | ApproveToolCommand
  | AnswerQuestionCommand | SetPermissionModeCommand | SetSessionModeCommand | EnterPlanModeCommand
  | ExitPlanModeCommand | SelectModelCommand | FileTransferResultCommand
  | SendGuideCommand | RetryTurnCommand | RegenerateResponseCommand | EditTurnCommand | UndoTurnCommand
  | SetReasoningEffortCommand | SetEndToEndModeCommand | SetMaxToolRoundsCommand | AckEventCommand
  | PingCommand | ResyncEventsCommand
  | ResyncCommand | AckCommand
  | DeliverLifeCommand | RunCollabTurnCommand | CancelCollabCommand
  | SwitchSessionCommand
  | SetReverseModeCommand | AckReverseConsentCommand

export const PROTOCOL_VERSION = 1
export type EnvelopeType = 'event' | 'command' | 'ack' | 'error'

export interface Envelope<P = unknown> {
  v: number; type: EnvelopeType; id?: string; ts: number; payload: P
}

export type EventEnvelope = Envelope<AgentEvent> & { type: 'event' }
export type CommandEnvelope = Envelope<AgentCommand> & { type: 'command' }
export type AckEnvelope = Envelope<{ ok: boolean }> & { type: 'ack' }
export type ErrorEnvelope = Envelope<{ message: string; code?: string }> & { type: 'error' }
export type InboundEnvelope = EventEnvelope | AckEnvelope | ErrorEnvelope
