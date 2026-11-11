<script setup lang="ts">
/**
 * 群聊房间 — 与协同/主会话完全隔离。
 * 气泡：时间在气泡外；头像可点开活动；支持引用、附件预览、工作目录跳文件管理。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import FileInline from '@/components/FileInline.vue'
import { useGroupChatStore } from '@/features/collab-chat/stores/groupChatStore'
import { groupChatApi } from '@/features/collab-chat/api/groupChatApi'
import { REASONING_EFFORTS, useConfigStore } from '@/stores/config'
import type { MemberActivityPayload, RoomEffort, RoomMember, RoomMessage, SpeakMode } from '@/features/collab-chat/types/groupChat'
import { renderMarkdown } from '@/utils/markdown'
import { speakLocal, stopSpeakLocal, ttsAvailable } from '@/utils/tts'

const route = useRoute()
const router = useRouter()
const store = useGroupChatStore()
const config = useConfigStore()

const roomId = computed(() => String(route.params.roomId || ''))
const draft = ref('')
const target = ref('all')
const feedEl = ref<HTMLElement | null>(null)

/**
 * 跟随到底部。
 *
 * 修复：这里原本引用的是一个从未绑定到模板的 scroller ref（永远为 null），
 * 于是「进入房间滚到底 / 新消息滚到底」两处都是空操作 —— 打开长会话时停在顶部。
 * 现在用真正绑定在 .feed 上的元素；并且只在用户本来就在底部时跟随，
 * 否则会把正在翻历史记录的人突然拽走。
 */
function stickToBottom(force = false): void {
  const el = feedEl.value
  if (!el) return
  const distance = el.scrollHeight - el.scrollTop - el.clientHeight
  if (!force && distance > 120) return
  el.scrollTop = el.scrollHeight
}
const panelOpen = ref(false)
const membersOpen = ref(false)
const memberDetail = ref<MemberActivityPayload | null>(null)
const memberDetailOpen = ref(false)
/** 成员抽屉里的共享记忆 */
const memberMemory = ref<{ items: unknown[]; total: number } | null>(null)
const topicEdit = ref(false)
const topicDraft = ref('')
const renameOpen = ref(false)
const nameDraft = ref('')
const editingMembers = ref(false)
const memberForm = ref<RoomMember[]>([])
const hostPick = ref<string[]>([])
const permAsk = ref(false)
const draftPaths = ref<Array<{ id: string; path: string; isDir: boolean }>>([])
const reply = ref<RoomMessage | null>(null)
const speakingId = ref('')

function speakMessage(m: RoomMessage) {
  if (speakingId.value === m.id) {
    stopSpeakLocal()
    speakingId.value = ''
    return
  }
  speakLocal(m.content)
  speakingId.value = m.id
}

const room = computed(() =>
  store.current?.id === roomId.value ? store.current : store.rooms.find(r => r.id === roomId.value) || null,
)
const running = computed(() => room.value?.status === 'running')
const done = computed(() => room.value?.status === 'done')

const models = computed(() =>
  config.providers.flatMap(p =>
    (p.models.length ? p.models : [p.model]).filter(Boolean)
      .map(m => ({ value: `${p.id}:${m}`, label: `${p.name} · ${m}` })),
))

const targetOptions = computed(() => [
  { value: 'all', label: '@全体' },
  ...(room.value?.members || []).map(m => ({ value: m.id, label: `@${m.name}` })),
])
const iconOptions = [
  { value: 'chat', label: '聊天' },
  { value: 'terminal', label: '终端' },
  { value: 'shield', label: '审查' },
  { value: 'people', label: '协作' },
  { value: 'sparkle', label: '创意' },
  { value: 'target', label: '目标' },
]
const modelOptions = computed(() => [
  { value: '', label: '默认' },
  ...models.value,
])

function memberOf(id: string) {
  return room.value?.members.find(m => m.id === id) || null
}
function memberName(id: string) {
  if (id === 'user' || id === 'owner') return '我'
  return memberOf(id)?.name || id
}
function memberColor(id: string) {
  if (isMe(id)) return '#2d61c6'
  return memberOf(id)?.color || '#888'
}
function memberIcon(id: string) {
  if (isMe(id)) return 'user'
  return memberOf(id)?.icon || 'chat'
}
function isMe(from: string) {
  return from === 'user' || from === 'owner'
}
function md(src: string) {
  return renderMarkdown(src || '')
}
/** 共享记忆条目 → 短文本展示。 */
function memoryText(item: unknown): string {
  if (item == null) return ''
  if (typeof item === 'string') return item.slice(0, 120)
  if (typeof item === 'object') {
    const o = item as Record<string, unknown>
    const t = o.text ?? o.content ?? o.summary ?? o.title ?? o.detail
    if (typeof t === 'string') return t.slice(0, 120)
    try { return JSON.stringify(item).slice(0, 120) } catch { return String(item) }
  }
  return String(item)
}
function fmtClock(ts: number) {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
function modeLabel(m: SpeakMode) {
  if (m === 'open') return '抢麦'
  if (m === 'host') return '主持'
  return '轮流'
}
function quotaText(member: RoomMember) {
  const used = room.value?.speakCounts[member.id] || 0
  if (!member.quota) return `${used} / ∞`
  return `${used} / ${member.quota}`
}
/** 可选生命体列表（编辑成员时绑定用） */
const availableLives = ref<Array<{ id: string; name: string; boundMemberId?: string; boundRoomId?: string }>>([])
const lifeQuery = ref('')
async function loadLives(q = '') {
  try {
    const data = await groupChatApi.groupLifeRegistry(q)
    availableLives.value = (data.lives || []).map((l: any) => ({
      id: l.id, name: l.name, boundMemberId: l.boundMemberId, boundRoomId: l.boundRoomId,
    }))
  } catch { availableLives.value = [] }
}
let lifeSearchTimer: ReturnType<typeof setTimeout> | null = null
function onLifeSearch() {
  if (lifeSearchTimer) clearTimeout(lifeSearchTimer)
  lifeSearchTimer = setTimeout(() => { void loadLives(lifeQuery.value.trim()) }, 250)
}
/** 生命体下拉项：被其他成员绑定时标注「已绑定」。 */
function lifeLabel(l: { id: string; name: string; boundMemberId?: string; boundRoomId?: string }, selfId: string): string {
  if (l.boundMemberId && l.boundMemberId !== selfId) return `${l.name}（已绑定）`
  return l.name
}
function pathName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}
function replyMsg(m: RoomMessage) {
  if (!m.replyTo) return null
  return room.value?.messages.find(x => x.id === m.replyTo) || null
}

