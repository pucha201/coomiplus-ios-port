import { apiGet, apiSend } from '@/bridge/http'
import type { CollabMessage, CollabRole, CollabTask, CreateCollabTaskInput } from '../types/collab'
import { mapCollabTask } from '../utils/collabMapper'

export const collabApi = {
  async list(): Promise<{ tasks: CollabTask[] }> {
    const data = await apiGet<{ tasks?: Record<string, unknown>[] }>('/api/collab/tasks')
    return { tasks: (data.tasks ?? []).map(mapCollabTask) }
  },
  async get(id: string): Promise<CollabTask> {
    return mapCollabTask(await apiGet(`/api/collab/tasks/${encodeURIComponent(id)}`))
  },
  /** 轻量状态：轮询用，无 events/output。 */
  async getLite(id: string): Promise<CollabTask> {
    return mapCollabTask(await apiGet(`/api/collab/tasks/${encodeURIComponent(id)}/lite`))
  },
  async create(input: CreateCollabTaskInput, autoStart = true): Promise<CollabTask> {
    const response = await apiSend<{ task_id?: string; taskId?: string }>('/api/collab/tasks', 'POST', {
      task: input.objective,
      session_id: input.sessionId,
      title: input.title,
      cwd: input.cwd,
      auto_start: autoStart,
      settings: { roles: input.roles, mode: input.mode },
    })
    const id = response.taskId ?? response.task_id
    if (!id) throw new Error('引擎没有返回协同任务 ID')
    return this.get(id)
  },
  async start(id: string): Promise<CollabTask> {
    await apiSend(`/api/collab/tasks/${encodeURIComponent(id)}/start`, 'POST')
    return this.get(id)
  },
  async events(id: string, sinceSeq = 0): Promise<{ events: Record<string, unknown>[]; nextSeq: number }> {
    const data = await apiGet<{ events?: Record<string, unknown>[]; next_seq?: number }>(
      `/api/collab/tasks/${encodeURIComponent(id)}/events?since_seq=${sinceSeq}`,
    )
    return { events: data.events ?? [], nextSeq: Number(data.next_seq ?? 0) }
  },
  async artifacts(id: string): Promise<Record<string, unknown>[]> {
    const data = await apiGet<{ artifacts?: Record<string, unknown>[] }>(`/api/collab/tasks/${encodeURIComponent(id)}/artifacts`)
    return data.artifacts ?? []
  },
  async cancel(id: string): Promise<CollabTask> {
    await apiSend(`/api/collab/tasks/${encodeURIComponent(id)}/cancel`, 'POST')
    return this.get(id)
  },
  /** 硬打断：中止当前工具/子进程，任务仍可重试。 */
  async interrupt(id: string): Promise<{ ok: boolean }> {
    return apiSend(`/api/collab/tasks/${encodeURIComponent(id)}/interrupt`, 'POST')
  },
  async retry(id: string): Promise<CollabTask> {
    const response = await apiSend<{ new_task_id?: string; taskId?: string }>(`/api/collab/tasks/${encodeURIComponent(id)}/retry`, 'POST')
    return this.get(response.taskId ?? response.new_task_id ?? id)
  },
  remove(id: string): Promise<{ ok: boolean }> {
    return apiSend(`/api/collab/tasks/${encodeURIComponent(id)}`, 'DELETE')
  },
  sendMessage(id: string, content: string, to = 'all'): Promise<CollabMessage> {
    return apiSend(`/api/collab/tasks/${encodeURIComponent(id)}/messages`, 'POST', { content, to })
  },
  saveRoles(roles: CollabRole[]): Promise<{ roles: CollabRole[] }> {
    return apiSend('/api/settings/collab', 'PUT', { roles })
  },
}
