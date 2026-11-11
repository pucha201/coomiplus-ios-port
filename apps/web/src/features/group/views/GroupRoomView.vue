<script setup lang="ts">
/** 群聊房间页：消息 + 输入 + 设置 + 成员编辑（含职业/生命体绑定）。 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useGroupStore } from '../store'
import { groupApi } from '../api'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import MessageBubble from '../components/MessageBubble.vue'
import Composer from '../components/Composer.vue'
import MemberDetail from '../components/MemberDetail.vue'
import GroupSettings from '../components/GroupSettings.vue'
import { usePolling } from '../composables/usePolling'
import { useConfigStore } from '@/stores/config'
import type { RoomMember, RoomMessage, SpeakMode, RoomEffort } from '../types'

const route = useRoute()
const router = useRouter()
const store = useGroupStore()
const config = useConfigStore()

const roomId = computed(() => String(route.params.roomId || ''))
const room = computed(() =>
  store.current?.id === roomId.value ? store.current : null,
)
const running = computed(() => room.value?.status === 'running')

const models = computed(() =>
  config.providers.flatMap(p =>
    (p.models.length ? p.models : [p.model]).filter(Boolean)
      .map(m => ({ value: `${p.id}:${m}`, label: `${p.name} · ${m}` })),
  ),
)

const iconOptions = [
  { value: 'chat', label: '💬 聊天' },
  { value: 'terminal', label: '💻 终端' },
  { value: 'shield', label: '🛡 审查' },
  { value: 'people', label: '👥 协作' },
  { value: 'sparkle', label: '✨ 创意' },
  { value: 'target', label: '🎯 目标' },
]
const modelOptions = computed(() => [
  { value: '', label: '默认模型' },
  ...models.value,
])
const lifeOptions = computed(() => [
  { value: '', label: '不绑定' },
  ...availableLives.value.map(l => ({
    value: l.id, label: lifeLabel(l, 'unused'),
  })),
])

const scroller = ref<HTMLElement | null>(null)
const reply = ref<RoomMessage | null>(null)
const speakingId = ref('')
const panelOpen = ref(false)
const memberDetailOpen = ref(false)
const memberDetail = ref<{ member: RoomMember | null; activities: any[]; recentMessages: any[] } | null>(null)
const memberMemory = ref<{ items: unknown[]; total: number } | null>(null)
const draftPaths = ref<Array<{ id: string; path: string; isDir: boolean }>>([])

// 弹层
const topicOpen = ref(false)
const topicDraft = ref('')
const renameOpen = ref(false)
const nameDraft = ref('')
const membersOpen = ref(false)
const editingMembers = ref<RoomMember[]>([])

// 生命体列表（编辑成员时绑定用）
const availableLives = ref<Array<{ id: string; name: string; boundMemberId?: string }>>([])
const lifeQuery = ref('')

usePolling(running, () => void refresh())

async function refresh() {
  if (!roomId.value) return
  await store.loadRoom(roomId.value)
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

onMounted(async () => {
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:folder-selected', onFolderSelected)
  if (config.providers.length === 0) void config.fetchProviders()
  if (roomId.value) {
    const r = await store.loadRoom(roomId.value)
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
    if (!r) router.replace('/home')
  }
})

onUnmounted(() => {
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:folder-selected', onFolderSelected)
})

watch(() => room.value?.messages.length, () => {
  nextTick(() => {
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  })
})

function goHome() {
  store.error = ''
  router.push('/home')
}

function onSend(content: string, to: string, paths: string[], replyTo?: string) {
  reply.value = null
  draftPaths.value = []
  void store.send(content, to, paths, replyTo)
}

// ── 成员详情 ────────────────────────────────────────────────

async function openMemberDetail(id: string) {
  const data = await store.memberActivities(id)
  if (data) {
    memberDetail.value = { member: data.member, activities: data.activities, recentMessages: data.recentMessages }
    memberDetailOpen.value = true
    memberMemory.value = null
    if (data.member?.identityId) {
      memberMemory.value = await store.identityMemory(data.member.identityId)
    }
  }
}

async function bindMemberLife() {
  const mid = memberDetail.value?.member?.id
  const name = memberDetail.value?.member?.name
  const rid = room.value?.id
  if (!mid || !rid) return
  try {
    const data = await groupApi.groupLifeRegistry()
    const lives = (data.lives || []) as Array<{ id: string; name: string }>
    if (!lives.length) {
      alert('还没有生命体，请先在控制台「群聊生命体」页创建。')
      return
    }
    let selected = -1
    for (let i = 0; i < lives.length; i++) {
      if (confirm(`选择生命体：「${lives[i].name}」？\n（取消 = 看下一个）`)) {
        selected = i
        break
      }
    }
    if (selected < 0) return
    const iid = memberDetail.value?.member?.identityId
    await groupApi.bindGroupLife(lives[selected].id, rid, mid, iid)
    alert(`已绑定「${lives[selected].name}」到 ${name}`)
    memberDetailOpen.value = false
    await store.loadRoom(rid)
  } catch (e) {
    alert('失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

async function removeFromRoom() {
  const mid = memberDetail.value?.member?.id
  const name = memberDetail.value?.member?.name
  const rid = room.value?.id
  if (!mid || !rid) return
  if (!confirm(`从本群移除「${name}」？其他群与共享记忆不受影响。`)) return
  const updated = await store.removeGroupMember(rid, mid)
  if (updated) {
    memberDetailOpen.value = false
  } else {
    alert(store.error || '移除失败')
  }
}

async function deleteRoom() {
  const rid = room.value?.id
  const name = room.value?.name || '该群聊'
  if (!rid) return
  if (!confirm(`确定删除群聊「${name}」？群消息与成员配置将一并删除，不可恢复。`)) return
  try {
    await store.removeRoom(rid)
    router.replace('/home')
  } catch (e) {
    alert('删除失败: ' + (e instanceof Error ? e.message : String(e)))
  }
}

// ── 生命体加载 ──────────────────────────────────────────────

async function loadLives(q = '') {
  try {
    const data = await groupApi.groupLifeRegistry(q)
    availableLives.value = (data.lives || []).map((l: any) => ({
      id: l.id, name: l.name, boundMemberId: l.boundMemberId,
    }))
  } catch { availableLives.value = [] }
}

let lifeSearchTimer: ReturnType<typeof setTimeout> | null = null
function onLifeSearch() {
  if (lifeSearchTimer) clearTimeout(lifeSearchTimer)
  lifeSearchTimer = setTimeout(() => { void loadLives(lifeQuery.value.trim()) }, 250)
}

function lifeLabel(l: { id: string; name: string; boundMemberId?: string }, selfId: string): string {
  if (l.boundMemberId && l.boundMemberId !== selfId) return `${l.name}（已绑定）`
  return l.name
}

// ── 话题 / 重命名 ──────────────────────────────────────────

function openTopic() {
  topicDraft.value = room.value?.topic || ''
  topicOpen.value = true
}

async function saveTopic() {
  await store.setTopic(topicDraft.value.trim())
  topicOpen.value = false
}

function openRename() {
  nameDraft.value = room.value?.name || ''
  renameOpen.value = true
}

async function saveRename() {
  const n = nameDraft.value.trim()
  if (!n) return
  await store.rename(n)
  renameOpen.value = false
}

async function toggleIdleChat(enabled: boolean) {
  if (!room.value) return
  await store.patchRoom({ idleChatEnabled: enabled })
}

// ── 成员编辑 ────────────────────────────────────────────────

function startEditMembers() {
  editingMembers.value = (room.value?.members || []).map(m => ({ ...m }))
  membersOpen.value = true
  lifeQuery.value = ''
  void loadLives()
}

function addMember() {
  const palette = ['#2d61c6', '#d47458', '#1f9d6b', '#8b5cf6', '#db2777']
  const icons = ['chat', 'terminal', 'shield', 'people', 'sparkle', 'target']
  const i = editingMembers.value.length
  editingMembers.value.push({
    id: `m${Date.now()}_${i}`, name: `成员${i + 1}`, modelSelector: models.value[0]?.value || '', prompt: '参与讨论，给出有帮助的回复。', color: palette[i % palette.length], icon: icons[i % icons.length], quota: 8, persona: '', speakingStyle: '', values: '', emotionBias: 0,
  })
}

function removeMember(i: number) {
  if (editingMembers.value.length <= 1) return
  editingMembers.value.splice(i, 1)
}

async function saveMembers() {
  const updated = await store.updateMembers(editingMembers.value)
  if (updated) {
    membersOpen.value = false
  } else {
    alert(store.error || '保存失败')
  }
}

// ── 设置 ────────────────────────────────────────────────────

function setMode(mode: SpeakMode) { void store.setSpeakMode(mode) }
function setEffort(effort: RoomEffort) { void store.setEffort(effort) }
function toggleMute(muted: boolean) { void store.setRoomMute(muted) }

function openWorkDir() { router.push('/files') }

// ── 文件选择 / 授权目录 ────────────────────────────────────

const permAsk = ref(false)

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
  ;(window as any).CoomiAndroid?.importFiles?.()
}

function authorizeFolder() {
  if (!ensureStorage()) return
  ;(window as any).CoomiAndroid?.authorizeFolder?.()
}

function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[] }>).detail ?? {}
  for (const p of detail.paths ?? []) {
    draftPaths.value.push({ id: `p_${Date.now()}_${Math.random()}`, path: p, isDir: false })
  }
}

function onFolderSelected(event: Event) {
  const detail = (event as CustomEvent<{ path?: string | null }>).detail ?? {}
  if (detail.path) {
    draftPaths.value.push({ id: `p_${Date.now()}_${Math.random()}`, path: detail.path, isDir: true })
    void store.setWorkDir(detail.path.replace(/\/$/, ''))
  }
}
</script>

<template>
  <main class="page">
    <header class="top">
      <button class="back" aria-label="返回消息列表" @click="goHome">
        <CoomiIcon name="back" :size="18" />
      </button>
      <button class="title" @click="openRename">
        <h1>{{ room?.name || '群聊' }}</h1>
        <p>
          <span v-if="running" class="live">
            <i class="live-dot" />讨论中
          </span>
          <span v-else class="members-line">
            <span class="stack">
              <i
                v-for="(c, i) in (room?.members || []).slice(0, 4).map(m => m.color)"
                :key="i"
                :style="{ background: c }"
              />
            </span>
            {{ room?.members.length || 0 }} 位
          </span>
          <template v-if="!running && room?.topic"> · {{ room.topic.slice(0, 14) }}</template>
        </p>
      </button>
      <button v-if="running" class="stop" aria-label="停止讨论" @click="store.cancelRound()">
        <CoomiIcon name="stop" :size="14" />
        <span>停止</span>
      </button>
      <button class="icon" :class="{ on: panelOpen }" aria-label="设置" @click="panelOpen = !panelOpen">
        <CoomiIcon name="settings" :size="18" />
      </button>
    </header>

    <section ref="scroller" class="feed">
      <div v-if="!room?.messages.length" class="empty-sm">
        <p>还没有消息。发送第一条。</p>
      </div>
      <MessageBubble
        v-for="m in room?.messages || []"
        :key="m.id"
        :msg="m"
        :members="room?.members || []"
        :speaking-id="speakingId"
        :reply-msg="m.replyTo ? (room?.messages.find(x => x.id === m.replyTo) || null) : null"
        @avatar="openMemberDetail"
        @reply="reply = $event"
        @speak="speakingId = $event.id"
      />
      <div v-if="running" class="typing">
        <span class="sk typing-dot" />
        成员发言中…
      </div>
    </section>

    <Composer
      :members="room?.members || []"
      :running="running"
      :sending="store.sending"
      :reply="reply"
      :draft-paths="draftPaths"
      @send="onSend"
      @cancel-reply="reply = null"
      @pick-files="pickFiles"
      @authorize-folder="authorizeFolder"
      @remove-draft-path="id => draftPaths = draftPaths.filter(p => p.id !== id)"
      @open-work-dir="openWorkDir"
    />

    <!-- 成员详情 -->
    <MemberDetail
      :open="memberDetailOpen"
      :member="memberDetail?.member || null"
      :activities="memberDetail?.activities || []"
      :recent-messages="memberDetail?.recentMessages || []"
      :memory="memberMemory"
      @close="memberDetailOpen = false"
      @bind="bindMemberLife"
      @remove="removeFromRoom"
      @open-work-dir="openWorkDir"
    />

    <!-- 群设置 -->
    <GroupSettings
      :open="panelOpen"
      :room="room"
      @close="panelOpen = false"
      @set-mode="setMode"
      @set-effort="setEffort"
      @toggle-mute="toggleMute"
      @toggle-idle-chat="toggleIdleChat"
      @open-topic="openTopic"
      @open-rename="openRename"
      @open-work-dir="openWorkDir"
      @clear-paths="store.clearPaths"
      @reset-quotas="store.resetQuotas"
      @clear-history="store.clearHistory"
      @cancel-round="store.cancelRound"
      @delete-room="deleteRoom"
      @edit-members="startEditMembers"
    />

    <!-- 话题 -->
    <div v-if="topicOpen" class="mask center enter-flat" @click.self="topicOpen = false">
      <div class="modal">
        <h3>修改话题</h3>
        <input v-model="topicDraft" placeholder="群话题" maxlength="80" @keydown.enter="saveTopic" />
        <div class="actions">
          <UiButton variant="ghost" size="md" @click="topicOpen = false">取消</UiButton>
          <UiButton variant="primary" size="md" @click="saveTopic">保存</UiButton>
        </div>
      </div>
    </div>

    <!-- 重命名 -->
    <div v-if="renameOpen" class="mask center enter-flat" @click.self="renameOpen = false">
      <div class="modal">
        <h3>重命名群聊</h3>
        <input v-model="nameDraft" placeholder="群名称" maxlength="30" @keydown.enter="saveRename" />
        <div class="actions">
          <UiButton variant="ghost" size="md" @click="renameOpen = false">取消</UiButton>
          <UiButton variant="primary" size="md" @click="saveRename">保存</UiButton>
        </div>
      </div>
    </div>

    <!-- 成员编辑（含职业 + 生命体绑定） -->
    <div v-if="membersOpen" class="mask center enter-flat" @click.self="membersOpen = false">
      <div class="modal members-modal">
        <h3>编辑成员（{{ editingMembers.length }}）</h3>
        <div class="members-list">
          <div v-for="(m, i) in editingMembers" :key="m.id" class="member-card">
            <div class="member-head">
              <span class="avatar sm" :style="{ background: m.color }">
                <CoomiIcon :name="m.icon || 'chat'" :size="14" />
              </span>
              <input v-model="m.name" class="name-input" placeholder="名字" maxlength="12" />
              <button class="rm" @click="removeMember(i)">✕</button>
            </div>
            <!-- 职业（图标） -->
            <label class="fl">职业</label>
            <UiSelect v-model="m.icon" :options="iconOptions" block />
            <label class="fl">模型</label>
            <UiSelect v-model="m.modelSelector" :options="modelOptions" block placeholder="默认模型" />
            <label class="fl">职责 / 人设</label>
            <textarea v-model="m.prompt" class="field ta" placeholder="输入角色职责" rows="2" />
            <label class="fl">扩展人设（可选）</label>
            <input v-model="m.persona" class="field" placeholder="更详细的人格描述" />
            <input v-model="m.speakingStyle" class="field" placeholder="说话风格（可选）" />
            <input v-model="m.values" class="field" placeholder="价值观（可选）" />
            <div class="quota-row">
              <label class="fl">发言配额</label>
              <input v-model.number="m.quota" type="number" min="0" max="99" class="quota-input" title="0=不限" />
            </div>
            <!-- 绑定生命体 -->
            <label class="fl">绑定数字生命体</label>
            <input
              v-if="i === 0"
              v-model="lifeQuery"
              class="field life-search"
              placeholder="搜索生命体…"
              @input="onLifeSearch"
            />
            <UiSelect v-model="m.lifeId" :options="lifeOptions" block placeholder="不绑定" />
          </div>
        </div>
        <button class="add-btn" @click="addMember">+ 添加成员</button>
        <div class="actions">
          <UiButton variant="ghost" size="md" @click="membersOpen = false">取消</UiButton>
          <UiButton variant="primary" size="md" @click="saveMembers">保存</UiButton>
        </div>
      </div>
    </div>

    <!-- 存储权限弹窗 -->
    <div v-if="permAsk" class="mask center enter-flat" @click.self="permAsk = false">
      <div class="modal">
        <h3>需要存储权限</h3>
        <p class="modal-p">选择文件 / 授权目录前，请先允许存储访问。</p>
        <div class="actions">
          <UiButton variant="ghost" size="md" @click="permAsk = false">取消</UiButton>
          <UiButton variant="primary" size="md" @click="openStorage">去设置</UiButton>
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
.back {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md);
  background: transparent; color: var(--text);
  flex-shrink: 0; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.back:active { background: var(--fill); transform: scale(var(--press-scale)); }
.icon {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  flex-shrink: 0; cursor: pointer; transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.icon:active { transform: scale(var(--press-scale)); }
.icon.on { background: var(--blue-soft); color: var(--blue); }
.title {
  flex: 1; min-width: 0; cursor: pointer;
  border: 0; background: transparent; padding: 0 2px;
  text-align: left; color: inherit;
}
.title h1 {
  margin: 0; font-size: var(--fs-body-lg); font-weight: 700; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  letter-spacing: -0.01em;
}
.title p {
  margin: 2px 0 0; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  display: flex; align-items: center; gap: 6px;
}
.live {
  display: inline-flex; align-items: center; gap: 5px;
  color: var(--ok); font-weight: 600;
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ok); flex-shrink: 0;
  --livepulse-min: 0.4; /* 本处原谷值 0.4，经变量保留（global.css 默认 0.45） */
  animation: livePulse var(--dur-loop) var(--ease-in-out) infinite;
}
/* livePulse 已收敛到 global.css（进行中呼吸，语义态保留）。 */
.members-line {
  display: inline-flex; align-items: center; gap: 5px;
}
.stack { display: flex; flex-shrink: 0; }
.stack i {
  width: 14px; height: 14px; border-radius: 4px;
  border: 1.5px solid var(--bg); margin-left: calc(-1 * var(--sp-1));
}
.stack i:first-child { margin-left: 0; }
.stop {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  height: 30px; padding: 0 10px; border-radius: var(--r-sm);
  border: 1px solid var(--danger-border); color: var(--danger);
  background: var(--danger-soft);
  font-size: var(--fs-label); font-weight: 600;
  flex-shrink: 0; cursor: pointer;
  transition: transform var(--dur-press) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.stop:active { transform: scale(var(--press-scale)); background: color-mix(in srgb, var(--danger-soft) 70%, var(--danger)); }
.feed {
  flex: 1; overflow-y: auto; padding: 10px var(--sp-3);
  display: flex; flex-direction: column; gap: 10px;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}

.typing {
  align-self: flex-start; display: flex; align-items: center; gap: var(--sp-2);
  padding: 10px 14px; border-radius: var(--r-card); background: var(--fill);
  color: var(--text-3); font-size: var(--fs-label);
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards; /* msgIn 已收敛到 global.css（气泡入场） */
}
/* 骨架替代转圈：等待回复的加载指示不再转圈，改用 .sk 骨架脉冲（只换视觉，不改逻辑）。 */
.typing-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }

