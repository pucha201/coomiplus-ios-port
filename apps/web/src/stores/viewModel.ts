import type { ToolAccess, UserQuestion } from '@/protocol/events'

export type ToolCardStatus = 'starting' | 'running' | 'success' | 'error' | 'awaiting_approval' | 'cache_hit' | 'cancelled'

export interface ToolCard {
  kind: 'tool'
  callId: string
  toolName: string
  arguments: Record<string, unknown>
  status: ToolCardStatus
  elapsed?: number
  /** 折叠/错误分类用的短预览（1040 字以内）。 */
  resultPreview?: string
  /** 展开态用的完整输出（实时最多 64KB；历史为磁盘全文）。 */
  resultFull?: string
  /** 完整输出是否被引擎截断（需要走 tool-output 接口取全文）。 */
  resultTruncated?: boolean
  isError?: boolean
  access?: ToolAccess
  riskSummary?: string
  expanded?: boolean
  /** 工具产生的图片（data URL），瀑布流渲染用。 */
  images?: string[]
  /** show_image 历史恢复但图片数据不可用（如已被上下文压缩清理）。 */
  imageMissing?: boolean
}

/** 一次写入动作（「记录」页一条）。同一文件写两次就是两条。 */
export interface TurnAction {
  tool?: string
  path: string
  added?: number
  removed?: number
  change?: string
}

export interface TurnFileChange {
  path: string
  name: string
  size?: number
  /** 本轮新增 / 删除的行数；引擎拿不到时为 undefined。 */
  added?: number
  removed?: number
  /** 统一 diff 文本（`--- a/…` + hunks）；拿不到修改前内容时为空。 */
  diff?: string
  /** add / modify / delete。 */
  change?: 'add' | 'modify' | 'delete' | string
}

export interface AssistantMessage {
  kind: 'assistant'; id: string; mid: string; content: string; streaming: boolean
  life?: boolean; startedAt?: number; endedAt?: number; speedTps?: number | null
  /** 本轮改动的文件汇总（turn_end 时下发），有内容才在气泡下方显示一张框。 */
  files?: TurnFileChange[]
  /** 本轮逐次写入记录；与 files 一起展示在「记录」页。 */
  actions?: TurnAction[]
}
export interface UserMessage {
  kind: 'user'; id: string; mid: string; content: string
  attachedFiles?: { name: string; path: string; size: number; isDir?: boolean }[]
  /**
   * 编辑重发留下的历史版本（原文在前、最新在后）。
   * 只在「这一轮被重写过」时存在；有它才显示 < n/N > 切换。
   */
  versions?: string[]
}
export interface ReasoningBlock { kind: 'reasoning'; id: string; content: string; expanded: boolean }

export interface QuestionCard {
  kind: 'question'; callId: string; questions: UserQuestion[]
  answered: boolean; answers?: Record<string, string>
  /** 用户补充说明（可选，回复/补充）。key = question id */
  comments?: Record<string, string>
}

export interface NoticeItem {
  kind: 'notice'
  id: string
  tone: 'info' | 'warn' | 'error' | 'success'
  text: string
  detail?: string
  feedbackEligible?: boolean
  analysisStatus?: 'consent' | 'analyzing' | 'ready' | 'uploading' | 'complete' | 'failed'
  analysisTrace?: ToolDiagnosticTrace[]
  failureCount?: number
}

export interface ToolDiagnosticTrace {
  callId?: string
  sequence: number
  tool: string
  argumentShape: unknown
  status: 'running' | 'error' | 'success'
  category?: string
  errorSummary?: string
  elapsedMs?: number
}

export type Timelineitem = UserMessage | AssistantMessage | ReasoningBlock | ToolCard | QuestionCard | NoticeItem

export type RunState = 'idle' | 'syncing' | 'thinking' | 'executing' | 'awaiting_approval' | 'awaiting_question'

export interface LoopProgress {
  active: boolean; currentStep: number; totalSteps: number
  status: string; currentDescription?: string
}
