import type { CollabAgent, CollabArtifact, CollabEvent, CollabMessage, CollabOrchestration, CollabOrchestrationPhase, CollabRole, CollabSubtask, CollabSubtaskStatus, CollabSummary, CollabTask, CollabTaskStatus } from '../types/collab'

type Json = Record<string, any>

function iso(value: unknown): string {
  if (typeof value === 'string' && value) return value
  if (typeof value === 'number') return new Date(value < 10_000_000_000 ? value * 1000 : value).toISOString()
  return new Date().toISOString()
}

function taskStatus(value: unknown): CollabTaskStatus {
  return ['draft','queued','starting','running','waiting','completed','partial','failed','cancelled','interrupted'].includes(String(value))
    ? String(value) as CollabTaskStatus : 'failed'
}

function role(raw: Json): CollabRole {
  const allowed = raw.allowedPaths ?? raw.allowed_paths
  const forbidden = raw.forbiddenPaths ?? raw.forbidden_paths
  return {
    id: String(raw.id || ''), name: String(raw.name || '未命名角色'),
    modelSelector: String(raw.modelSelector ?? raw.model_selector ?? ''), prompt: String(raw.prompt || ''),
    color: String(raw.color || '#2d61c6'), icon: String(raw.icon || 'agent'),
    visibility: raw.visibility === 'summary' ? 'summary' : 'full',
    roleType: raw.roleType ?? raw.role_type,
    allowedPaths: Array.isArray(allowed) ? allowed.map(String) : undefined,
    forbiddenPaths: Array.isArray(forbidden) ? forbidden.map(String) : undefined,
  }
}

function message(raw: Json): CollabMessage {
  return { id: String(raw.id || crypto.randomUUID()), from: String(raw.from || 'system'), to: String(raw.to || 'all'), content: String(raw.content || ''), createdAt: iso(raw.createdAt ?? raw.ts), kind: raw.kind === 'system' || raw.from === 'system' ? 'system' : raw.kind === 'instruction' || raw.from === 'owner' || raw.from === 'user' ? 'instruction' : 'result' }
}

function artifact(raw: Json): CollabArtifact {
  return { id: String(raw.id || crypto.randomUUID()), agentId: raw.agentId ?? raw.agent_id, path: String(raw.path ?? raw.name ?? ''), action: ['read','write','edit','patch','download'].includes(raw.action ?? raw.kind) ? raw.action ?? raw.kind : 'write', createdAt: iso(raw.createdAt ?? raw.createdAtMs), modifiedAt: iso(raw.modifiedAt ?? raw.modifiedAtMs ?? raw.createdAt ?? raw.createdAtMs) }
}

function subtask(raw: Json): CollabSubtask {
  const status = String(raw.status || 'pending')
  return {
    id: String(raw.id || `st_${raw.agentId ?? raw.agent_id ?? ''}`),
    agentId: String(raw.agentId ?? raw.agent_id ?? ''),
    instruction: String(raw.instruction || ''),
    status: (['pending','starting','running','retrying','completed','failed','cancelled','timeout'].includes(status) ? status : 'pending') as CollabSubtaskStatus,
    error: raw.error ? String(raw.error) : undefined,
  }
}

function orchestration(raw: Json | null | undefined): CollabOrchestration | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const phase = String(raw.phase || 'planning')
  const mergeRaw = raw.mergeResult ?? raw.merge_result
  return {
    phase: (['planning','executing','merging','done'].includes(phase) ? phase : 'planning') as CollabOrchestrationPhase,
    subtasks: Array.isArray(raw.subtasks) ? raw.subtasks.map(subtask) : [],
    mergePrompt: String(raw.mergePrompt ?? raw.merge_prompt ?? ''),
    mergeResult: mergeRaw != null && mergeRaw !== '' ? String(mergeRaw) : undefined,
  }
}

function event(raw: Json, index: number): CollabEvent | null {
  const createdAt = iso(raw.createdAt ?? raw.ts)
  const common = { id: String(raw.id || `${raw.event_seq || 'event'}_${index}`), seq: raw.event_seq, createdAt }
  switch (raw.type ?? raw.event_type) {
    case 'collab_agent_status': case 'agent_status': return { ...common, type: 'agent_status', agentId: String(raw.agentId ?? raw.agent_id), status: raw.status === 'done' ? 'completed' : raw.status === 'error' ? 'failed' : raw.status, message: String(raw.message ?? raw.current_message ?? '') }
    case 'collab_agent_chunk': case 'agent_output': return { ...common, type: 'agent_output', agentId: String(raw.agentId ?? raw.agent_id), content: String(raw.content || '') }
    case 'collab_agent_reasoning': case 'agent_reasoning': return { ...common, type: 'agent_reasoning', agentId: String(raw.agentId ?? raw.agent_id), content: String(raw.content || '') }
    case 'collab_agent_message': case 'message': return { ...common, type: 'message', message: message(raw.message ?? raw) }
    case 'collab_file_read': case 'collab_file_write': case 'artifact': return { ...common, type: 'artifact', artifact: artifact(raw.artifact ?? { ...raw, path: raw.file_path, action: (raw.event_type === 'collab_file_read' ? 'read' : raw.mode) }) }
    case 'collab_task_assigned': case 'task_assigned': return { ...common, type: 'task_assigned', assignments: (raw.assignments ?? []).map((item: Json) => ({ agentId: String(item.agentId ?? item.agent_id), task: String(item.task || ''), priority: Number(item.priority || 0) })) }
    case 'collab_architecture_ready': case 'architecture_ready': return { ...common, type: 'architecture_ready', files: raw.files ?? [], summary: String(raw.summary || '') }
    case 'collab_finished': case 'task_finished': return { ...common, type: 'task_finished', summary: String(raw.summary || '') }
    default: return null
  }
}

