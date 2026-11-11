<script setup lang="ts">
/** 单条消息气泡：头像 + meta + 内容 + 引用 + 附件 + 操作。 */
import { computed } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { renderMarkdown } from '@/utils/markdown'
import type { RoomMessage, RoomMember } from '../types'

const props = defineProps<{
  msg: RoomMessage
  members: RoomMember[]
  speakingId?: string
  replyMsg?: RoomMessage | null
}>()

const emit = defineEmits<{
  avatar: [id: string]
  reply: [msg: RoomMessage]
  speak: [msg: RoomMessage]
}>()

const isMe = computed(() => props.msg.from === 'user' || props.msg.from === 'owner')
const isSystem = computed(() => props.msg.from === 'system')
const member = computed(() => props.members.find(m => m.id === props.msg.from) || null)

function md(src: string) {
  return renderMarkdown(src || '')
}

function fmtClock(ts: number) {
  const d = new Date(ts < 1e12 ? ts * 1000 : ts)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}
</script>

<template>
  <article class="row-msg" :class="isMe ? 'me' : isSystem ? 'sys' : 'them'">
    <template v-if="isSystem">
      <div class="sys-bubble">{{ msg.content }}</div>
    </template>
    <template v-else>
      <button class="avatar-btn" :aria-label="`查看 ${member?.name || msg.from}`" @click="emit('avatar', msg.from)">
        <span class="avatar" :style="{ background: isMe ? '#2d61c6' : (member?.color || '#888') }">
          <CoomiIcon :name="isMe ? 'user' : (member?.icon || 'chat')" :size="14" />
        </span>
      </button>
      <div class="col">
        <div class="meta-line">
          <span class="who">{{ isMe ? '我' : (member?.name || msg.from) }}</span>
          <time class="time">{{ fmtClock(msg.ts) }}</time>
        </div>
        <div class="bubble" @dblclick="emit('reply', msg)">
          <div v-if="replyMsg" class="quote-chip">
            <span>{{ replyMsg.from === 'user' ? '我' : replyMsg.from }}: {{ replyMsg.content.slice(0, 40) }}</span>
          </div>
          <div class="md" v-html="md(msg.content)" />
          <footer v-if="msg.attachments?.length || !isMe" class="bfoot">
            <span v-if="msg.attachments?.length" class="files">
              <CoomiIcon name="fileRead" :size="11" /> {{ msg.attachments.length }} 个附件
            </span>
            <button v-if="!isMe" class="mini" :title="speakingId === msg.id ? '停止朗读' : '朗读'" @click.stop="emit('speak', msg)">
              <CoomiIcon :name="speakingId === msg.id ? 'stop' : 'chat'" :size="11" />{{ speakingId === msg.id ? '停' : '读' }}
            </button>
            <button class="mini" title="引用" @click.stop="emit('reply', msg)">
              <CoomiIcon name="arrowLeft" :size="11" />引用
            </button>
          </footer>
        </div>
      </div>
    </template>
  </article>
</template>

<style scoped>
.row-msg {
  display: flex; gap: var(--sp-2); align-items: flex-start;
  max-width: 92%; margin-bottom: var(--sp-1);
  animation: msgIn var(--enter-append-dur) var(--ease-out) backwards; /* msgIn 已收敛到 global.css（气泡入场） */
  /* 长群聊里离屏消息跳过样式计算/布局/绘制，滚动时只渲染视口附近的行。
     不用 DynamicScroller：.row-msg 的左右对齐依赖 .feed 的 flex 列（align-self），
     套进回收容器会丢掉这个上下文，且本环境无法做视觉回归验证。
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
.row-msg .avatar-btn .avatar { margin-top: 2px; }

.col {
  display: flex; flex-direction: column; gap: 2px;
  flex: 1 1 auto; min-width: 0; max-width: min(72%, 320px);
}
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
  box-shadow: 0 2px 8px color-mix(in srgb, var(--blue) 28%, transparent);
}
.row-msg.me .bubble :deep(a) { color: #fff; }
.row-msg.them .bubble {
  background: var(--bg); border: 1px solid var(--border); border-bottom-left-radius: 4px;
  box-shadow: var(--shadow-1);
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
.md :deep(p) { margin: 0 0 var(--sp-1); }
.md :deep(p:last-child) { margin-bottom: 0; }
.md :deep(pre) {
  margin: var(--sp-1) 0 0; padding: var(--sp-2); border-radius: var(--r-sm);
  background: var(--code-bg, #1e1e2e); color: var(--code-text, #cdd6f4);
  font: 11px/1.4 var(--font-mono, monospace); overflow: auto;
}
.md :deep(code) {
  padding: 1px var(--sp-1); border-radius: var(--sp-1);
  background: var(--code-bg, #1e1e2e); font: 11px/1.4 var(--font-mono, monospace);
}
.bfoot {
  display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1);
  font-size: var(--fs-caption); opacity: 0.75;
}
.files { display: inline-flex; align-items: center; gap: 2px; }
.mini {
  border: 0; background: transparent; color: inherit; font-size: var(--fs-caption);
  display: inline-flex; align-items: center; gap: 2px; opacity: 0.85;
  padding: 0; transition: opacity var(--dur-fast) var(--ease-out); cursor: pointer;
}
.mini:active { opacity: 1; }
</style>