async function send() {
  const text = draft.value.trim()
  if (!text || !room.value) return
  const paths = draftPaths.value.map(p => p.path)
  const rid = reply.value?.id
  // 解析文本里的 @成员名：若 target 是 all 且文本中有 @，自动定向到该成员
  let to = target.value
  if (to === 'all' && !rid) {
    const mention = parseMention(text)
    if (mention) to = mention
  }
  if (await store.send(text, to, paths, rid)) {
    draft.value = ''
    draftPaths.value = []
    reply.value = null
  }
}

/** 从消息文本解析 @成员名 → 成员 id（找不到返回 null）。 */
function parseMention(text: string): string | null {
  const m = text.match(/@(\S+)/)
  if (!m) return null
  const name = m[1].replace(/[，。！？、,.!?]+$/, '')
  return room.value?.members.find(x => x.name === name)?.id || null
}
function startReply(m: RoomMessage) {
  reply.value = m
  // 引用成员消息时，定向只回该成员，避免全员抢麦
  if (!isMe(m.from) && m.from !== 'system') {
    target.value = m.from
  }
}
function cancelReply() {
  reply.value = null
}
async function refresh(silent = true) {
  if (!roomId.value) return null
  return store.loadRoom(roomId.value, silent)
}
function togglePanel() { panelOpen.value = !panelOpen.value }
function closePanel() { panelOpen.value = false }
function toggleMembers() {
  membersOpen.value = !membersOpen.value
  if (!membersOpen.value) editingMembers.value = false
}
async function openMemberDetail(id: string) {
  const data = await store.memberActivities(id)
  if (data) {
    memberDetail.value = data
    memberDetailOpen.value = true
    // 共享记忆（项目身份）
    memberMemory.value = null
    const iid = data.member?.identityId
    if (iid) {
      const mem = await store.identityMemory(iid)
      memberMemory.value = mem
    }
  }
}
function closeMemberDetail() {
  memberDetailOpen.value = false
  memberDetail.value = null
}

