<script setup lang="ts">
/** 单聊页：与项目内身份 1:1 对话。 */
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useGroupStore } from '../store'
import type { DmMessage, Identity } from '../types'

const route = useRoute()
const router = useRouter()
const store = useGroupStore()

const identityId = computed(() => String(route.params.identityId || ''))
const identity = ref<Identity | null>(null)
const messages = ref<DmMessage[]>([])
const draft = ref('')
const sending = ref(false)
const draftPaths = ref<Array<{ id: string; path: string; isDir: boolean }>>([])
const scroller = ref<HTMLElement | null>(null)

const isMe = (from: string) => from === 'user'

async function load() {
  if (!identityId.value) return
  const data = await store.getDm(identityId.value)
  if (data) {
    identity.value = data.identity
    messages.value = data.messages
    await nextTick()
    if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  } else {
    router.replace('/home')
  }
}

onMounted(load)
watch(identityId, load)

async function send() {
  const text = draft.value.trim()
  if (!text || sending.value) return
  sending.value = true
  const attachments = draftPaths.value.map(p => p.path)
  draft.value = ''
  draftPaths.value = []
  // 乐观更新
  messages.value.push({
    id: `local_${Date.now()}`, from: 'user', content: text, kind: 'text', ts: Date.now() / 1000, attachments,
  })
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
  const result = await store.sendDm(identityId.value, text, attachments)
  if (result) {
    // 替换乐观消息 + 追加回复
    messages.value = messages.value.filter(m => !m.id.startsWith('local_'))
    messages.value.push(result.userMessage, result.reply)
  }
  sending.value = false
  await nextTick()
  if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight
}

async function deleteRole() {
  const pid = store.activeProject?.id
  if (!pid || !identity.value) return
  if (!confirm(`删除角色「${identity.value.name}」？将从本项目所有群聊中移除，并删除记忆与单聊，不可恢复。`)) return
  const ok = await store.deleteIdentity(pid, identity.value.id)
  if (ok) {
    router.replace('/home')
  } else {
    alert(store.error || '删除失败')
  }
}

function fmtClock(ts: number) {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

function pathName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
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
  }
}

function pickFiles() {
  const bridge = (window as any).CoomiAndroid
  if (bridge?.hasStoragePermission && !bridge.hasStoragePermission()) {
    bridge.openStorageSettings?.()
    return
  }
  bridge?.importFiles?.()
}

function authorizeFolder() {
  const bridge = (window as any).CoomiAndroid
  if (bridge?.hasStoragePermission && !bridge.hasStoragePermission()) {
    bridge.openStorageSettings?.()
    return
  }
  bridge?.authorizeFolder?.()
}

onMounted(() => {
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:folder-selected', onFolderSelected)
})
</script>

<template>
  <main class="page">
    <header class="top">
      <button class="icon" @click="router.replace('/home')">←</button>
      <span class="avatar" :style="{ background: identity?.color || '#888' }">
        {{ identity?.name?.charAt(0) || '?' }}
      </span>
      <div class="title">
        <h1>{{ identity?.name || '单聊' }}</h1>
        <p v-if="identity">羁绊 {{ Math.round(identity.bond * 100) }}%</p>
      </div>
      <button class="del" @click="deleteRole">删除角色</button>
    </header>

    <section ref="scroller" class="feed">
      <div v-if="!messages.length" class="empty-sm">还没有消息</div>
      <article
        v-for="m in messages"
        :key="m.id"
        class="row"
        :class="isMe(m.from) ? 'me' : 'them'"
      >
        <span v-if="!isMe(m.from)" class="av" :style="{ background: identity?.color || '#888' }">
          {{ identity?.name?.charAt(0) || '?' }}
        </span>
        <div class="col">
          <time>{{ fmtClock(m.ts) }}</time>
          <div class="bubble">{{ m.content }}</div>
          <div v-if="m.attachments?.length" class="files">
            📎 {{ m.attachments.map(pathName).join(', ') }}
          </div>
        </div>
      </article>
    </section>

    <footer class="composer">
      <div class="tools">
        <button class="tool" aria-label="选择文件" @click="pickFiles">
          <CoomiIcon name="fileRead" :size="16" />
        </button>
        <button class="tool" aria-label="授权目录" @click="authorizeFolder">
          <CoomiIcon name="folder" :size="16" />
        </button>
      </div>
      <div v-if="draftPaths.length" class="chips">
        <span v-for="p in draftPaths" :key="p.id" class="chip">
          {{ pathName(p.path) }}
          <button @click="draftPaths = draftPaths.filter(x => x.id !== p.id)">×</button>
        </span>
      </div>
      <div class="input-row">
        <textarea v-model="draft" rows="1" placeholder="输入消息…" @keydown.enter.exact.prevent="send" />
        <button class="send" :disabled="!draft.trim() || sending" @click="send">↑</button>
      </div>
    </footer>
  </main>
