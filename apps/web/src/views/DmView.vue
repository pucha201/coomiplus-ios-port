<script setup lang="ts">
/**
 * 单聊页 — 与项目内 identity 私聊。
 * 顶部返回 + 身份名 + 羁绊百分比；user 右侧气泡、identity 左侧。
 * 支持附件（选文件 / 授权目录）；头部可删除角色（全项目）。
 */
import { computed, nextTick, onMounted, onUnmounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import FileInline from '@/components/FileInline.vue'
import { useGroupChatStore } from '@/features/collab-chat/stores/groupChatStore'
import type { DmMessage, Identity } from '@/features/collab-chat/types/groupChat'
import { renderMarkdown } from '@/utils/markdown'

const route = useRoute()
const router = useRouter()
const store = useGroupChatStore()

const identityId = computed(() => String(route.params.identityId || ''))
const identity = ref<Identity | null>(null)
const messages = ref<DmMessage[]>([])
const draft = ref('')
const scroller = ref<HTMLElement | null>(null)
const loading = ref(false)
/** 待发送附件路径（与 RoomChatView 的 draftPaths 同思路） */
const draftPaths = ref<Array<{ id: string; path: string; isDir: boolean }>>([])
const permAsk = ref(false)

const bondPct = computed(() => Math.round((identity.value?.bond || 0) * 100))

function isMe(from: string) {
  return from === 'user'
}
function md(src: string) {
  return renderMarkdown(src || '')
}
function fmtClock(ts: number) {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
async function scrollBottom() {
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

async function load() {
  if (!identityId.value) return
  loading.value = true
  try {
    const data = await store.getDm(identityId.value)
    if (data) {
      identity.value = data.identity
      messages.value = data.messages || []
      await scrollBottom()
    } else {
      router.replace('/home')
    }
  } finally {
    loading.value = false
  }
}

async function send() {
  const text = draft.value.trim()
  if ((!text && !draftPaths.value.length) || store.sending) return
  const paths = draftPaths.value.map(p => p.path)
  // 乐观更新：先塞 user 消息
  const tmpId = `tmp_${Date.now()}`
  messages.value.push({
    id: tmpId, from: 'user', content: text, kind: 'text', ts: Date.now() / 1000,
    ...(paths.length ? { attachments: paths } : {}),
  })
  draft.value = ''
  draftPaths.value = []
  void scrollBottom()
  const data = await store.sendDm(identityId.value, text, paths)
  if (data) {
    // 用服务端消息替换乐观消息，并追加 reply；后端暂不回存 attachments 时本地兜底
    const userMsg: DmMessage = {
      ...data.userMessage,
      ...(data.userMessage.attachments?.length ? {} : (paths.length ? { attachments: paths } : {})),
    }
    const idx = messages.value.findIndex(m => m.id === tmpId)
    if (idx >= 0) messages.value.splice(idx, 1, userMsg)
    else messages.value.push(userMsg)
    if (data.reply) messages.value.push(data.reply)
    void scrollBottom()
  } else {
    // 失败：回滚乐观消息
    messages.value = messages.value.filter(m => m.id !== tmpId)
    draft.value = text
    draftPaths.value = paths.map((p, i) => ({ id: `p_${Date.now()}_${i}`, path: p, isDir: p.endsWith('/') || !p.includes('.') }))
  }
}

/** 删除角色：从本项目所有群移除 + 删记忆/单聊。 */
async function deleteRole() {
  const name = identity.value?.name
  const iid = identityId.value
  const pid = store.activeProject?.id
  if (!iid || !pid) return
  if (!confirm(`删除角色「${name || iid}」？将从本项目所有群聊中移除，并删除记忆与单聊，不可恢复。`)) return
  const r = await store.deleteIdentity(pid, iid)
  if (r) {
    router.push('/home')
  } else {
    alert(store.error || '删除失败，请重试')
  }
}

// ── 附件选择（复用 RoomChatView 的 Android bridge 逻辑） ──
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
}
function removeDraftPath(id: string) {
  draftPaths.value = draftPaths.value.filter(x => x.id !== id)
}
function pathName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}
function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[] }>).detail ?? {}
  for (const p of detail.paths ?? []) addPath(p, p.endsWith('/') || !p.includes('.'))
}
function onFolderSelected(event: Event) {
  const detail = (event as CustomEvent<{ path?: string | null }>).detail ?? {}
  if (detail.path) addPath(detail.path, true)
}

