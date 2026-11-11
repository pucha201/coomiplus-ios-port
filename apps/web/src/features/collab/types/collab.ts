export type CollabTaskStatus =
  | 'draft'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'interrupted'
  | 'queued'

export type CollabAgentStatus =
  | 'pending'
  | 'starting'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type CollabRoleType = 'commander' | 'architect' | 'developer' | 'reviewer' | 'tester'

export interface CollabRole {
  id: string
  name: string
  modelSelector: string
  prompt: string
  color: string
  icon: string
  visibility: 'full' | 'summary'
  roleType?: CollabRoleType
  /** Legacy settings payload compatibility. */
  role_type?: CollabRoleType
  /** 允许写入路径前缀（空=不限） */
  allowedPaths?: string[]
  /** 禁止写入路径前缀 */
  forbiddenPaths?: string[]
}

export interface CollabAgent {
  id: string
  roleId: string
  status: CollabAgentStatus
  currentMessage: string
  output: string
  reasoning: string
  tools: CollabAgentTool[]
  activities: CollabActivity[]
  startedAt?: string
  finishedAt?: string
  error?: string
}

export interface CollabActivity {
  id: string
  kind: 'reasoning' | 'tool' | 'text'
  tsMs: number
  content: string
  toolName?: string
  toolStatus?: string
  refId?: string
}

export interface CollabAgentTool {
  id: string
  name: string
  arguments?: Record<string, unknown>
  status: 'running' | 'done' | 'error'
  output?: string
}

export interface CollabMessage {
  id: string
  from: string
  to: string
  content: string
  createdAt: string
  kind: 'instruction' | 'result' | 'system'
}

export interface CollabArtifact {
  id: string
  agentId?: string
  path: string
  action: 'read' | 'write' | 'edit' | 'patch' | 'download'
  createdAt: string
  modifiedAt: string
}

export type CollabEvent =
  | { id: string; seq?: number; type: 'agent_status'; createdAt: string; agentId: string; status: CollabAgentStatus; message: string }
  | { id: string; seq?: number; type: 'agent_output'; createdAt: string; agentId: string; content: string }
  | { id: string; seq?: number; type: 'agent_reasoning'; createdAt: string; agentId: string; content: string }
  | { id: string; seq?: number; type: 'message'; createdAt: string; message: CollabMessage }
  | { id: string; seq?: number; type: 'artifact'; createdAt: string; artifact: CollabArtifact }
  | { id: string; seq?: number; type: 'task_assigned'; createdAt: string; assignments: Array<{ agentId: string; task: string; priority: number }> }
  | { id: string; seq?: number; type: 'architecture_ready'; createdAt: string; files: string[]; summary: string }
  | { id: string; seq?: number; type: 'task_finished'; createdAt: string; summary: string }

export interface CollabSummary {
  text: string
  completedAgents: number
  failedAgents: number
}

export type CollabOrchestrationPhase = 'planning' | 'executing' | 'merging' | 'done'

export type CollabSubtaskStatus = 'pending' | 'starting' | 'running' | 'retrying' | 'completed' | 'failed' | 'cancelled' | 'timeout'

export interface CollabSubtask {
  id: string
  agentId: string
  instruction: string
  status: CollabSubtaskStatus
  error?: string
}

export interface CollabOrchestration {
  phase: CollabOrchestrationPhase
  subtasks: CollabSubtask[]
  mergePrompt: string
  mergeResult?: string
}

export interface CollabTask {
  id: string
  sessionId: string
  title: string
  objective: string
  cwd: string
  mode: 'parallel' | 'coordinated' | 'orchestrated'
  status: CollabTaskStatus
  retryCount?: number
  roles: CollabRole[]
  agents: Record<string, CollabAgent>
  messages: CollabMessage[]
  events: CollabEvent[]
  artifacts: CollabArtifact[]
  summary?: CollabSummary
  /** orchestrated 模式的拆解/子任务/汇总状态 */
  orchestration?: CollabOrchestration
  createdAt: string
  updatedAt: string
  startedAt?: string
  finishedAt?: string
}

export interface CreateCollabTaskInput {
  title: string
  objective: string
  cwd: string
  mode: CollabTask['mode']
  sessionId: string
  roles: CollabRole[]
}

export interface CollabTaskListResponse {
  tasks: CollabTask[]
}
