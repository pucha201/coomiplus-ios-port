<script setup lang="ts">
/** 输入区：引用 banner + 工具栏 + 路径 chips + 输入框 + 发送。 */
import { computed, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import type { RoomMember, RoomMessage } from '../types'

const props = defineProps<{
  members: RoomMember[]
  running?: boolean
  sending?: boolean
  reply?: RoomMessage | null
  draftPaths?: Array<{ id: string; path: string; isDir: boolean }>
}>()

const emit = defineEmits<{
  send: [content: string, to: string, paths: string[], replyTo?: string]
  cancelReply: []
  pickFiles: []
  authorizeFolder: []
  removeDraftPath: [id: string]
  openWorkDir: []
}>()

const draft = ref('')
const target = ref('all')

const targetOptions = computed(() => [
  { value: 'all', label: '@全体' },
  ...props.members.map(m => ({ value: m.id, label: `@${m.name}` })),
])

function doSend() {
  const text = draft.value.trim()
  if (!text || props.sending) return
  const paths = (props.draftPaths || []).map(p => p.path)
  emit('send', text, target.value, paths, props.reply?.id)
  draft.value = ''
}

function pathName(p: string) {
  return p.split(/[\\/]/).filter(Boolean).pop() || p
}
</script>

<template>
  <footer class="composer">
    <div v-if="reply" class="reply-banner">
      <span>引用 {{ reply.from === 'user' ? '我' : reply.from }}: {{ reply.content.slice(0, 36) }}</span>
      <button aria-label="取消引用" @click="emit('cancelReply')">
        <CoomiIcon name="close" :size="14" />
      </button>
    </div>
    <div class="tools">
      <button class="tool" aria-label="选择文件" @click="emit('pickFiles')">
        <CoomiIcon name="fileRead" :size="17" />
      </button>
      <button class="tool" aria-label="授权目录" @click="emit('authorizeFolder')">
        <CoomiIcon name="folder" :size="17" />
      </button>
      <button class="tool" aria-label="工作目录" title="打开工作目录" @click="emit('openWorkDir')">
        <CoomiIcon name="external" :size="17" />
      </button>
      <UiSelect
        v-model="target"
        :options="targetOptions"
        size="sm"
        class="target-select"
        aria-label="发送对象"
      />
    </div>
    <div v-if="draftPaths?.length" class="path-chips">
      <span v-for="p in draftPaths" :key="p.id" class="chip">
        <CoomiIcon :name="p.isDir ? 'folder' : 'fileRead'" :size="12" />
        {{ pathName(p.path) }}
        <button aria-label="移除" @click="emit('removeDraftPath', p.id)">×</button>
      </span>
    </div>
    <div class="input-row">
      <textarea
        v-model="draft"
        rows="1"
        :placeholder="running ? '运行中，可继续 @成员…' : '输入消息…'"
        @keydown.enter.exact.prevent="doSend"
      />
      <button class="send" :disabled="!draft.trim() || sending" @click="doSend">
        <CoomiIcon name="arrowUp" :size="17" />
      </button>
    </div>
  </footer>
</template>

<style scoped>
.composer {
  flex-shrink: 0;
  display: flex; flex-direction: column; gap: 6px;
  padding: var(--sp-2) 10px calc(var(--sp-2) + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid var(--border); background: var(--bg);
  z-index: 5;
  animation: slideUp var(--enter-block-dur) var(--ease-out) backwards; /* slideUp 已收敛到 global.css（100% 上滑，语义 = enter-block） */
}
.reply-banner {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 6px 10px; border-radius: var(--r-md);
  background: var(--blue-soft); color: var(--blue); font-size: var(--fs-label);
  animation: coomi-enter-item var(--enter-item-dur) var(--ease-out) backwards; /* 4px 版 msgIn 与 coomi-enter-item 位移逐字一致，复用 token */
}
.reply-banner span { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.reply-banner button {
  border: 0; background: transparent; color: inherit; font-size: var(--fs-strong);
  display: grid; place-items: center; cursor: pointer;
}
.tools { display: flex; align-items: center; gap: 6px; }
.tool {
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out), color var(--dur-fast) var(--ease-out); cursor: pointer;
}
.tool:active { transform: scale(var(--press-scale)); background: var(--fill-strong); color: var(--blue); }
.target-select { margin-left: auto; max-width: 110px; }
.path-chips {
  display: flex; flex-wrap: nowrap; gap: 6px;
  overflow-x: auto; -webkit-overflow-scrolling: touch;
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
  border: 0; background: transparent; color: inherit; font-size: var(--fs-body);
  line-height: 1; padding: 0; cursor: pointer;
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
  cursor: pointer; transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.send:active { transform: scale(var(--press-scale)); }
.send:disabled { opacity: .35; cursor: not-allowed; }

/* 减弱动态效果：底部面板/引用条入场直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .composer, .reply-banner { animation: none; }
}
:root[data-motion='off'] .composer, :root[data-motion='off'] .reply-banner { animation: none; }
</style>
