import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { groupChatApi } from '../api/groupChatApi'
import type {
  CreateRoomResult,
  DmMessage,
  HomeConversation,
  Identity,
  IdentityMemoryPage,
  MemberActivityPayload,
  ProjectSummary,
  Room,
  RoomEffort,
  RoomMember,
  RoomMessage,
  RoomSummary,
  SpeakMode,
} from '../types/groupChat'

// ── 未读角标：每房间已读消息数（localStorage 持久化） ──
const SEEN_KEY_PREFIX = 'coomi_room_seen_'

function loadSeenMap(): Record<string, number> {
  try {
    const out: Record<string, number> = {}
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i)
      if (k?.startsWith(SEEN_KEY_PREFIX)) {
        out[k.slice(SEEN_KEY_PREFIX.length)] = Number(localStorage.getItem(k)) || 0
      }
    }
    return out
  } catch { return {} }
}

/** 独立群聊 store：不依赖 collab / session 历史，会话不共享。 */
export const useGroupChatStore = defineStore('group-chat', () => {
  const summaries = ref<RoomSummary[]>([])
  const rooms = ref<Room[]>([])
  const current = ref<Room | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const error = ref('')
  const query = ref('')
  /** 首页 tab：消息 / 通讯录 / 我的 */
  const homeTab = ref<'messages' | 'contacts' | 'me'>('messages')

  // ── 项目化 ──
  const projects = ref<ProjectSummary[]>([])
  const activeProject = ref<ProjectSummary | null>(null)
  const hasLegacy = ref(false)
  const identities = ref<Identity[]>([])
  /** roomId → muted（从完整 Room 同步，供轮询弹层判断） */
  const mutedMap = ref<Record<string, boolean>>({})
  /** roomId → 已读消息数 */
  const seenMap = ref<Record<string, number>>(loadSeenMap())
  /** 右上角新消息 toast 队列 */
  const toasts = ref<Array<{ key: number; roomId: string; title: string; text: string }>>([])

  const active = computed(() => current.value?.status === 'running')

  const filteredSummaries = computed(() => {
    const q = query.value.trim().toLowerCase()
    if (!q) return summaries.value
    return summaries.value.filter(r =>
      r.name.toLowerCase().includes(q)
      || r.topic.toLowerCase().includes(q)
    )
  })

  /** 通讯录：来自项目 identities（不再从 rooms 推导）。 */
  const contacts = computed(() =>
    [...identities.value]
      .map(i => ({
        id: i.id,
        name: i.name,
        color: i.color,
        icon: i.icon,
        modelSelector: i.modelSelector,
        persona: i.persona,
        memoryCount: i.memoryCount,
        bond: i.bond,
        dmUnread: i.dmUnread,
        rooms: (i.roomIds || [])
          .map(rid => rooms.value.find(r => r.id === rid)?.name || summaries.value.find(s => s.id === rid)?.name)
          .filter(Boolean) as string[],
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')),
  )

  /** 房间未读数 = 消息总数 - 已读数。 */
  function unreadOf(roomId: string, messageCount: number): number {
    const seen = seenMap.value[roomId]
    if (seen === undefined) return 0
    return Math.max(0, messageCount - seen)
  }

  function markRoomSeen(roomId: string, count?: number) {
    const c = count ?? summaries.value.find(s => s.id === roomId)?.messageCount ?? 0
    seenMap.value[roomId] = c
    try { localStorage.setItem(SEEN_KEY_PREFIX + roomId, String(c)) } catch { /* 忽略 */ }
  }

  let toastSeq = 1
  function pushToast(roomId: string, title: string, text: string) {
    const key = toastSeq++
    toasts.value.push({ key, roomId, title, text })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.key !== key)
    }, 2500)
  }

  function openToast(t: { roomId: string }) {
    toasts.value = toasts.value.filter(x => x.roomId !== t.roomId)
    markRoomSeen(t.roomId)
  }

  const conversations = computed<HomeConversation[]>(() =>
    filteredSummaries.value.map(room => ({
      kind: 'room' as const,
      id: room.id,
      title: room.name,
      subtitle: room.topic || `${room.memberCount} 位成员`,
      preview: room.preview || '还没有消息',
      updatedAtMs: room.updatedAtMs,
      running: room.status === 'running',
      badge: unreadOf(room.id, room.messageCount),
      memberCount: room.memberCount,
      speakMode: room.speakMode,
      color: room.memberColors?.[0] || '#2d61c6',
    })),
  )

  /** 轮询摘要后：对比已读数，非当前房间且未免打扰则弹 toast。 */
  function detectNewMessages(prev: Map<string, number>) {
    for (const s of summaries.value) {
      const before = prev.get(s.id)
      if (before === undefined || s.messageCount <= before) {
        // 首次见到的房间：初始化已读水位，避免误报
        if (before === undefined && seenMap.value[s.id] === undefined) markRoomSeen(s.id, s.messageCount)
        continue
      }
      if (seenMap.value[s.id] === undefined) {
        markRoomSeen(s.id, s.messageCount)
        continue
      }
      // 用户正开着该房间
      if (current.value?.id === s.id) {
        markRoomSeen(s.id, s.messageCount)
        continue
      }
      if (mutedMap.value[s.id]) continue
      const preview = s.preview || '新消息'
      pushToast(s.id, s.name, preview)
      // 不推进已读水位：角标保留，直到用户点开房间
    }
  }

  function applyRoom(room: Room) {
    current.value = room
    const i = rooms.value.findIndex(r => r.id === room.id)
    if (i >= 0) rooms.value[i] = room
    else rooms.value.unshift(room)
    if (room.muted !== undefined) mutedMap.value[room.id] = room.muted
    const summary: RoomSummary = {
      id: room.id,
      name: room.name,
      topic: room.topic,
      status: room.status,
      speakMode: room.speakMode,
      memberCount: room.members.length,
      memberColors: room.members.map(m => m.color),
      preview: room.messages.length
        ? room.messages[room.messages.length - 1].content.slice(0, 80)
        : '',
      messageCount: room.messages.length,
      updatedAtMs: room.updatedAtMs,
      reasoningEffort: room.reasoningEffort || 'auto',
      muted: room.muted,
      projectId: room.projectId,
    }
    const si = summaries.value.findIndex(r => r.id === room.id)
    if (si >= 0) summaries.value[si] = summary
    else summaries.value.unshift(summary)
    summaries.value.sort((a, b) => b.updatedAtMs - a.updatedAtMs)
  }

  // ── 项目 ──
  async function loadProjects() {
    try {
      const data = await groupChatApi.listProjects()
      projects.value = data.projects ?? []
      // 旧版清理功能已下线，不再提示
      hasLegacy.value = false
      activeProject.value = projects.value.find(p => p.id === data.activeId) || projects.value[0] || null
      error.value = ''
    } catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause)
      if (!/failed to fetch|aborted|network/i.test(msg)) {
        error.value = msg
      }
    }
  }

  /** 确保有活跃项目。不再自动创建；无项目时返回 null，由 UI 引导用户创建。 */
  async function ensureProject(): Promise<ProjectSummary | null> {
    if (activeProject.value) return activeProject.value
    if (projects.value.length) {
      activeProject.value = projects.value[0]
      return activeProject.value
    }
    return null
  }

  async function createProject(name: string, description = ''): Promise<ProjectSummary | null> {
    error.value = ''
    try {
      const p = await groupChatApi.createProject(name, description)
      projects.value.push(p)
      activeProject.value = p
      return p
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  async function activateProject(pid: string) {
    try {
      const p = await groupChatApi.activateProject(pid)
      activeProject.value = p
      await loadRooms()
      await loadIdentities()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function deleteProject(pid: string): Promise<boolean> {
    try {
      await groupChatApi.deleteProject(pid)
      projects.value = projects.value.filter(p => p.id !== pid)
      if (activeProject.value?.id === pid) {
        activeProject.value = projects.value[0] || null
        summaries.value = []
        identities.value = []
        if (activeProject.value) {
          await loadRooms()
          await loadIdentities()
        }
      }
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    }
  }

  async function purgeLegacy(): Promise<{ ok: boolean; removedRooms: number } | null> {
    try {
      const r = await groupChatApi.purgeLegacy()
      hasLegacy.value = false
      return r
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  /** 删除整个身份：所有群移除 + 删记忆/单聊/解绑生命体。 */
  async function deleteIdentity(pid: string, iid: string): Promise<{ ok: boolean; removedFromRooms: number } | null> {
    error.value = ''
    try {
      const r = await groupChatApi.deleteIdentity(pid, iid)
      identities.value = identities.value.filter(i => i.id !== iid)
      return r
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  /** 从本群移除成员（身份与其他群不受影响）。 */
  async function removeGroupMember(roomId: string, memberId: string): Promise<Room | null> {
    error.value = ''
    try {
      const room = await groupChatApi.removeGroupMember(roomId, memberId)
      applyRoom(room)
      return room
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  /** 通讯录：项目内共享身份列表。 */
  async function loadIdentities(projectId?: string, q = '') {
    const pid = projectId || activeProject.value?.id
    if (!pid) {
      await ensureProject()
    }
    const usePid = projectId || activeProject.value?.id
    if (!usePid) return
    try {
      identities.value = await groupChatApi.listIdentities(usePid, q)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function loadRooms() {
    loading.value = true
    // 轮询/后台刷新不覆盖用户可见错误；成功后清掉网络抖动残留
    const prev = new Map(summaries.value.map(s => [s.id, s.messageCount]))
    try {
      const pid = activeProject.value?.id
      if (pid) {
        // 项目内房间：轻量摘要（无 messages 体）
        const list = await groupChatApi.listProjectRooms(pid)
        for (const r of list) {
          if (r.muted !== undefined) mutedMap.value[r.id] = r.muted
        }
        summaries.value = list.map((r: any) => ({
          id: r.id,
          name: r.name,
          topic: r.topic,
          status: r.status,
          speakMode: r.speakMode,
          memberCount: r.memberCount ?? r.members?.length ?? 0,
          memberColors: r.memberColors ?? (r.members || []).map((m: any) => m.color),
          preview: r.preview || '',
          messageCount: r.messageCount ?? r.messages?.length ?? 0,
          updatedAtMs: r.updatedAtMs,
          reasoningEffort: (r.reasoningEffort || 'auto') as RoomEffort,
          muted: r.muted,
          projectId: r.projectId,
        }))
      } else {
        summaries.value = await groupChatApi.listSummaries()
      }
      detectNewMessages(prev)
      error.value = ''
    }
    catch (cause) {
      // 导航中断 / 后台轮询网络失败：不刷屏 Failed to fetch
      const msg = cause instanceof Error ? cause.message : String(cause)
      if (!/failed to fetch|aborted|network/i.test(msg)) {
        error.value = msg
      }
    }
    finally { loading.value = false }
  }

  /** 通讯录：需要完整成员信息时拉一次 full 列表。 */
  async function loadRoomsFull() {
    try {
      rooms.value = await groupChatApi.listRoomsFull()
      for (const room of rooms.value) applyRoom(room)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function loadRoom(id: string, quiet = false) {
    if (!quiet) loading.value = true
    try {
      const room = await groupChatApi.getRoom(id)
      applyRoom(room)
      // 在房间内 = 已读
      markRoomSeen(id, room.messages.length)
      error.value = ''
      return room
    }
    catch (cause) {
      const msg = cause instanceof Error ? cause.message : String(cause)
      if (!quiet && !/failed to fetch|aborted|network/i.test(msg)) {
        error.value = msg
      }
      return null
    }
    finally { if (!quiet) loading.value = false }
  }

  async function createRoom(
    name: string,
    topic: string,
    speakMode: SpeakMode,
    members: RoomMember[],
    opts?: { projectId?: string; overwritePersona?: boolean },
  ): Promise<CreateRoomResult | null> {
    error.value = ''
    try {
      const data = await groupChatApi.createRoom({
        name,
        topic,
        speakMode,
        members,
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        ...(opts?.overwritePersona !== undefined ? { overwritePersona: opts.overwritePersona } : {}),
      })
      if (data?.room) applyRoom(data.room)
      return data
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  /** 群消息免打扰。 */
  async function setRoomMute(id: string, muted: boolean): Promise<Room | null> {
    try {
      const room = await groupChatApi.setRoomMute(id, muted)
      mutedMap.value[id] = muted
      // 同步本地缓存的 room / summary，不切换 current
      const i = rooms.value.findIndex(r => r.id === id)
      if (i >= 0) rooms.value[i] = { ...rooms.value[i], muted }
      const si = summaries.value.findIndex(r => r.id === id)
      if (si >= 0) summaries.value[si] = { ...summaries.value[si], muted }
      if (current.value?.id === id) current.value = { ...current.value, muted }
      return room
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  /** 身份共享记忆（最近条）。 */
  async function identityMemory(iid: string, q = ''): Promise<IdentityMemoryPage | null> {
    const pid = activeProject.value?.id
    if (!pid) return null
    try {
      return await groupChatApi.identityMemory(pid, iid, q)
    } catch {
      return null
    }
  }

  // ── 单聊 ──
  async function getDm(iid: string): Promise<{ identity: Identity; messages: DmMessage[] } | null> {
    const pid = (await ensureProject())?.id
    if (!pid) return null
    try {
      return await groupChatApi.getDm(pid, iid)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  async function sendDm(iid: string, content: string, attachments: string[] = []): Promise<{ ok: boolean; userMessage: DmMessage; reply: DmMessage } | null> {
    const pid = activeProject.value?.id
    if (!pid || !content.trim()) return null
    sending.value = true
    error.value = ''
    try {
      return await groupChatApi.sendDm(pid, iid, content.trim(), attachments)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    } finally { sending.value = false }
  }

  async function send(content: string, to = 'all', paths: string[] = [], replyTo?: string) {
    if (!current.value || !content.trim()) return false
    sending.value = true
    error.value = ''
    try {
      const room = await groupChatApi.send(current.value.id, content.trim(), to, paths, replyTo)
      applyRoom(room)
      markRoomSeen(room.id, room.messages.length)
      return true
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    }
    finally { sending.value = false }
  }

  async function setWorkDir(path: string) {
    if (!current.value) return
    applyRoom(await groupChatApi.setWorkDir(current.value.id, path))
  }

  async function memberActivities(memberId: string): Promise<MemberActivityPayload | null> {
    if (!current.value) return null
    try {
      return await groupChatApi.memberActivities(current.value.id, memberId)
    } catch {
      return null
    }
  }

  async function setTopic(topic: string) {
    if (!current.value) return
    applyRoom(await groupChatApi.setTopic(current.value.id, topic))
  }

  async function setSpeakMode(mode: SpeakMode) {
    if (!current.value) return
    applyRoom(await groupChatApi.setSpeakMode(current.value.id, mode))
  }

  async function setHostAllow(allow: string[]) {
    if (!current.value) return
    applyRoom(await groupChatApi.setHostAllow(current.value.id, allow))
  }

  async function setEffort(effort: RoomEffort) {
    if (!current.value) return
    applyRoom(await groupChatApi.setEffort(current.value.id, effort))
  }

  async function mergePaths(paths: string[]) {
    if (!current.value || !paths.length) return
    applyRoom(await groupChatApi.mergePaths(current.value.id, paths))
  }

  async function clearPaths() {
    if (!current.value) return
    applyRoom(await groupChatApi.clearPaths(current.value.id))
  }

  async function rename(name: string) {
    if (!current.value) return
    applyRoom(await groupChatApi.patchRoom(current.value.id, { name }))
  }

  async function updateMembers(members: RoomMember[]) {
    if (!current.value) return
    applyRoom(await groupChatApi.updateMembers(current.value.id, members))
  }

  async function clearHistory() {
    if (!current.value) return
    applyRoom(await groupChatApi.clearHistory(current.value.id))
  }

  async function resetQuotas() {
    if (!current.value) return
    applyRoom(await groupChatApi.resetQuotas(current.value.id))
  }

  async function cancelRound() {
    if (!current.value) return
    applyRoom(await groupChatApi.cancelRound(current.value.id))
  }

  async function removeRoom(id: string) {
    await groupChatApi.deleteRoom(id)
    rooms.value = rooms.value.filter(r => r.id !== id)
    summaries.value = summaries.value.filter(r => r.id !== id)
    if (current.value?.id === id) current.value = null
  }

  function lastMessages(room: Room, limit = 30): RoomMessage[] {
    return room.messages.slice(-limit)
  }

  return {
    rooms, summaries, current, loading, sending, error, query, homeTab, active,
    filteredSummaries, contacts, conversations,
    // 项目化
    projects, activeProject, hasLegacy, identities, mutedMap, seenMap, toasts,
    loadProjects, ensureProject, createProject, activateProject, deleteProject, purgeLegacy, loadIdentities,
    deleteIdentity, removeGroupMember,
    markRoomSeen, openToast, unreadOf,
    loadRooms, loadRoomsFull, loadRoom, createRoom, send,
    setTopic, setSpeakMode, setHostAllow, setEffort, mergePaths, clearPaths,
    setWorkDir, memberActivities, setRoomMute, identityMemory, getDm, sendDm,
    rename, updateMembers,
    clearHistory, resetQuotas, cancelRound, removeRoom, lastMessages,
  }
})