onMounted(() => {
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:folder-selected', onFolderSelected)
  void load()
})
onUnmounted(() => {
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:folder-selected', onFolderSelected)
})
</script>

<template>
  <main class="page">
    <header class="top">
      <button class="icon" aria-label="返回" @click="router.push('/home')">
        <CoomiIcon name="back" :size="20" />
      </button>
      <span class="avatar md" :style="{ background: identity?.color || '#2d61c6' }">
        <CoomiIcon :name="identity?.icon || 'chat'" :size="16" />
      </span>
      <div class="title">
        <h1>{{ identity?.name || '单聊' }}</h1>
        <p>
          羁绊 {{ bondPct }}%
          <template v-if="identity?.memoryCount"> · {{ identity.memoryCount }} 条记忆</template>
        </p>
      </div>
      <button class="del-role" aria-label="删除角色" @click="deleteRole">删除角色</button>
    </header>

    <section ref="scroller" class="feed">
      <!-- 消息骨架：左右气泡的比例与真实对话一致，避免数据到达时整列跳位 -->
      <UiSkeleton v-if="loading && !messages.length" variant="message" :rows="5" />
      <div v-else-if="!messages.length" class="empty-sm">开始和 {{ identity?.name || 'TA' }} 聊天吧</div>
      <article
        v-for="m in messages"
        :key="m.id"
        class="row-msg"
        :class="isMe(m.from) ? 'me' : 'them'"
      >
        <span v-if="!isMe(m.from)" class="avatar sm" :style="{ background: identity?.color || '#2d61c6' }">
          <CoomiIcon :name="identity?.icon || 'chat'" :size="12" />
        </span>
        <div class="col">
          <div class="bubble">
            <FileInline v-if="m.attachments?.length" :paths="m.attachments" class="attach-top" />
            <div class="md" v-html="md(m.content)" />
          </div>
          <time class="time">{{ fmtClock(m.ts) }}</time>
        </div>
        <span v-if="isMe(m.from)" class="avatar sm me"><CoomiIcon name="user" :size="12" /></span>
      </article>
      <div v-if="store.sending" class="typing">
        <span class="sk typing-dot" />
        {{ identity?.name || '对方' }}正在回复…
      </div>
    </section>

    <footer class="composer">
      <div class="tools">
        <button class="tool" aria-label="选择文件" @click="pickFiles">
          <CoomiIcon name="fileRead" :size="17" />
        </button>
        <button class="tool" aria-label="授权目录" @click="authorizeFolder">
          <CoomiIcon name="folder" :size="17" />
        </button>
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
          placeholder="输入消息…"
          @keydown.enter.exact.prevent="send"
        />
        <button class="send" :disabled="(!draft.trim() && !draftPaths.length) || store.sending" @click="send">
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
  </main>
</template>

<style scoped>
.page {
  display: flex; flex-direction: column; height: 100%;
  background: var(--page); position: relative; overflow: hidden;
}