</template>

<style scoped>
.page {
  display: flex; flex-direction: column; height: 100%;
  background: var(--page); overflow: hidden;
}
.top {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) 10px;
  padding-top: calc(var(--sp-2) + env(safe-area-inset-top, 0px));
  background: var(--bg); border-bottom: 1px solid var(--border);
}
.icon {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); cursor: pointer;
}
.avatar {
  width: 32px; height: 32px; border-radius: var(--r-md);
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: var(--fs-body);
}
.title { flex: 1; min-width: 0; }
.title h1 { margin: 0; font-size: var(--fs-body-lg); }
.title p { margin: 1px 0 0; font-size: var(--fs-caption); color: var(--text-3); }
.del {
  border: 0; background: transparent; color: var(--danger);
  font-size: var(--fs-label); cursor: pointer; padding: var(--sp-1) var(--sp-2);
}
.feed {
  flex: 1; overflow-y: auto; padding: 10px var(--sp-3);
  display: flex; flex-direction: column;
}

.row { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-2); max-width: 85%; }
.row.me { align-self: flex-end; flex-direction: row-reverse; }
.row.them { align-self: flex-start; }
.av {
  width: 32px; height: 32px; border-radius: var(--r-md); flex-shrink: 0;
  display: grid; place-items: center; color: #fff; font-weight: 700; font-size: var(--fs-sub);
}
.col { min-width: 0; }
.col time { font-size: var(--fs-caption); color: var(--text-3); display: block; margin-bottom: 2px; }
.bubble {
  padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); font-size: var(--fs-body); line-height: 1.5;
  word-break: break-word;
}
.row.me .bubble { background: var(--blue, #2d61c6); color: #fff; border-bottom-right-radius: 4px; }
.row.them .bubble { background: var(--bg); border: 1px solid var(--border); border-bottom-left-radius: 4px; }
.files { font-size: var(--fs-caption); color: var(--text-3); margin-top: var(--sp-1); }
.composer {
  padding: var(--sp-2) var(--sp-3);
  padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom, 0px));
  background: var(--bg); border-top: 1px solid var(--border);
  display: flex; flex-direction: column; gap: 6px;
}
.tools { display: flex; align-items: center; gap: 6px; }
.tool {
  width: 32px; height: 32px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-sm); background: var(--fill); color: var(--text-2);
  cursor: pointer; transition: transform var(--dur-press) var(--ease-out);
}
.tool:active { transform: scale(var(--press-scale)); }
.chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.chip {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 2px var(--sp-2); border-radius: var(--r-pill);
  background: var(--blue-soft, #e8f0fe); color: var(--blue, #2d61c6);
  font-size: var(--fs-caption);
}
.chip button { border: 0; background: transparent; cursor: pointer; font-size: var(--fs-body); }
.input-row { display: grid; grid-template-columns: 1fr auto; gap: var(--sp-2); align-items: end; }
.input-row textarea {
  resize: none; border: 1px solid var(--border); border-radius: var(--r-md);
  padding: 10px var(--sp-3); font-size: var(--fs-body); background: var(--bg); color: var(--text);
  min-height: 40px; max-height: 120px; outline: none; box-sizing: border-box;
}
.send {
  width: 40px; height: 40px; border: 0; border-radius: var(--r-md);
  background: var(--blue, #2d61c6); color: #fff;
  font-size: var(--fs-heading); font-weight: 700; cursor: pointer;
}
.send:disabled { opacity: 0.5; }
</style>
