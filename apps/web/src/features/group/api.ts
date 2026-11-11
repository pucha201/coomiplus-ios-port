/** 群聊 API：所有 HTTP 调用集中于此。 */
import { authedFetch } from '@/bridge/http'
import type {
  CreateRoomResult,
  DmMessage,
  Identity,
  IdentityMemoryPage,
  MemberActivityPayload,
  ProjectSummary,
  Room,
  RoomEffort,
  RoomMember,
  RoomSummary,
  SpeakMode,
} from './types'

async function parseRes(res: Response): Promise<any> {
  const text = await res.text()
  let data: any = {}
  let isJson = true
  try { data = text ? JSON.parse(text) : {} } catch { data = {}; isJson = false }
  if (!res.ok) {
    // 兜底文案会原样出现在群聊首页的错误条里，不能说「HTTP 404」这种只有开发能读懂的话。
    const detail = data?.error ?? data?.message ?? ''
    throw new Error(detail || `请求失败（HTTP ${res.status}）${text ? '' : '，电脑端响应为空，可能版本过旧，请重启应用'}`)
  }
  // 引擎掉线时同源桥会把前端 index.html 以 200 回给 /api/*：当成合法空响应会让首页
  // 显示「还没有群聊」、将发送显示为成功，掩盖真正的连接问题。
  if (!isJson) throw new Error(`电脑端返回了非 JSON 响应（HTTP ${res.status}），请检查连接`)
  return data
}

export const groupApi = {
  // ── 项目 ──────────────────────────────────────────────────

  async listProjects(): Promise<{ projects: ProjectSummary[]; activeId: string | null; hasLegacy: boolean }> {
    return parseRes(await authedFetch('/api/projects'))
  },

  async createProject(name: string, description = ''): Promise<ProjectSummary> {
    return parseRes(await authedFetch('/api/projects', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description }),
    }))
  },

  async deleteProject(pid: string): Promise<{ ok: boolean }> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}`, { method: 'DELETE' }))
  },

  async activateProject(pid: string): Promise<ProjectSummary> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/activate`, { method: 'POST' }))
  },

  async ensureActiveProject(): Promise<ProjectSummary | { needsSetup: true }> {
    return parseRes(await authedFetch('/api/projects/active'))
  },

  // ── 群列表 / CRUD ─────────────────────────────────────────

  async listProjectRooms(pid: string): Promise<RoomSummary[]> {
    const data = await parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/rooms`))
    return (data.rooms ?? []) as RoomSummary[]
  },

  async getRoom(id: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`))
  },

  async createRoom(input: {
    name: string
    topic: string
    speakMode: SpeakMode
    members: RoomMember[]
    projectId?: string
    overwritePersona?: boolean
  }): Promise<CreateRoomResult> {
    return parseRes(await authedFetch('/api/group-chat/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }))
  },

  async deleteRoom(id: string): Promise<void> {
    await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },

  async patchRoom(id: string, patch: { name?: string; topic?: string; idleChatEnabled?: boolean }): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  },

  // ── 字段更新 ──────────────────────────────────────────────

  async setTopic(id: string, topic: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/topic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    }))
  },

  async setSpeakMode(id: string, speakMode: SpeakMode): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/speak-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakMode }),
    }))
  },

  async setHostAllow(id: string, allow: string[]): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/host-allow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow }),
    }))
  },

  async setEffort(id: string, reasoningEffort: RoomEffort): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/effort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort }),
    }))
  },

  async setRoomMute(id: string, muted: boolean): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted }),
    }))
  },

  async setWorkDir(id: string, path: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/work-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }))
  },

  async mergePaths(id: string, paths: string[]): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }))
  },

  async clearPaths(id: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/paths`, { method: 'DELETE' }))
  },

  // ── 成员 ──────────────────────────────────────────────────

  async updateMembers(id: string, members: RoomMember[]): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    }))
  },

  async removeGroupMember(roomId: string, memberId: string): Promise<Room> {
    return parseRes(await authedFetch(
      `/api/group-chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ))
  },

  // ── 历史 / 配额 / 轮次 ────────────────────────────────────

  async clearHistory(id: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/clear`, { method: 'POST' }))
  },

  async resetQuotas(id: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/reset-quota`, { method: 'POST' }))
  },

  async cancelRound(id: string): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/cancel`, { method: 'POST' }))
  },

  // ── 活动 ──────────────────────────────────────────────────

  async memberActivities(id: string, memberId: string): Promise<MemberActivityPayload> {
    return parseRes(await authedFetch(
      `/api/group-chat/rooms/${encodeURIComponent(id)}/activities/${encodeURIComponent(memberId)}`,
    ))
  },

  // ── 发消息 ────────────────────────────────────────────────

  async send(
    id: string,
    content: string,
    to = 'all',
    paths: string[] = [],
    replyTo?: string,
  ): Promise<Room> {
    return parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, to, paths, ...(replyTo ? { replyTo } : {}) }),
    }))
  },

  // ── 身份 / 通讯录 ─────────────────────────────────────────

  async listIdentities(pid: string, q = ''): Promise<Identity[]> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    const data = await parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities${qs}`))
    return (data.identities ?? []) as Identity[]
  },

  async deleteIdentity(pid: string, iid: string): Promise<{ ok: boolean; removedFromRooms: number }> {
    return parseRes(await authedFetch(
      `/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}`,
      { method: 'DELETE' },
    ))
  },

  async identityMemory(pid: string, iid: string, q = ''): Promise<IdentityMemoryPage> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return parseRes(await authedFetch(
      `/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}/memory${qs}`,
    ))
  },

  // ── 单聊 ──────────────────────────────────────────────────

  async getDm(pid: string, iid: string): Promise<{ identity: Identity; messages: DmMessage[] }> {
    return parseRes(await authedFetch(
      `/api/projects/${encodeURIComponent(pid)}/dms/${encodeURIComponent(iid)}`,
    ))
  },

  async sendDm(pid: string, iid: string, content: string, attachments: string[] = []): Promise<{
    ok: boolean
    userMessage: DmMessage
    reply: DmMessage
  }> {
    return parseRes(await authedFetch(
      `/api/projects/${encodeURIComponent(pid)}/dms/${encodeURIComponent(iid)}/messages`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, ...(attachments.length ? { attachments } : {}) }),
      },
    ))
  },

  // ── 生命体 ────────────────────────────────────────────────

  async groupLifeRegistry(q = ''): Promise<{ lives: any[] }> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return parseRes(await authedFetch(`/api/life/group/registry${qs}`))
  },

  async bindGroupLife(lifeId: string, roomId: string, memberId: string, identityId?: string): Promise<any> {
    return parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, memberId, identityId: identityId || undefined }),
    }))
  },

  async unbindGroupLife(lifeId: string): Promise<any> {
    return parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}/unbind`, { method: 'POST' }))
  },
}