.top {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) 10px;
  padding-top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  background: var(--bg); border-bottom: 1px solid var(--border);
  flex-shrink: 0; z-index: 5;
}
.icon {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  flex-shrink: 0;
}
.title { flex: 1; min-width: 0; }
.title h1 {
  margin: 0; font-size: var(--sp-4); font-weight: 700; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.title p { margin: 1px 0 0; font-size: var(--fs-caption); color: var(--text-3); }
.del-role {min-height: 28px; padding: 0 10px; border-radius: var(--r-sm); flex-shrink: 0;
  border: 1px solid var(--danger-border, rgba(220, 80, 70, 0.35));
  background: transparent; color: var(--danger);
  font-size: var(--fs-caption); font-weight: 600;
}

.feed {
  flex: 1; overflow: auto; padding: var(--sp-3);
  display: flex; flex-direction: column; gap: 10px;
  -webkit-overflow-scrolling: touch;
  scroll-behavior: smooth;
}

.row-msg {
  display: flex; gap: var(--sp-2); align-items: flex-end; max-width: 92%;
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards; /* msgIn 已收敛到 global.css（气泡入场） */
}
.row-msg.me { align-self: flex-end; flex-direction: row-reverse; }
.row-msg.them { align-self: flex-start; }
.avatar {
  width: 32px; height: 32px; border-radius: var(--r-md);
  display: inline-grid; place-items: center; color: #fff;
  box-shadow: 0 1px 3px rgba(0,0,0,.12); flex-shrink: 0;
}
.avatar.sm { width: 28px; height: 28px; border-radius: var(--r-sm); }
.avatar.md { width: 40px; height: 40px; border-radius: var(--r-md); }
.avatar.me { background: #2d61c6; }

.col { display: flex; flex-direction: column; gap: 2px; min-width: 0; max-width: min(78%, 340px); }
.row-msg.me .col { align-items: flex-end; }
.bubble {
  padding: 9px var(--sp-3); border-radius: var(--r-card); font-size: var(--fs-sub); line-height: 1.55;
  word-break: break-word;
}
.row-msg.me .bubble {
  background: var(--blue); color: #fff; border-bottom-right-radius: 4px;
  box-shadow: 0 2px 8px rgba(45,97,198,.25);
}
.row-msg.me .bubble :deep(a) { color: #fff; }
.row-msg.them .bubble {
  background: var(--bg); border: 1px solid var(--border); border-bottom-left-radius: 4px;
  box-shadow: 0 1px 4px rgba(0,0,0,.06);
}
.bubble .md :deep(p) { margin: 0 0 var(--sp-1); }
.bubble .md :deep(p:last-child) { margin-bottom: 0; }
.bubble .md :deep(pre) {
  margin: var(--sp-1) 0 0; padding: var(--sp-2); border-radius: var(--r-sm);
  background: var(--code-bg); color: var(--code-text);
  font: 11px/1.4 var(--font-mono); overflow: auto;
}
.attach-top :deep(.file-chips),
.attach-top :deep(.inline-media) {
  margin: 0 0 6px;
  flex-wrap: nowrap;
  overflow-x: auto;
}
.time { font-size: var(--fs-caption); color: var(--text-3); padding: 0 2px; }
.typing {
  align-self: flex-start; display: flex; align-items: center; gap: var(--sp-2);
  padding: 10px 14px; border-radius: var(--r-card); background: var(--fill);
  color: var(--text-3); font-size: var(--fs-label);
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards;
}
/* 骨架替代转圈：等待回复指示改用 .sk 骨架脉冲（只换视觉，不改逻辑）。 */
.typing-dot { width: 12px; height: 12px; border-radius: 50%; flex: none; }

.composer {
  flex-shrink: 0;
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--sp-2) 10px calc(var(--sp-2) + var(--safe-bottom));
  border-top: 1px solid var(--border); background: var(--bg);
  z-index: 5;
}
.tools { display: flex; align-items: center; gap: 6px; }
.tool {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.tool:active { transform: scale(var(--press-scale)); background: var(--fill-strong); }
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
  background: rgba(10,15,24,.42);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: min(88vw, 300px); padding: var(--sp-4);
  background: var(--bg); border-radius: var(--r-card);
  /* 居中弹层入场：modalIn（已收敛 global.css，语义 = enter-pop），遮罩淡入由 .enter-flat 类负责 */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.modal h3 { margin: 0 0 10px; font-size: var(--fs-body-lg); color: var(--text); }
.modal-p { margin: 0 0 var(--sp-3); font-size: var(--fs-label); color: var(--text-3); line-height: 1.5; }
.actions { display: flex; gap: var(--sp-2); }
.btn {
  flex: 1; min-height: 40px; border-radius: var(--r-md); border: 0;
  font-size: var(--fs-sub); font-weight: 600;
}
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill); color: var(--text-2); }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .modal { animation: none; }
}
:root[data-motion='off'] .modal { animation: none; }
</style>
