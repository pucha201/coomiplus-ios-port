/** 群聊 Store：唯一状态源。 */
import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { groupApi } from './api'
import { userError } from '@/bridge/http'
import type {
  CreateRoomResult,
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

const SEEN_PREFIX = 'coomi_room_seen_'

function loadSeenMap(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem('coomi_group_seen') || '{}')
  } catch { return {} }
}

function saveSeenMap(m: Record<string, number>) {
  try { localStorage.setItem('coomi_group_seen', JSON.stringify(m)) } catch { /* ignore */ }
}

export const useGroupStore = defineStore('group', () => {
  // ── 状态 ──────────────────────────────────────────────────
  const projects = ref<ProjectSummary[]>([])
  const activeProject = ref<ProjectSummary | null>(null)
  const identities = ref<Identity[]>([])
  const summaries = ref<RoomSummary[]>([])
  const current = ref<Room | null>(null)
  const loading = ref(false)
  const sending = ref(false)
  const error = ref('')
  const homeTab = ref<'messages' | 'contacts' | 'me'>('messages')
  const query = ref('')
  const mutedMap = ref<Record<string, boolean>>({})
  const seenMap = ref<Record<string, number>>(loadSeenMap())
  const toasts = ref<Array<{ id: string; roomId: string; title: string; text: string }>>([])

  // ── 计算 ──────────────────────────────────────────────────
  const active = computed(() => current.value?.status === 'running')

  const filteredSummaries = computed(() => {
    const q = query.value.trim().toLowerCase()
    if (!q) return summaries.value
    return summaries.value.filter(r =>
      r.name.toLowerCase().includes(q) || r.topic.toLowerCase().includes(q),
    )
  })

  const contacts = computed(() => identities.value)

  // ── 未读 / Toast ──────────────────────────────────────────

  function unreadOf(roomId: string, messageCount: number): number {
    const seen = seenMap.value[roomId]
    if (seen === undefined) return 0
    return Math.max(0, messageCount - seen)
  }

  function markRoomSeen(roomId: string, count?: number) {
    seenMap.value[roomId] = count ?? summaries.value.find(r => r.id === roomId)?.messageCount ?? 0
    saveSeenMap(seenMap.value)
  }

  function pushToast(roomId: string, title: string, text: string) {
    const id = `t_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`
    toasts.value.push({ id, roomId, title, text })
    setTimeout(() => {
      toasts.value = toasts.value.filter(t => t.id !== id)
    }, 4000)
  }

  function openToast(t: { roomId: string }) {
    markRoomSeen(t.roomId)
    toasts.value = toasts.value.filter(x => x.roomId !== t.roomId)
  }

  function detectNewMessages(prev: Map<string, number>) {
    for (const s of summaries.value) {
      const before = prev.get(s.id)
      if (before === undefined) {
        if (seenMap.value[s.id] === undefined) markRoomSeen(s.id, s.messageCount)
        continue
      }
      if (seenMap.value[s.id] === undefined) {
        markRoomSeen(s.id, s.messageCount)
        continue
      }
      if (current.value?.id === s.id) {
        markRoomSeen(s.id, s.messageCount)
        continue
      }
      if (mutedMap.value[s.id]) continue
      if (s.messageCount > before) {
        pushToast(s.id, s.name, s.preview || '新消息')
      }
    }
  }

  // ── Room 应用 ─────────────────────────────────────────────

  function applyRoom(room: Room) {
    current.value = room
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

  // ── 项目 ──────────────────────────────────────────────────

  async function loadProjects() {
    try {
      const data = await groupApi.listProjects()
      projects.value = data.projects ?? []
      activeProject.value = projects.value.find(p => p.id === data.activeId) || projects.value[0] || null
      error.value = ''
    } catch (cause) {
      // 连不上也要有话说：以前传输失败被整条丢掉，页面既不报错也不显示内容。
      error.value = userError(cause)
    }
  }

  async function createProject(name: string, description = ''): Promise<ProjectSummary | null> {
    error.value = ''
    try {
      const p = await groupApi.createProject(name, description)
      projects.value.push(p)
      activeProject.value = p
      // 新项目：清空上一个项目的房间/身份缓存，避免旧群串显。
      summaries.value = []
      current.value = null
      identities.value = []
      return p
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  async function activateProject(pid: string) {
    try {
      const p = await groupApi.activateProject(pid)
      activeProject.value = p
      summaries.value = []
      current.value = null
      await loadRooms()
      await loadIdentities()
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function deleteProject(pid: string): Promise<boolean> {
    try {
      await groupApi.deleteProject(pid)
      projects.value = projects.value.filter(p => p.id !== pid)
      if (activeProject.value?.id === pid) {
        activeProject.value = projects.value[0] || null
        summaries.value = []
        identities.value = []
        current.value = null
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

  // ── 身份 ──────────────────────────────────────────────────

  async function loadIdentities(projectId?: string) {
    const pid = projectId || activeProject.value?.id
    if (!pid) return
    try {
      identities.value = await groupApi.listIdentities(pid)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function deleteIdentity(pid: string, iid: string): Promise<boolean> {
    try {
      await groupApi.deleteIdentity(pid, iid)
      identities.value = identities.value.filter(i => i.id !== iid)
      return true
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    }
  }

  async function identityMemory(iid: string): Promise<IdentityMemoryPage | null> {
    const pid = activeProject.value?.id
    if (!pid) return null
    try {
      return await groupApi.identityMemory(pid, iid)
    } catch {
      return null
    }
  }

  // ── 房间 ──────────────────────────────────────────────────

  async function loadRooms() {
    loading.value = true
    const prev = new Map(summaries.value.map(s => [s.id, s.messageCount]))
    try {
      const pid = activeProject.value?.id
      if (pid) {
        const list = await groupApi.listProjectRooms(pid)
        for (const r of list) {
          if (r.muted !== undefined) mutedMap.value[r.id] = r.muted
        }
        summaries.value = list
      }
      detectNewMessages(prev)
      error.value = ''
    } catch (cause) {
      // 连不上也要有话说：以前传输失败被整条丢掉，页面既不报错也不显示内容。
      error.value = userError(cause)
    } finally {
      loading.value = false
    }
  }

  async function loadRoom(id: string): Promise<Room | null> {
    try {
      const room = await groupApi.getRoom(id)
      applyRoom(room)
      markRoomSeen(id, room.messages.length)
      error.value = ''
      return room
    } catch (cause) {
      // 连不上也要有话说：以前传输失败被整条丢掉，页面既不报错也不显示内容。
      error.value = userError(cause)
      return null
    }
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
      const data = await groupApi.createRoom({
        name, topic, speakMode, members,
        ...(opts?.projectId ? { projectId: opts.projectId } : {}),
        ...(opts?.overwritePersona !== undefined ? { overwritePersona: opts.overwritePersona } : {}),
      })
      if (data?.room) applyRoom(data.room)
      return data
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  async function removeRoom(id: string) {
    await groupApi.deleteRoom(id)
    summaries.value = summaries.value.filter(r => r.id !== id)
    if (current.value?.id === id) current.value = null
  }

  async function send(content: string, to = 'all', paths: string[] = [], replyTo?: string) {
    if (!current.value) return
    sending.value = true
    try {
      const room = await groupApi.send(current.value.id, content, to, paths, replyTo)
      applyRoom(room)
      markRoomSeen(room.id, room.messages.length)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
    } finally {
      sending.value = false
    }
  }

  async function removeGroupMember(roomId: string, memberId: string): Promise<Room | null> {
    try {
      const room = await groupApi.removeGroupMember(roomId, memberId)
      applyRoom(room)
      return room
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  async function updateMembers(members: RoomMember[]): Promise<Room | null> {
    if (!current.value) return null
    try {
      const room = await groupApi.updateMembers(current.value.id, members)
      applyRoom(room)
      return room
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return null
    }
  }

  // ── 设置 ──────────────────────────────────────────────────

  async function setTopic(topic: string) {
    if (!current.value) return
    try { applyRoom(await groupApi.setTopic(current.value.id, topic)) } catch { /* ignore */ }
  }

  async function setSpeakMode(mode: SpeakMode) {
    if (!current.value) return
    try { applyRoom(await groupApi.setSpeakMode(current.value.id, mode)) } catch { /* ignore */ }
  }

  async function setHostAllow(allow: string[]) {
    if (!current.value) return
    try { applyRoom(await groupApi.setHostAllow(current.value.id, allow)) } catch { /* ignore */ }
  }

  async function setEffort(effort: RoomEffort) {
    if (!current.value) return
    try { applyRoom(await groupApi.setEffort(current.value.id, effort)) } catch { /* ignore */ }
  }

  async function setRoomMute(muted: boolean) {
    if (!current.value) return
    try { applyRoom(await groupApi.setRoomMute(current.value.id, muted)) } catch { /* ignore */ }
  }

  async function setWorkDir(path: string) {
    if (!current.value) return
    try { applyRoom(await groupApi.setWorkDir(current.value.id, path)) } catch { /* ignore */ }
  }

  async function mergePaths(paths: string[]) {
    if (!current.value) return
    try { applyRoom(await groupApi.mergePaths(current.value.id, paths)) } catch { /* ignore */ }
  }

  async function clearPaths() {
    if (!current.value) return
    try { applyRoom(await groupApi.clearPaths(current.value.id)) } catch { /* ignore */ }
  }

  async function rename(name: string) {
    if (!current.value) return
    try { applyRoom(await groupApi.patchRoom(current.value.id, { name })) } catch { /* ignore */ }
  }

  async function patchRoom(patch: { name?: string; topic?: string; idleChatEnabled?: boolean }) {
    if (!current.value) return
    try { applyRoom(await groupApi.patchRoom(current.value.id, patch)) } catch { /* ignore */ }
  }

  async function clearHistory() {
    if (!current.value) return
    try { applyRoom(await groupApi.clearHistory(current.value.id)) } catch { /* ignore */ }
  }

  async function resetQuotas() {
    if (!current.value) return
    try { applyRoom(await groupApi.resetQuotas(current.value.id)) } catch { /* ignore */ }
  }

  async function cancelRound() {
    if (!current.value) return
    try { applyRoom(await groupApi.cancelRound(current.value.id)) } catch { /* ignore */ }
  }

  async function memberActivities(memberId: string): Promise<MemberActivityPayload | null> {
    if (!current.value) return null
    try {
      return await groupApi.memberActivities(current.value.id, memberId)
    } catch {
      return null
    }
  }

  async function getDm(iid: string) {
    const pid = activeProject.value?.id
    if (!pid) return null
    try {
      return await groupApi.getDm(pid, iid)
    } catch {
      return null
    }
  }

  async function sendDm(iid: string, content: string, attachments: string[] = []) {
    const pid = activeProject.value?.id
    if (!pid) return null
    try {
      return await groupApi.sendDm(pid, iid, content, attachments)
    } catch {
      return null
    }
  }

  // ── 导出 ──────────────────────────────────────────────────

  return {
    // 状态
    projects, activeProject, identities, summaries, current,
    loading, sending, error, homeTab, query, mutedMap, seenMap, toasts,
    // 计算
    active, filteredSummaries, contacts,
    // 项目
    loadProjects, createProject, activateProject, deleteProject,
    // 身份
    loadIdentities, deleteIdentity, identityMemory,
    // 房间
    loadRooms, loadRoom, createRoom, removeRoom, send,
    removeGroupMember, updateMembers,
    // 设置
    setTopic, setSpeakMode, setHostAllow, setEffort, setRoomMute,
    setWorkDir, mergePaths, clearPaths, rename, patchRoom, clearHistory,
    resetQuotas, cancelRound, memberActivities,
    // 单聊
    getDm, sendDm,
    // 未读 / Toast
    unreadOf, markRoomSeen, pushToast, openToast,
  }
})