.mask {
  position: absolute; inset: 0; z-index: var(--z-header);
  background: rgba(10,15,24,.42);
  transition: opacity var(--dur-base) var(--ease-out);
}
.mask.center { display: flex; align-items: center; justify-content: center; z-index: var(--z-toast); }
.modal {
  width: min(420px, 94vw); max-height: 80vh; overflow-y: auto;
  background: var(--bg); border-radius: var(--r-card); padding: var(--sp-4);
  box-shadow: 0 8px 32px rgba(0,0,0,.18);
  animation: modalIn var(--enter-pop-dur) var(--ease-out) backwards; /* modalIn 已收敛到 global.css（模态入场） */
}
/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关；遮罩淡入由 .enter-flat 类兜底） */
@media (prefers-reduced-motion: reduce) {
  .modal { animation: none; }
}
:root[data-motion='off'] .modal { animation: none; }
.modal h3 { margin: 0 0 var(--sp-3); font-size: var(--fs-strong); font-weight: 700; }
.modal-p { margin: 0 0 14px; font-size: var(--fs-sub); color: var(--text-3); line-height: 1.5; }
.modal input {
  width: 100%; padding: 10px 11px; border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: var(--fs-body); margin-bottom: var(--sp-3);
  box-sizing: border-box; background: var(--fill); color: var(--text);
  outline: none; transition: border-color var(--dur-fast) var(--ease-out);
}
.modal input:focus { border-color: var(--blue); }