/** 为当前查看的成员绑定数字生命体（选择已有）。 */
async function bindMemberLife() {
  const mid = memberDetail.value?.member?.id
  const name = memberDetail.value?.member?.name
  const rid = room.value?.id
  if (!mid || !rid) return
  try {
    const data = await groupChatApi.groupLifeRegistry()
    const lives = (data.lives || []) as Array<{ id: string; name: string }>
    if (lives.length === 0) {
      alert('还没有生命体，请先在控制台「群聊生命体」页创建。')
      return
    }
    // 用 confirm 逐个列出让用户选（WebView 兼容）；已绑定到他人的跳过提示
    let selected = -1
    for (let i = 0; i < lives.length; i++) {
      const L = lives[i] as { id: string; name: string; boundMemberId?: string }
      if (L.boundMemberId && L.boundMemberId !== mid) {
        if (confirm(`「${L.name}」已绑定其他成员，换绑到当前成员？\n（取消 = 看下一个）`)) {
          selected = i
          break
        }
        continue
      }
      if (confirm(`选择生命体：「${L.name}」？\n（取消 = 看下一个）`)) {
        selected = i
        break
      }
    }
    if (selected < 0) return
    const iid = memberDetail.value?.member?.identityId
    await groupChatApi.bindGroupLife(lives[selected].id, rid, mid, iid)
    alert(`已绑定「${lives[selected].name}」到 ${name}`)
    closeMemberDetail()
    await refresh(true)
  } catch (e) {
    alert('失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

/** 打开群工作目录 / 首个授权目录到文件管理器 */
function openWorkDir() {
  const dir = room.value?.workDir
    || room.value?.contextPaths.find(p => p.endsWith('/') || !p.includes('.'))?.replace(/\/$/, '')
    || ''
  const q = dir ? `?path=${encodeURIComponent(dir)}` : ''
  router.push(`/files${q}`)
}

/** 从本群移除当前查看的成员（身份与其他群不受影响）。 */
async function removeFromRoom() {
  const mid = memberDetail.value?.member?.id
  const name = memberDetail.value?.member?.name
  const rid = room.value?.id
  if (!mid || !rid || mid === 'user' || mid === 'owner') return
  if (!confirm(`从本群移除「${name || mid}」？其他群与共享记忆不受影响。`)) return
  const updated = await store.removeGroupMember(rid, mid)
  if (updated) {
    closeMemberDetail()
    membersOpen.value = false
  } else {
    alert(store.error || '移除失败，请重试')
  }
}
function openFileInManager(path: string) {
  const parts = path.split(/[\\/]/).filter(Boolean)
  parts.pop()
  const dir = '/' + parts.join('/')
  router.push(`/files?path=${encodeURIComponent(dir || '/')}`)
}

async function changeMode(mode: SpeakMode) {
  await store.setSpeakMode(mode)
}
async function changeEffort(effort: RoomEffort) {
  await store.setEffort(effort)
}
async function toggleIdleChat(enabled: boolean) {
  if (!room.value) return
  await groupChatApi.patchRoom(room.value.id, { idleChatEnabled: enabled })
  await refresh(true)
}
async function toggleMute(muted: boolean) {
  if (!room.value) return
  await store.setRoomMute(room.value.id, muted)
}
function openTopic() {
  topicDraft.value = room.value?.topic || ''
  topicEdit.value = true
}
async function saveTopic() {
  await store.setTopic(topicDraft.value)
  topicEdit.value = false
}
function openRename() {
  nameDraft.value = room.value?.name || ''
  renameOpen.value = true
}
async function saveRename() {
  if (!nameDraft.value.trim()) return
  await store.rename(nameDraft.value.trim())
  renameOpen.value = false
}
function startEditMembers() {
  memberForm.value = (room.value?.members || []).map(m => ({
    ...m, persona: m.persona || '', speakingStyle: m.speakingStyle || '', values: m.values || '', emotionBias: m.emotionBias ?? 0,
  }))
  hostPick.value = [...(room.value?.hostAllow || [])]
  editingMembers.value = true
  void loadLives()
}
function addMember() {
  const palette = ['#2d61c6', '#d47458', '#1f9d6b', '#8b5cf6', '#db2777']
  const icons = ['terminal', 'shield', 'chat', 'people', 'sparkle', 'target']
  const i = memberForm.value.length
  memberForm.value.push({
    id: `m${Date.now()}_${i}`, name: `成员${i + 1}`, modelSelector: models.value[0]?.value || '', prompt: '参与讨论，给出有帮助的回复。', color: palette[i % palette.length], icon: icons[i % icons.length], quota: 8, persona: '', speakingStyle: '', values: '', emotionBias: 0,
  })
}
function removeMember(i: number) {
  if (memberForm.value.length <= 1) return
  memberForm.value.splice(i, 1)
}
async function saveMembers() {
  await store.updateMembers(memberForm.value)
  editingMembers.value = false
}
function toggleHost(id: string) {
  const i = hostPick.value.indexOf(id)
  if (i >= 0) hostPick.value.splice(i, 1)
  else hostPick.value.push(id)
}
async function saveHost() {
  await store.setHostAllow(hostPick.value)
}
async function resetQuota() {
  await store.resetQuotas()
}
async function clearChat() {
  await store.clearHistory()
}
async function cancelRound() {
  await store.cancelRound()
  await refresh(true)
}
async function resumeDone() {
  await resetQuota()
  closePanel()
}

function ensureStorage(): boolean {
  const bridge = (window as any).CoomiAndroid
  if (!bridge?.hasStoragePermission) return true
  const ok = !!bridge.hasStoragePermission()
  if (!ok) permAsk.value = true
  return ok
}
function openStorage() {
  (window as any).CoomiAndroid?.openStorageSettings?.()
  permAsk.value = false
}
function pickFiles() {
  if (!ensureStorage()) return
  window.CoomiAndroid?.importFiles?.()
}
function authorizeFolder() {
  if (!ensureStorage()) return
  window.CoomiAndroid?.authorizeFolder?.()
}
function addPath(path: string, isDir = false) {
  const p = path.trim()
  if (!p) return
  if (draftPaths.value.some(x => x.path === p)) return
  draftPaths.value.push({ id: `p_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, path: p, isDir: isDir || p.endsWith('/') })
  if (isDir || p.endsWith('/')) {
    void store.setWorkDir(p.replace(/\/$/, ''))
  }
}
function removeDraftPath(id: string) {
  draftPaths.value = draftPaths.value.filter(x => x.id !== id)
}
async function clearRoomPaths() {
  await store.clearPaths()
}
function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[] }>).detail ?? {}
  for (const p of detail.paths ?? []) addPath(p, p.endsWith('/') || !p.includes('.'))
}
function onFolderSelected(event: Event) {
  const detail = (event as CustomEvent<{ path?: string | null }>).detail ?? {}
  if (detail.path) addPath(detail.path, true)
}

let touchStartX = 0
let touchStartY = 0
let touching = false
const EDGE = 28
function onTouchStart(e: TouchEvent) {
  if (panelOpen.value) return
  const t = e.touches[0]
  if (!t) return
  const w = feedEl.value?.clientWidth || window.innerWidth
  const fromRight = t.clientX >= w - EDGE
  const fromBody = !fromRight && t.clientX > w * 0.55
  if (!fromRight && !fromBody) return
  touching = true
  touchStartX = t.clientX
  touchStartY = t.clientY
}
function onTouchEnd(e: TouchEvent) {
  if (!touching) return
  touching = false
  const t = e.changedTouches[0]
  if (!t) return
  const dx = t.clientX - touchStartX
  const dy = Math.abs(t.clientY - touchStartY)
  if (dx < -48 && dy < 64 && Math.abs(dx) > dy) panelOpen.value = true
}
function onKey(e: KeyboardEvent) {
  if (e.key !== 'Escape') return
  if (renameOpen.value) renameOpen.value = false
  else if (topicEdit.value) topicEdit.value = false
  else if (memberDetailOpen.value) closeMemberDetail()
  else if (membersOpen.value) membersOpen.value = false
  else if (panelOpen.value) panelOpen.value = false
}

/** 返回消息列表（首页）。 */
function goHome() {
  store.error = ''
  stopPoll()
  router.push('/home')
}

let timer: ReturnType<typeof setInterval> | undefined
function stopPoll() {
  if (timer) clearInterval(timer)
  timer = undefined
}
function startPoll() {
  stopPoll()
  timer = setInterval(() => { void refresh(true) }, running.value ? 2000 : 10000)
}

onMounted(async () => {
  window.addEventListener('keydown', onKey)
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:folder-selected', onFolderSelected)
  panelOpen.value = false
  membersOpen.value = false
  if (config.providers.length === 0) void config.fetchProviders()
  if (roomId.value) {
    const r = await refresh(false)
    startPoll()
    await nextTick()
    stickToBottom(true)
    if (!r) router.replace('/home')
  }
})
onUnmounted(() => {
  window.removeEventListener('keydown', onKey)
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:folder-selected', onFolderSelected)
  stopPoll()
})
watch(roomId, async id => {
  if (id) {
    await refresh(false)
    startPoll()
  }
})
watch(() => room.value?.messages.length, () => {
  nextTick(() => stickToBottom())
})
watch(running, () => startPoll())
</script>

<template>
  <main class="page">
    <header class="top">
      <button class="icon" aria-label="返回" @click="goHome">
        <CoomiIcon name="back" :size="20" />
      </button>
      <div class="title" @click="openRename">
        <h1>{{ room?.name || '群聊' }}</h1>
        <p>
          <span v-if="running" class="live">讨论中</span>
          <span v-else-if="done" class="done-tag">本轮结束</span>
          <span v-else>{{ modeLabel(room?.speakMode || 'round_robin') }}</span>
          · {{ room?.members.length || 0 }} 成员
          <template v-if="room?.topic"> · {{ room.topic.slice(0, 10) }}</template>
        </p>
      </div>
      <button v-if="running" class="stop" @click="cancelRound">停止</button>
      <button class="icon" aria-label="成员" @click="toggleMembers">
        <span class="stack-av">
          <i v-for="m in (room?.members || []).slice(0, 3)" :key="m.id" class="stack-item" :style="{ background: m.color }">
            <CoomiIcon :name="m.icon || 'chat'" :size="10" />
          </i>
        </span>
      </button>
      <button class="icon" :class="{ on: panelOpen }" :aria-expanded="panelOpen" aria-label="聊天信息" @click="togglePanel">
        <CoomiIcon name="menu" :size="18" />
      </button>
    </header>

    <section ref="feedEl" class="feed" @touchstart.passive="onTouchStart" @touchend.passive="onTouchEnd">
      <div v-if="!room?.messages.length" class="empty-sm">
        还没有消息。发送第一条；右滑可打开聊天信息。
      </div>
      <article
        v-for="m in room?.messages || []"
        :key="m.id"
        class="row-msg"
        :class="isMe(m.from) ? 'me' : m.from === 'system' ? 'sys' : 'them'"
      >
        <template v-if="m.from === 'system'">
          <div class="sys-bubble">{{ m.content }}</div>
        </template>
        <template v-else>
          <button class="avatar-btn" :aria-label="`查看 ${memberName(m.from)} 活动`" @click="openMemberDetail(m.from)">
            <span class="avatar" :style="{ background: memberColor(m.from) }">
              <CoomiIcon :name="memberIcon(m.from)" :size="14" />
            </span>
          </button>
          <div class="col">
            <div class="meta-line">
              <span class="who">{{ memberName(m.from) }}</span>
              <time class="time">{{ fmtClock(m.ts) }}</time>
            </div>
            <div class="bubble" @dblclick="startReply(m)">
              <div v-if="replyMsg(m)" class="quote-chip">
                <span>{{ memberName(replyMsg(m)!.from) }}: {{ replyMsg(m)!.content.slice(0, 40) }}</span>
              </div>
              <FileInline v-if="m.attachments?.length" :paths="m.attachments" class="attach-top" />
              <div class="md" v-html="md(m.content)" />
              <footer class="bfoot">
                <span v-if="m.to && m.to !== 'all' && m.to !== 'user'">@{{ memberName(m.to) }}</span>
                <button
                  v-if="!isMe(m.from) && ttsAvailable()"
                  class="mini"
                  :title="speakingId === m.id ? '停止朗读' : '朗读'"
                  @click.stop="speakMessage(m)"
                >
                  <CoomiIcon :name="speakingId === m.id ? 'stop' : 'chat'" :size="12" />{{ speakingId === m.id ? '停' : '读' }}
                </button>
                <button class="mini" title="引用" @click.stop="startReply(m)">
                  <CoomiIcon name="arrowLeft" :size="12" />引用
                </button>
              </footer>
            </div>
          </div>
        </template>
      </article>
      <div v-if="running" class="typing">
        <span class="sk typing-dot" />
        成员发言中…
      </div>
      <div v-if="done" class="done-bar">
        <span>所有成员已达配额上限</span>
        <button @click="resumeDone">重置配额继续聊</button>
      </div>
    </section>

    <footer class="composer">
      <div v-if="reply" class="reply-banner">
        <span>引用 {{ memberName(reply.from) }}: {{ reply.content.slice(0, 36) }}</span>
        <button aria-label="取消引用" @click="cancelReply">×</button>
      </div>
      <div class="tools">
        <button class="tool" aria-label="选择文件" @click="pickFiles">
          <CoomiIcon name="fileRead" :size="17" />
        </button>
        <button class="tool" aria-label="授权目录" @click="authorizeFolder">
          <CoomiIcon name="folder" :size="17" />
        </button>
        <button class="tool" aria-label="工作目录" title="打开工作目录" @click="openWorkDir">
          <CoomiIcon name="external" :size="17" />
        </button>
        <UiSelect v-model="target" :options="targetOptions" size="sm" class="target-select" aria-label="发送对象" />
      </div>
      <div v-if="draftPaths.length" class="path-chips">
        <span v-for="p in draftPaths" :key="p.id" class="chip">
          <CoomiIcon :name="p.isDir ? 'folder' : 'fileRead'" :size="12" />
          {{ pathName(p.path) }}
          <button aria-label="移除" @click="removeDraftPath(p.id)">×</button>
        </span>
      </div>
      <div class="input-row">
        <textarea
          v-model="draft"
          rows="1"
          :placeholder="running ? '运行中，可继续 @成员…' : '输入消息…'"
          @keydown.enter.exact.prevent="send"
        />
        <button class="send" :disabled="!draft.trim() || store.sending" @click="send">
          <CoomiIcon name="arrowUp" :size="17" />
        </button>
      </div>
    </footer>

    <!-- 权限 -->
    <div v-if="permAsk" class="mask center enter-flat" @click.self="permAsk = false">
      <div class="modal" @click.stop>
        <h3>需要存储权限</h3>
        <p class="modal-p">选择文件 / 授权目录前，请先允许存储访问。</p>
        <div class="actions">
          <button class="btn ghost" @click="permAsk = false">取消</button>
          <button class="btn primary" @click="openStorage">去设置</button>
        </div>
      </div>
    </div>

    <!-- 成员列表 -->
    <div class="mask" :class="{ on: membersOpen }" @click="membersOpen = false" />
    <aside class="side left members" :class="{ on: membersOpen }" aria-label="成员">
      <header class="side-head">
        <h2>群成员</h2>
        <button v-if="!editingMembers" class="link" @click="startEditMembers">编辑</button>
        <button v-else class="link" @click="saveMembers">保存</button>
        <button class="icon" @click="membersOpen = false"><CoomiIcon name="close" :size="16" /></button>
      </header>
      <div class="side-body">
        <template v-if="!editingMembers">
          <div v-for="m in room?.members || []" :key="m.id" class="mrow" role="button" tabindex="0" @click="openMemberDetail(m.id)">
            <span class="avatar md" :style="{ background: m.color }">
              <CoomiIcon :name="m.icon || 'chat'" :size="16" />
            </span>
            <div class="minfo">
              <strong>{{ m.name }}</strong>
              <small>{{ quotaText(m) }} 次 · 点头像看活动</small>
            </div>
            <span v-if="room?.hostAllow.includes(m.id)" class="host-tag">主持</span>
          </div>
          <button class="side-btn" @click="openWorkDir"><CoomiIcon name="folder" :size="14" /> 工作目录 / 文件</button>
          <button class="side-btn" @click="resetQuota">重置发言配额</button>
          <button class="side-btn" @click="clearChat">清空聊天记录</button>
        </template>
        <template v-else>
          <div v-for="(m, i) in memberForm" :key="m.id" class="edit-m">
            <span class="avatar sm" :style="{ background: m.color }">
              <CoomiIcon :name="m.icon || 'chat'" :size="12" />
            </span>
            <input v-model="m.name" maxlength="12" />
            <UiSelect v-model="m.icon" :options="iconOptions" size="sm" />
            <UiSelect v-model="m.modelSelector" :options="modelOptions" size="sm" placeholder="默认" />
            <input v-model.number="m.quota" type="number" min="0" max="99" class="q" title="0=不限" />
            <button v-if="memberForm.length > 1" class="del" @click="removeMember(i)">×</button>
            <!-- 人格字段 -->
            <input v-model="m.persona" class="persona" placeholder="人设（可选）" maxlength="200" />
            <input v-model="m.speakingStyle" class="persona" placeholder="说话风格（可选）" maxlength="80" />
            <input v-model="m.values" class="persona" placeholder="价值观（可选）" maxlength="120" />
            <!-- 绑定生命体 -->
            <label class="persona-label">绑定数字生命体</label>
            <input
              v-if="i === 0"
              v-model="lifeQuery"
              class="persona life-search"
              placeholder="搜索生命体…"
              @input="onLifeSearch"
            />
            <UiSelect
              v-model="m.lifeId"
              size="sm"
              class="life-sel"
              placeholder="不绑定"
              :options="[
                { value: '', label: '不绑定' },
                ...availableLives.map(l => ({ value: l.id, label: lifeLabel(l, m.id) })),
              ]"
            />
          </div>
          <button class="add" @click="addMember">+ 添加成员</button>
        </template>
      </div>
    </aside>

    <!-- 成员活动详情 -->
    <div class="mask" :class="{ on: memberDetailOpen }" @click="closeMemberDetail" />
    <aside class="side left member-detail" :class="{ on: memberDetailOpen }" aria-label="成员活动">
      <header class="side-head">
        <span class="avatar md" :style="{ background: memberDetail?.member?.color || '#2d61c6' }">
          <CoomiIcon :name="memberDetail?.member?.icon || 'chat'" :size="16" />
        </span>
        <div class="md-title">
          <h2>{{ memberDetail?.member?.name || '成员' }}</h2>
          <p v-if="memberDetail?.member?.modelSelector">{{ memberDetail.member.modelSelector }}</p>
        </div>
        <button class="icon" @click="closeMemberDetail"><CoomiIcon name="close" :size="16" /></button>
      </header>
      <div class="side-body">
        <p class="sec">思考 / 发言 / 交流</p>
        <div v-if="!memberDetail?.activities?.length" class="empty-sm">暂无活动记录</div>
        <div v-for="a in memberDetail?.activities || []" :key="a.id" class="act">
          <span class="act-kind" :class="a.kind">{{ a.kind === 'directed' ? '定向' : '发言' }}</span>
          <div>
            <p>{{ a.detail }}</p>
            <time>{{ fmtClock(a.atMs) }}</time>
          </div>
        </div>
        <p class="sec">相关消息</p>
        <div v-for="m in memberDetail?.recentMessages || []" :key="m.id" class="mini-msg">
          <strong>{{ memberName(m.from) }}</strong>
          <span>{{ m.content.slice(0, 80) }}</span>
        </div>
        <p class="sec">共享记忆</p>
        <div v-if="!memberMemory?.items?.length" class="empty-sm">暂无共享记忆</div>
        <div v-for="(it, mi) in (memberMemory?.items || []).slice(-8)" :key="mi" class="mini-msg mem">
          <span>{{ memoryText(it) }}</span>
        </div>
        <button class="side-btn" @click="openWorkDir"><CoomiIcon name="folder" :size="14" /> 打开工作目录</button>
        <button class="side-btn" @click="bindMemberLife"><CoomiIcon name="sparkle" :size="14" /> 绑定数字生命体</button>
        <button
          v-if="memberDetail?.member?.id && memberDetail.member.id !== 'user' && memberDetail.member.id !== 'owner'"
          class="side-btn danger"
          @click="removeFromRoom"
        >从本群移除</button>
      </div>
    </aside>

    <!-- 聊天信息（独立设置） -->
    <div class="mask" :class="{ on: panelOpen }" @click="closePanel" />
    <aside class="side right panel-sheet" :class="{ on: panelOpen }" aria-label="群设置">
      <header class="side-head">
        <h2>群设置</h2>
        <button class="icon" @click="closePanel"><CoomiIcon name="close" :size="16" /></button>
      </header>
      <div class="side-body">
        <div class="room-card">
          <span class="avatar xl" :style="{ background: room?.members[0]?.color || '#2d61c6' }">
            <CoomiIcon name="people" :size="22" />
          </span>
          <div>
            <strong>{{ room?.name || '群聊' }}</strong>
            <p>{{ room?.topic || '未设置话题' }}</p>
          </div>
        </div>

        <label class="lbl">工作目录</label>
        <p class="topic" :class="{ empty: !room?.workDir }">{{ room?.workDir || '未设置（授权目录后自动填写）' }}</p>
        <div class="file-actions">
          <button class="side-btn half" @click="openWorkDir"><CoomiIcon name="folder" :size="14" /> 文件管理</button>
          <button class="side-btn half" @click="authorizeFolder"><CoomiIcon name="folder" :size="14" /> 授权目录</button>
        </div>

        <label class="lbl">成员（{{ room?.members.length || 0 }}）</label>
        <div class="avatar-wall">
          <button v-for="m in room?.members || []" :key="m.id" class="wall-item" @click="openMemberDetail(m.id)">
            <span class="avatar md" :style="{ background: m.color }">
              <CoomiIcon :name="m.icon || 'chat'" :size="16" />
            </span>
            <span>{{ m.name }}</span>
          </button>
          <button class="wall-item" @click="toggleMembers">
            <span class="avatar md ghost-av"><CoomiIcon name="plus" :size="16" /></span>
            <span>管理</span>
          </button>
        </div>

        <label class="lbl">发言模式</label>
        <div class="modes">
          <button :class="{ on: room?.speakMode === 'round_robin' }" @click="changeMode('round_robin')">轮流</button>
          <button :class="{ on: room?.speakMode === 'open' }" @click="changeMode('open')">抢麦</button>
          <button :class="{ on: room?.speakMode === 'host' }" @click="changeMode('host')">主持</button>
        </div>

        <label class="lbl">闲聊（实验）</label>
        <div class="host-row">
          <label>
            <input type="checkbox" :checked="room?.idleChatEnabled || false" @change="toggleIdleChat(($event.target as HTMLInputElement).checked)" />
            <span>静默时成员自动闲聊</span>
          </label>
        </div>

        <label class="lbl">消息免打扰</label>
        <div class="host-row">
          <label>
            <input type="checkbox" :checked="room?.muted || false" @change="toggleMute(($event.target as HTMLInputElement).checked)" />
            <span>开启后新消息不再弹提醒</span>
          </label>
        </div>

        <template v-if="room?.speakMode === 'host'">
          <label class="lbl">指定可发言成员</label>
          <div v-for="m in room?.members || []" :key="m.id" class="host-row">
            <label>
              <input type="checkbox" :checked="room?.hostAllow.includes(m.id)" @change="toggleHost(m.id)" />
              <span class="avatar xs" :style="{ background: m.color }"><CoomiIcon :name="m.icon || 'chat'" :size="10" /></span>
              {{ m.name }}
            </label>
          </div>
          <button class="side-btn" @click="saveHost">保存主持名单</button>
        </template>

        <label class="lbl">思考强度（本群独立）</label>
        <div class="effort">
          <button
            v-for="item in REASONING_EFFORTS"
            :key="item.value"
            :class="{ on: (room?.reasoningEffort || 'auto') === item.value }"
            @click="changeEffort(item.value as RoomEffort)"
          >{{ item.label }}</button>
        </div>

        <label class="lbl">话题</label>
        <p class="topic" :class="{ empty: !room?.topic }">{{ room?.topic || '未设置' }}</p>
        <button class="side-btn" @click="openTopic">修改话题</button>

        <label class="lbl">工作文件</label>
        <div v-if="room?.contextPaths?.length" class="path-list">
          <div v-for="p in room.contextPaths" :key="p" class="path-row" role="button" tabindex="0" @click="openFileInManager(p)">
            <CoomiIcon :name="p.endsWith('/') || !p.includes('.') ? 'folder' : 'fileRead'" :size="14" />
            <span>{{ p }}</span>
          </div>
          <button class="side-btn" @click="clearRoomPaths">清空已授权路径</button>
        </div>
        <p v-else class="hint">暂无。可上传文件或授权目录，成员发言时会读取。</p>
        <div class="file-actions">
          <button class="side-btn half" @click="pickFiles"><CoomiIcon name="fileRead" :size="14" /> 选择文件</button>
          <button class="side-btn half" @click="authorizeFolder"><CoomiIcon name="folder" :size="14" /> 授权目录</button>
        </div>

        <label class="lbl">状态</label>
        <p class="topic">{{ room?.status === 'running' ? '讨论中' : room?.status === 'done' ? '本轮结束' : '空闲' }}</p>
        <button v-if="running" class="side-btn" @click="cancelRound">中止本轮发言</button>
        <button class="side-btn" @click="resetQuota">重置配额并继续</button>
        <button class="side-btn danger" @click="clearChat">清空记录</button>
        <p class="hint">基于 MA协同引擎构建 · 本群设置独立于协同与主聊天；数据仅存本机 group-chat 目录。</p>
      </div>
    </aside>

    <div v-if="topicEdit" class="mask center enter-flat" @click.self="topicEdit = false">
      <div class="modal" @click.stop>
        <h3>修改话题</h3>
        <input v-model="topicDraft" maxlength="80" placeholder="讨论焦点" />
        <div class="actions">
          <button class="btn ghost" @click="topicEdit = false">取消</button>
          <button class="btn primary" @click="saveTopic">保存</button>
        </div>
      </div>
    </div>

    <div v-if="renameOpen" class="mask center enter-flat" @click.self="renameOpen = false">
      <div class="modal" @click.stop>
        <h3>群名称</h3>
        <input v-model="nameDraft" maxlength="24" />
        <div class="actions">
          <button class="btn ghost" @click="renameOpen = false">取消</button>
          <button class="btn primary" :disabled="!nameDraft.trim()" @click="saveRename">保存</button>
        </div>
      </div>
    </div>
  </main>
</template>

<style scoped>
.page {
  display: flex; flex-direction: column; height: 100%;
  background: var(--page); position: relative; overflow: hidden; isolation: isolate;
}

.top {
  display: flex; align-items: center; gap: 6px;
  padding: var(--sp-2) 10px;
  padding-top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  background: var(--bg); border-bottom: 1px solid var(--border);
  z-index: 5; flex-shrink: 0;
}
.icon {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  flex-shrink: 0;
}
.icon.on { background: var(--blue-soft); color: var(--blue); }
.title { flex: 1; min-width: 0; cursor: pointer; }
.title h1 {
  margin: 0; font-size: var(--sp-4); font-weight: 700; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.title p { margin: 1px 0 0; font-size: var(--fs-caption); color: var(--text-3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.live { color: var(--blue); font-weight: 600; }
.done-tag { color: var(--orange); }
.stop {min-height: 30px; padding: 0 10px; border-radius: var(--r-sm);
  border: 1px solid var(--danger-border); color: var(--danger);
  background: transparent; font-size: var(--fs-label); flex-shrink: 0;
}
.stack-av { display: flex; align-items: center; }
.stack-item {
  width: 18px; height: 18px; border-radius: 50%;
  display: grid; place-items: center; color: #fff; font-style: normal;
  border: 1.5px solid var(--bg); margin-left: -6px;
}
.stack-item:first-child { margin-left: 0; }

.feed {
  flex: 1; overflow: auto; padding: 10px var(--sp-3);
  display: flex; flex-direction: column; gap: 10px;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}

.row-msg {
  display: flex; gap: var(--sp-2); align-items: flex-start; max-width: 92%;
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards; /* msgIn 已收敛到 global.css（气泡入场） */
  /* 长群聊的离屏消息跳过样式计算/布局/绘制，滚动时只渲染视口附近的行。
     为什么不用 DynamicScroller：.row-msg 的左右对齐依赖 .feed 的 flex 列
     （align-self），套进回收容器会丢掉这个上下文，且无法在此环境做视觉回归。
     auto 关键字会记住首次渲染的真实高度，翻历史时不会出现滚动跳动。 */
  content-visibility: auto;
  contain-intrinsic-size: auto 88px;
}
.row-msg.me { align-self: flex-end; flex-direction: row-reverse; }
.row-msg.them { align-self: flex-start; }
.row-msg.sys { align-self: center; }
.avatar-btn {
  border: 0; background: transparent; padding: 0; cursor: pointer;
  flex: 0 0 auto; width: 40px; align-self: flex-start;
  transition: transform var(--dur-fast) var(--ease-out);
}
.avatar-btn:active { transform: scale(var(--press-scale)); }
.avatar {
  width: 32px; height: 32px; border-radius: var(--r-md);
  display: inline-grid; place-items: center; color: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.12);
}
/* 消息头像与 meta-line 顶对齐微调 */
.row-msg .avatar-btn .avatar { margin-top: 2px; }
.avatar.xs { width: 18px; height: 18px; border-radius: var(--r-sm); }
.avatar.sm { width: 28px; height: 28px; border-radius: var(--r-sm); }
.avatar.md { width: 40px; height: 40px; border-radius: var(--r-md); }
.avatar.lg { width: 40px; height: 40px; border-radius: var(--r-md); }
.avatar.xl { width: 52px; height: 52px; border-radius: var(--r-card); }
.avatar.me { background: rgba(255,255,255,.22); }
.ghost-av { background: var(--fill); color: var(--text-2); border: 1px dashed var(--border); }

.col { display: flex; flex-direction: column; gap: 2px; flex: 1 1 auto; min-width: 0; max-width: min(72%, 320px); }
.row-msg.me .col { align-items: flex-end; }
.meta-line { display: flex; align-items: baseline; gap: 6px; padding: 0 2px; }
.who { font-size: var(--fs-caption); color: var(--text-3); font-weight: 500; }
.time { font-size: var(--fs-caption); color: var(--text-3); }
.bubble {
  padding: 9px var(--sp-3); border-radius: var(--r-card); font-size: var(--fs-sub); line-height: 1.55;
  word-break: break-word;
  transition: box-shadow var(--dur-base) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.bubble:active { transform: scale(var(--press-scale)); }
.row-msg.me .bubble {
  background: var(--blue); color: #fff; border-bottom-right-radius: 4px;
  box-shadow: 0 2px 8px rgba(45,97,198,.25);
}
.row-msg.me .bubble :deep(a) { color: #fff; }
.row-msg.them .bubble {
  background: var(--bg); border: 1px solid var(--border); border-bottom-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
}
.sys-bubble {
  padding: 6px 14px; border-radius: var(--r-pill); background: var(--fill);
  color: var(--text-2); font-size: var(--fs-label); max-width: 92%;
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards;
}
.quote-chip {
  margin: 0 0 6px; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-sm);
  background: rgba(255,255,255,.18); font-size: var(--fs-caption); opacity: 0.9;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.row-msg.them .quote-chip { background: var(--fill); }
.bubble .md :deep(p) { margin: 0 0 var(--sp-1); }
.bubble .md :deep(p:last-child) { margin-bottom: 0; }
.bubble .md :deep(pre) {
  margin: var(--sp-1) 0 0; padding: var(--sp-2); border-radius: var(--r-sm);
  background: var(--code-bg); color: var(--code-text);
  font: 11px/1.4 var(--font-mono); overflow: auto;
}
.bfoot {
  display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1);
  font-size: var(--fs-caption); opacity: 0.75;
}
.mini {
  border: 0; background: transparent; color: inherit; font-size: var(--fs-caption);
  display: inline-flex; align-items: center; gap: 2px; opacity: 0.85;
  padding: 0; transition: opacity var(--dur-fast) var(--ease-out);
}
.mini:active { opacity: 1; }
.typing {
  align-self: flex-start; display: flex; align-items: center; gap: var(--sp-2);
  padding: 10px 14px; border-radius: var(--r-card); background: var(--fill);
  color: var(--text-3); font-size: var(--fs-label);
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards;
}
/* 骨架替代转圈：等待发言指示改用 .sk 骨架脉冲（只换视觉，不改逻辑）。 */
.typing-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }
.done-bar {
  align-self: stretch; display: flex; align-items: center; justify-content: space-between;
  gap: 10px; padding: 10px var(--sp-3); border-radius: var(--r-md);
  background: var(--orange-soft, var(--fill)); color: var(--text-2); font-size: var(--fs-label);
}
.done-bar button {min-height: 28px; padding: 0 10px; border-radius: var(--r-sm); border: 0;
  background: var(--blue); color: #fff; font-size: var(--fs-label); font-weight: 600;
}

.composer {
  flex-shrink: 0;
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--sp-2) 10px calc(var(--sp-2) + var(--safe-bottom));
  border-top: 1px solid var(--border); background: var(--bg);
  z-index: 5;
  animation: slideUp var(--enter-block-dur) var(--ease-out) backwards; /* slideUp 已收敛到 global.css（100% 上滑，语义 = enter-block） */
}
.reply-banner {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px 10px; border-radius: var(--r-md);
  background: var(--blue-soft); color: var(--blue); font-size: var(--fs-label);
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards;
}
.reply-banner span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reply-banner button { border: 0; background: transparent; color: inherit; font-size: var(--fs-strong); }
.tools { display: flex; align-items: center; gap: 6px; }
.tool {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.tool:active { transform: scale(var(--press-scale)); background: var(--fill-strong); }
.tools select {
  margin-left: auto; min-height: 34px; max-width: 100px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font-size: var(--fs-label);
}
.path-chips {
  display: flex;
  flex-wrap: nowrap;
  gap: 6px;
  overflow-x: auto;
  -webkit-overflow-scrolling: touch;
  padding-bottom: 2px;
}
.chip {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  max-width: 220px; flex-shrink: 0;
  padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue); font-size: var(--fs-caption);
  white-space: nowrap;
}
.chip span, .chip-name {
  max-width: 140px;
  overflow: hidden; text-overflow: ellipsis;
}
.attach-top :deep(.file-chips),
.attach-top :deep(.inline-media) {
  overflow-x: auto;
  flex-wrap: nowrap;
  margin-bottom: 6px;
}
.attach-top :deep(.chip) {
  max-width: 180px;
  flex-shrink: 0;
}
.chip button {
  border: 0; background: transparent; color: inherit; font-size: var(--fs-body); line-height: 1; padding: 0;
}
.input-row { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-2); align-items: end; }
.input-row textarea {
  min-height: 38px; max-height: 100px; padding: 9px 11px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font: 13px/1.4 inherit;
  resize: none; outline: none;
}
.send {
  display: grid; place-items: center; width: 38px; height: 38px;
  border: 0; border-radius: var(--r-md); background: var(--blue); color: #fff;
}
.send:disabled { opacity: .35; }

.mask {
  position: absolute; inset: 0; z-index: var(--z-header);
  background: rgba(10,15,24,.42); opacity: 0; pointer-events: none;
  transition: opacity var(--dur-base) var(--ease-out);
}
.mask.on, .mask.center { opacity: 1; pointer-events: auto; }
.mask.center { display: flex; align-items: center; justify-content: center; }

.side {
  position: absolute; top: 0; bottom: 0; z-index: var(--z-sheet);
  width: min(90vw, 340px); background: var(--bg);
  display: flex; flex-direction: column;
  transition: transform var(--dur-base) var(--ease-out);
  box-shadow: 0 0 0 1px var(--border);
}
.side.right { right: 0; left: auto; transform: translate3d(105%, 0, 0); }
.side.left { left: 0; right: auto; transform: translate3d(-105%, 0, 0); }
.side.on { transform: translate3d(0, 0, 0); }
.side-head {
  display: flex; align-items: center; gap: 10px;
  padding: 14px 14px; padding-top: calc(14px + env(safe-area-inset-top, 0px));
  border-bottom: 1px solid var(--border); flex-shrink: 0;
}
.side-head h2 { margin: 0; font-size: var(--fs-strong); flex: 1; color: var(--text); font-weight: 600; }
.side-head .link {
  border: 0; background: var(--blue-soft); color: var(--blue); min-height: 30px; padding: 0 var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-label); font-weight: 600;
}
.md-title { flex: 1; min-width: 0; }
.md-title h2 { margin: 0; font-size: var(--fs-strong); font-weight: 600; }
.md-title p { margin: 3px 0 0; font-size: var(--fs-caption); color: var(--text-3); word-break: break-all; }
.side-body { flex: 1; overflow: auto; padding: 14px 14px calc(var(--sp-5) + var(--safe-bottom)); }
.sec { margin: 0 0 10px; font-size: var(--fs-label); color: var(--text-3); font-weight: 600; letter-spacing: 0.02em; }
/* 只覆盖本页需要的留白，字号/颜色沿用 global.css 的 .empty-sm。 */
.empty-sm { padding: var(--sp-6); }
.act {
  display: flex; gap: var(--sp-2); padding: 10px var(--sp-3); margin-bottom: var(--sp-2);
  border-radius: var(--r-md); background: var(--fill); font-size: var(--fs-label);
}
.act-kind {
  flex-shrink: 0; padding: 2px var(--sp-2); border-radius: var(--r-sm); font-size: var(--fs-caption);
  background: var(--blue-soft); color: var(--blue);
}
.act-kind.directed { background: var(--orange-soft, var(--fill)); color: var(--orange); }
.act p { margin: 0; color: var(--text); line-height: 1.45; }
.act time { font-size: var(--fs-caption); color: var(--text-3); }
.mini-msg {
  padding: 10px var(--sp-3); border-radius: var(--r-md); background: var(--fill);
  margin-bottom: var(--sp-2); font-size: var(--sp-3); color: var(--text-2);
}
.mini-msg strong { display: block; font-size: var(--fs-caption); color: var(--blue); margin-bottom: 3px; }
.mini-msg.mem { background: var(--blue-soft); color: var(--text-2); }
.life-search { margin-bottom: var(--sp-1); }

.room-card {
  display: flex; align-items: center; gap: 14px;
  padding: 14px; border-radius: var(--sp-4); background: var(--fill); margin-bottom: var(--sp-4);
}
.room-card strong { display: block; font-size: var(--fs-body-lg); color: var(--text); font-weight: 600; }
.room-card p { margin: var(--sp-1) 0 0; font-size: var(--fs-label); color: var(--text-3); }
.avatar-wall {
  display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; margin-bottom: 10px;
}
.wall-item {
  display: flex; flex-direction: column; align-items: center; gap: 5px;
  border: 0; background: transparent; color: var(--text-2); font-size: var(--fs-caption); padding: 6px 0;
}
.mrow {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 10px var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg-card); margin-bottom: 10px; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.mrow:active { background: var(--fill); }
.minfo { flex: 1; min-width: 0; }
.mrow strong { display: block; font-size: var(--fs-sub); color: var(--text); font-weight: 600; }
.mrow small { color: var(--text-3); font-size: var(--fs-caption); }
.host-tag {
  padding: 3px 10px; border-radius: var(--r-pill);
  /* 同 HomeView .mode.host：--purple 未定义会让 color 整条失效，标签变成无色。 */
  background: var(--fill-strong); color: var(--text-2); font-size: var(--fs-caption); font-weight: 600;
}
.hint { font-size: var(--fs-caption); color: var(--text-3); line-height: 1.6; margin: 10px 0 14px; }
.side-btn {
  width: 100%; min-height: 42px; border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--fill); color: var(--text); font-size: var(--fs-sub); font-weight: 600;
  margin-bottom: 10px; display: inline-flex; align-items: center; justify-content: center; gap: 6px;
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.side-btn:active { transform: scale(var(--press-scale)); background: var(--fill-strong); }
.side-btn.half { width: calc(50% - 5px); margin-right: 5px; }
.side-btn.danger { color: var(--danger); border-color: var(--danger-border); background: transparent; }
.file-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.edit-m {
  display: grid; grid-template-columns: 28px 0.9fr 0.7fr 1.2fr 40px 26px; gap: 6px;
  align-items: center; margin-bottom: var(--sp-3);
}
.edit-m input, .edit-m select {min-height: 36px; border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font-size: var(--fs-label); padding: 0 var(--sp-2); min-width: 0;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.edit-m input:focus, .edit-m select:focus { border-color: var(--blue); outline: none; }
.edit-m .q { text-align: center; }
.edit-m .persona {
  grid-column: 2 / -1; min-height: 34px; font-size: var(--fs-caption);
}
.edit-m .persona-label {
  grid-column: 2 / -1; font-size: var(--fs-caption); color: var(--text-3); font-weight: 600;
}
.edit-m .del {
  width: 28px; height: 28px; border: 0; border-radius: var(--r-sm);
  background: var(--fill); color: var(--danger);
}
.add {
  width: 100%; min-height: 40px; border-radius: var(--r-md);
  border: 1px dashed var(--blue); background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-sub); font-weight: 600; margin-bottom: 10px;
  transition: background var(--dur-fast) var(--ease-out);
}
.add:active { background: var(--blue-soft-2); }

.lbl { display: block; font-size: var(--fs-label); color: var(--text-3); margin: 18px 0 var(--sp-2); font-weight: 600; }
.modes { display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-2); }
.modes button {min-height: 40px; border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--fill); color: var(--text-2); font-size: var(--fs-sub); font-weight: 600;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.modes button:active { transform: scale(var(--press-scale)); }
.modes button.on { background: var(--blue-soft); border-color: var(--blue); color: var(--blue); }
.effort { display: flex; flex-wrap: wrap; gap: var(--sp-2); }
.effort button {
  flex: 1 1 auto; min-width: 56px; min-height: 36px; border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--fill);
  color: var(--text-2); font-size: var(--fs-label); font-weight: 600;
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.effort button.on { background: var(--blue-soft); border-color: var(--blue); color: var(--blue); }
.host-row { padding: var(--sp-2) 6px; font-size: var(--fs-sub); color: var(--text); }
.host-row label { display: flex; align-items: center; gap: 10px; }
.topic {
  margin: 0 0 10px; padding: var(--sp-3) 14px; border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font-size: var(--fs-sub); line-height: 1.5;
}
.topic.empty { color: var(--text-3); }
.path-list { margin-bottom: 10px; }
.path-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px var(--sp-3); border-radius: var(--r-md); background: var(--fill);
  margin-bottom: var(--sp-2); font-size: var(--sp-3); color: var(--text-2); cursor: pointer;
}
.path-row span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.modal {
  width: min(88vw, 300px); padding: var(--sp-4);
  background: var(--bg); border-radius: var(--r-card);
  /* 居中弹层入场：modalIn（已收敛 global.css，语义 = enter-pop），遮罩淡入由 .enter-flat 类负责 */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.modal h3 { margin: 0 0 10px; font-size: var(--fs-body-lg); color: var(--text); }
.modal-p { margin: 0 0 var(--sp-3); font-size: var(--fs-label); color: var(--text-3); line-height: 1.5; }
.modal input {
  width: 100%; min-height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--fill);
  color: var(--text); font-size: var(--fs-body); outline: none; margin-bottom: var(--sp-3);
}
.actions { display: flex; gap: var(--sp-2); }
.btn {
  flex: 1; min-height: 40px; border-radius: var(--r-md); border: 0;
  font-size: var(--fs-sub); font-weight: 600;
}
.btn.primary { background: var(--blue); color: #fff; }
.btn.primary:disabled { opacity: 0.45; }
.btn.ghost { background: var(--fill); color: var(--text-2); }

/* 减弱动态效果：侧栏/遮罩状态翻转直接出现；弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .side, .mask { transition: none !important; }
  .modal, .composer, .reply-banner { animation: none; }
}
:root[data-motion='off'] .modal, :root[data-motion='off'] .composer, :root[data-motion='off'] .reply-banner { animation: none; }
</style>
