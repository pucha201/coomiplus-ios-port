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
} from '../types/groupChat'

async function parseRes(res: Response): Promise<any> {
  const text = await res.text()
  let data: any = {}
  let isJson = true
  try { data = text ? JSON.parse(text) : {} } catch { data = {}; isJson = false }
  if (!res.ok) {
    // 兜底不能只丢「HTTP 404」：这句话会直接进群聊页的错误提示，用户看不懂也没法下一步。
    const detail = data?.error ?? data?.message ?? ''
    throw new Error(detail || `请求失败（HTTP ${res.status}）${text ? '' : '，电脑端响应为空，可能版本过旧，请重启应用'}`)
  }
  // 引擎掉线时同源桥会把前端 index.html 以 200 回给 /api/*：当成合法空响应会让群聊
  // 显示「暂无群聊」、甚至把发送显示成成功，掩盖真正的连接问题。
  if (!isJson) throw new Error(`电脑端返回了非 JSON 响应（HTTP ${res.status}），请检查连接`)
  return data
}

/** 独立群聊 API：与协同任务、主聊天会话完全隔离。 */
export const groupChatApi = {
  // ── 项目 ──
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
  /** 活跃项目；无项目时后端返回 { needsSetup: true, projects: [], activeId: null }，不自动创建。 */
  async ensureActiveProject(): Promise<ProjectSummary | { needsSetup: true; projects: never[]; activeId: null }> {
    return parseRes(await authedFetch('/api/projects/active'))
  },
  /** 删除旧版平铺群聊数据。 */
  async purgeLegacy(): Promise<{ ok: boolean; removedRooms: number }> {
    return parseRes(await authedFetch('/api/projects/legacy/purge', { method: 'POST' }))
  },
  async activateProject(pid: string): Promise<ProjectSummary> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/activate`, { method: 'POST' }))
  },
  async deleteProject(pid: string): Promise<{ ok: boolean }> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}`, { method: 'DELETE' }))
  },
  async listProjectRooms(pid: string): Promise<Room[]> {
    const data = await parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/rooms`))
    return (data.rooms ?? []) as Room[]
  },
  // ── 身份 / 通讯录 / 单聊 ──
  async listIdentities(pid: string, q = ''): Promise<Identity[]> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    const data = await parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities${qs}`))
    return (data.identities ?? []) as Identity[]
  },
  async getIdentity(pid: string, iid: string): Promise<Identity> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}`))
  },
  async updateIdentity(pid: string, iid: string, patch: Partial<Identity>): Promise<Identity> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  },
  async identityMemory(pid: string, iid: string, q = ''): Promise<IdentityMemoryPage> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}/memory${qs}`))
  },
  async getDm(pid: string, iid: string): Promise<{ identity: Identity; messages: DmMessage[] }> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/dms/${encodeURIComponent(iid)}`))
  },
  async deleteIdentity(pid: string, iid: string): Promise<{ ok: boolean; removedFromRooms: number }> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/identities/${encodeURIComponent(iid)}`, {
      method: 'DELETE',
    }))
  },
  async sendDm(pid: string, iid: string, content: string, attachments: string[] = []): Promise<{ ok: boolean; userMessage: DmMessage; reply: DmMessage }> {
    return parseRes(await authedFetch(`/api/projects/${encodeURIComponent(pid)}/dms/${encodeURIComponent(iid)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        ...(attachments.length ? { attachments } : {}),
      }),
    }))
  },
  // ── 列表摘要（无 messages）——首页/轮询用。 ──
  async listSummaries(): Promise<RoomSummary[]> {
    const data = await parseRes(await authedFetch('/api/group-chat/rooms'))
    if (Array.isArray(data.rooms) && data.rooms[0]?.messages) {
      return (data.rooms as Room[]).map(r => ({
        id: r.id,
        name: r.name,
        topic: r.topic,
        status: r.status,
        speakMode: r.speakMode,
        memberCount: r.members?.length || 0,
        memberColors: (r.members || []).map(m => m.color),
        preview: r.messages?.length
          ? `${r.messages[r.messages.length - 1].content.slice(0, 80)}`
          : '',
        messageCount: r.messages?.length || 0,
        updatedAtMs: r.updatedAtMs,
        reasoningEffort: (r.reasoningEffort || 'auto') as RoomEffort,
      }))
    }
    return (data.rooms ?? []) as RoomSummary[]
  },
  async listRoomsFull(): Promise<Room[]> {
    const data = await parseRes(await authedFetch('/api/group-chat/rooms-full'))
    return (data.rooms ?? []) as Room[]
  },
  async getRoom(id: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`))) as Room
  },
  async createRoom(input: {
    name: string
    topic: string
    speakMode: Room['speakMode']
    members: RoomMember[]
    projectId?: string
    /** 同名成员已存在时是否覆盖其人设（默认沿用记忆） */
    overwritePersona?: boolean
  }): Promise<CreateRoomResult> {
    return (await parseRes(await authedFetch('/api/group-chat/rooms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }))) as CreateRoomResult
  },
  async deleteRoom(id: string): Promise<void> {
    await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`, { method: 'DELETE' }))
  },
  async patchRoom(id: string, patch: { name?: string; topic?: string; idleChatEnabled?: boolean }): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }))) as Room
  },
  async send(
    id: string,
    content: string,
    to: string,
    paths: string[] = [],
    replyTo?: string,
  ): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        content,
        to,
        ...(paths.length ? { paths, attachments: paths } : {}),
        ...(replyTo ? { replyTo } : {}),
      }),
    }))) as Room
  },
  async setWorkDir(id: string, path: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/work-dir`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    }))) as Room
  },
  async memberActivities(id: string, memberId: string): Promise<MemberActivityPayload> {
    return (await parseRes(await authedFetch(
      `/api/group-chat/rooms/${encodeURIComponent(id)}/activities/${encodeURIComponent(memberId)}`,
    ))) as MemberActivityPayload
  },
  async setTopic(id: string, topic: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/topic`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    }))) as Room
  },
  async setSpeakMode(id: string, speakMode: Room['speakMode']): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/speak-mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ speakMode }),
    }))) as Room
  },
  async setHostAllow(id: string, allow: string[]): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/host-allow`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ allow }),
    }))) as Room
  },
  async setEffort(id: string, reasoningEffort: RoomEffort): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/effort`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reasoningEffort }),
    }))) as Room
  },
  async mergePaths(id: string, paths: string[]): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/paths`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ paths }),
    }))) as Room
  },
  /** 群消息免打扰开关。 */
  async setRoomMute(id: string, muted: boolean): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/mute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ muted }),
    }))) as Room
  },
  async clearPaths(id: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/paths`, {
      method: 'DELETE',
    }))) as Room
  },
  async updateMembers(id: string, members: RoomMember[]): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/members`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ members }),
    }))) as Room
  },
  /** 从本群移除成员（身份与其他群不受影响）。返回更新后的 Room。 */
  async removeGroupMember(roomId: string, memberId: string): Promise<Room> {
    return (await parseRes(await authedFetch(
      `/api/group-chat/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}`,
      { method: 'DELETE' },
    ))) as Room
  },
  async clearHistory(id: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/clear`, {
      method: 'POST',
    }))) as Room
  },
  async resetQuotas(id: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/reset-quota`, {
      method: 'POST',
    }))) as Room
  },
  async cancelRound(id: string): Promise<Room> {
    return (await parseRes(await authedFetch(`/api/group-chat/rooms/${encodeURIComponent(id)}/cancel`, {
      method: 'POST',
    }))) as Room
  },
  // ── 群聊数字生命体 ──
  async groupLifeRegistry(q = ''): Promise<{ lives: any[] }> {
    const qs = q ? `?q=${encodeURIComponent(q)}` : ''
    return parseRes(await authedFetch(`/api/life/group/registry${qs}`))
  },
  async createGroupLife(name: string, persona = '', speakingStyle = '', values = ''): Promise<any> {
    return parseRes(await authedFetch('/api/life/group/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, persona, speakingStyle, values }),
    }))
  },
  async bindGroupLife(lifeId: string, roomId: string, memberId: string, identityId?: string): Promise<any> {
    return parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}/bind`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ roomId, memberId, identityId: identityId || undefined }),
    }))
  },
  async unbindGroupLife(lifeId: string): Promise<any> {
    return parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}/unbind`, {
      method: 'POST',
    }))
  },
  async updateGroupLife(lifeId: string, patch: Record<string, unknown>): Promise<any> {
    return parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    }))
  },
  async deleteGroupLife(lifeId: string): Promise<void> {
    await parseRes(await authedFetch(`/api/life/group/${encodeURIComponent(lifeId)}`, { method: 'DELETE' }))
  },
}
