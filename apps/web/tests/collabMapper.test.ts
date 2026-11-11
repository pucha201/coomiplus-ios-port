import assert from 'node:assert/strict'
import test from 'node:test'
import { mapCollabTask } from '../src/features/collab/utils/collabMapper.ts'

test('maps persisted Rust collab tasks into the frontend domain model', () => {
  const task = mapCollabTask({
    id: 'task-1', sessionId: 'session-1', task: '重写协同工作台', title: '协同重写', cwd: '/workspace',
    status: 'running', createdAtMs: 1_700_000_000_000, updatedAtMs: 1_700_000_001_000,
    settings: { mode: 'coordinated', roles: [{ id: 'dev', name: '开发者', modelSelector: 'p:m', prompt: '实现', color: '#123456', icon: 'terminal', visibility: 'full', roleType: 'developer' }] },
    agents: [{ id: 'dev', name: '开发者', status: 'running', output: '处理中', startedAtMs: 1_700_000_000_000 }],
    messages: [{ id: 'm1', from: 'owner', to: 'dev', content: '开始', ts: 1_700_000_000 }],
    events: [{ event_type: 'collab_agent_status', event_seq: 7, agent_id: 'dev', status: 'running', current_message: '编码中', ts: 1_700_000_001 }],
    artifacts: [],
  })
  assert.equal(task.objective, '重写协同工作台')
  assert.equal(task.mode, 'coordinated')
  assert.equal(task.roles[0].roleType, 'developer')
  assert.equal(task.agents.dev.output, '处理中')
  assert.equal(task.messages[0].kind, 'instruction')
  assert.equal(task.events[0].type, 'agent_status')
})

test('normalizes legacy status and file events', () => {
  const task = mapCollabTask({
    id: 'task-2', task: '检查文件', status: 'completed', createdAtMs: 1, updatedAtMs: 2,
    settings: { roles: [{ id: 'reviewer', name: '审查员', model_selector: 'p:m', prompt: '检查', visibility: 'summary' }] },
    agents: [{ id: 'reviewer', status: 'done', output: '完成', startedAtMs: 1, finishedAtMs: 2 }],
    events: [{ event_type: 'collab_file_write', agent_id: 'reviewer', file_path: 'src/a.ts', mode: 'edit', ts: 2 }],
  })
  assert.equal(task.agents.reviewer.status, 'completed')
  assert.equal(task.events[0].type, 'artifact')
  if (task.events[0].type === 'artifact') assert.equal(task.events[0].artifact.path, 'src/a.ts')
  assert.ok(task.finishedAt)
})

test('maps orchestrated orchestration pipeline and role path rules', () => {
  const task = mapCollabTask({
    id: 'task-3', task: '集中调度', status: 'running', createdAtMs: 1, updatedAtMs: 2,
    settings: {
      mode: 'orchestrated',
      roles: [{
        id: 'dev', name: '开发', modelSelector: 'p:m', prompt: '实现', color: '#3b82f6', icon: 'terminal',
        visibility: 'full', roleType: 'developer', allowedPaths: ['src'], forbiddenPaths: ['secrets'],
      }],
    },
    agents: [],
    orchestration: {
      phase: 'executing',
      subtasks: [{ id: 'st_0', agentId: 'dev', instruction: '写入口', status: 'retrying', error: '超时后自动重试' }],
      mergePrompt: '汇总',
      mergeResult: '**done**',
    },
  })
  assert.equal(task.mode, 'orchestrated')
  assert.equal(task.roles[0].allowedPaths?.[0], 'src')
  assert.equal(task.orchestration?.phase, 'executing')
  assert.equal(task.orchestration?.subtasks[0].status, 'retrying')
  assert.equal(task.orchestration?.mergeResult, '**done**')
  assert.equal(task.status, 'running')
})

test('keeps draft status for pending start tasks', () => {
  const task = mapCollabTask({
    id: 'task-4', task: '草稿任务', status: 'draft', createdAtMs: 1, updatedAtMs: 2,
    settings: { mode: 'parallel', roles: [] },
    agents: [],
  })
  assert.equal(task.status, 'draft')
})