export function mapCollabTask(raw: Json): CollabTask {
  const roles = (raw.roles ?? raw.settings?.roles ?? []).map(role)
  const rawAgents: Json[] = Array.isArray(raw.agents) ? raw.agents : Object.values(raw.agents ?? {})
  const agents: Record<string, CollabAgent> = Object.fromEntries(rawAgents.map(item => [String(item.id), {
    id: String(item.id), roleId: String(item.roleId ?? item.role_id ?? item.id),
    status: item.status === 'done' ? 'completed' : item.status === 'error' ? 'failed' : item.status || 'pending',
    currentMessage: String(item.currentMessage ?? item.current_message ?? item.error ?? ''), output: String(item.output || ''), reasoning: String(item.reasoning || ''),
    tools: (item.tools ?? []).map((t: Json) => ({ id: String(t.id || ''), name: String(t.name || ''), arguments: t.arguments, status: t.status === 'done' || t.status === 'error' ? t.status : 'running', output: t.output })),
    activities: (item.activities ?? []).map((a: Json) => ({ id: String(a.id || crypto.randomUUID()), kind: a.kind === 'tool' ? 'tool' : a.kind === 'text' ? 'text' : 'reasoning', tsMs: Number(a.tsMs ?? a.ts_ms ?? 0), content: String(a.content ?? ''), toolName: a.toolName ?? a.tool_name, toolStatus: a.toolStatus ?? a.tool_status, refId: a.refId ?? a.ref_id })),
    startedAt: item.startedAt ?? (item.startedAtMs ? iso(item.startedAtMs) : undefined), finishedAt: item.finishedAt ?? (item.finishedAtMs ? iso(item.finishedAtMs) : undefined), error: item.error,
  }]))
  for (const item of roles) {
    if (!agents[item.id]) {
      const byRole = Object.values(agents).find(a => a.roleId === item.id)
      if (byRole) agents[item.id] = byRole
      else agents[item.id] = { id: item.id, roleId: item.id, status: 'pending', currentMessage: '', output: '', reasoning: '', tools: [], activities: [] }
    }
  }
  const events = (raw.events ?? []).map(event).filter(Boolean) as CollabEvent[]
  const artifacts = (raw.artifacts ?? []).map(artifact)
  const completedAgents = Object.values(agents).filter(item => item.status === 'completed').length
  const failedAgents = Object.values(agents).filter(item => item.status === 'failed').length
  const summaryText = typeof raw.summary === 'string' ? raw.summary : raw.summary?.text
  const summary: CollabSummary | undefined = summaryText ? { text: summaryText, completedAgents, failedAgents } : undefined
  const objective = String(raw.objective ?? raw.task ?? '')
  return {
    id: String(raw.id), sessionId: String(raw.sessionId ?? raw.session_id ?? ''), title: String(raw.title || objective.slice(0, 42) || '协同任务'), objective,
    cwd: String(raw.cwd || ''), mode: raw.mode === 'orchestrated' || raw.settings?.mode === 'orchestrated' ? 'orchestrated' : (raw.mode ?? raw.settings?.mode) === 'coordinated' ? 'coordinated' : 'parallel', status: taskStatus(raw.status), retryCount: Number(raw.retryCount ?? raw.retry_count ?? 0),
    roles, agents, messages: (raw.messages ?? []).map(message), events, artifacts, summary,
    orchestration: orchestration(raw.orchestration),
    createdAt: iso(raw.createdAt ?? raw.createdAtMs), updatedAt: iso(raw.updatedAt ?? raw.updatedAtMs),
    startedAt: raw.startedAt ?? (raw.createdAtMs ? iso(raw.createdAtMs) : undefined), finishedAt: raw.finishedAt ?? (raw.status && ['completed','failed','cancelled','interrupted'].includes(raw.status) ? iso(raw.updatedAtMs) : undefined),
  }
}