.members-modal { max-height: 88vh; }
.members-list { display: flex; flex-direction: column; gap: 10px; margin-bottom: 10px; max-height: 55vh; overflow-y: auto; }
.member-card {
  padding: var(--sp-3); border-radius: var(--r-md); background: var(--fill);
  display: flex; flex-direction: column; gap: 6px;
  border: 1px solid transparent; transition: border-color var(--dur-fast) var(--ease-out);
}
.member-card:focus-within { border-color: var(--blue-soft); }
.member-head { display: flex; gap: 6px; align-items: center; }
.avatar {
  display: grid; place-items: center; border-radius: var(--r-md); color: #fff; flex-shrink: 0;
}
.avatar.sm { width: 28px; height: 28px; border-radius: var(--r-sm); }
.name-input { flex: 1; min-width: 0; margin-bottom: 0 !important; }
.rm {
  width: 28px; height: 28px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--danger); cursor: pointer;
  font-size: var(--fs-body); flex-shrink: 0; transition: background var(--dur-fast) var(--ease-out);
}
.rm:active { background: rgba(211,47,47,.1); }
.fl { font-size: var(--fs-caption); font-weight: 600; color: var(--text-2); margin-top: var(--sp-1); }
.field {
  width: 100%; padding: var(--sp-2) 10px; border: 1px solid var(--border);
  border-radius: var(--r-sm); font-size: var(--fs-sub);
  box-sizing: border-box; background: var(--bg); color: var(--text);
  margin-bottom: 0 !important; outline: none; transition: border-color var(--dur-fast) var(--ease-out);
}
.field:focus { border-color: var(--blue); }
select.field {
  appearance: none; -webkit-appearance: none;
  padding-right: 28px;
  background-image: url("data:image/svg+xml,%3Csvg width='10' height='6' viewBox='0 0 10 6' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%239096a2' stroke-width='1.5' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  cursor: pointer;
}
.ta { resize: none; min-height: 48px; font-family: inherit; }
.quota-row { display: flex; align-items: center; gap: var(--sp-2); }
.quota-input {
  width: 60px; padding: 6px var(--sp-2); border: 1px solid var(--border);
  border-radius: var(--r-sm); font-size: var(--fs-sub); box-sizing: border-box;
  background: var(--bg); color: var(--text); margin-bottom: 0 !important;
  outline: none;
}
.life-search { margin-bottom: var(--sp-1) !important; }
.add-btn {
  width: 100%; margin-bottom: 10px; padding: var(--sp-2);
  border: 1px dashed var(--border); border-radius: var(--r-sm);
  background: transparent; font-size: var(--fs-label); cursor: pointer; color: var(--text-2);
  transition: border-color var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.add-btn:active { border-color: var(--blue); color: var(--blue); }
.actions { display: flex; gap: var(--sp-2); }
.btn {
  flex: 1; padding: 10px; border: 0; border-radius: var(--r-md);
  font-size: var(--fs-sub); cursor: pointer; transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.btn:active { transform: scale(var(--press-scale)); }
.btn.ghost { background: var(--fill); }
.btn.primary { background: var(--blue, #2d61c6); color: #fff; }
</style>
