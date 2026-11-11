<script setup lang="ts">
/** 成员详情侧栏：活动 + 最近消息 + 共享记忆 + 绑定/移除。 */
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { MemberActivity, RoomMember } from '../types'

defineProps<{
  member: RoomMember | null
  activities: MemberActivity[]
  recentMessages: Array<{ from: string; content: string }>
  memory: { items: unknown[]; total: number } | null
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  bind: []
  remove: []
  openWorkDir: []
}>()

function memoryText(item: unknown): string {
  if (item == null) return ''
  if (typeof item === 'string') return item.slice(0, 120)
  const o = item as Record<string, unknown>
  const t = o.text ?? o.content ?? o.summary ?? o.title ?? o.detail
  return typeof t === 'string' ? t.slice(0, 120) : JSON.stringify(item).slice(0, 120)
}
</script>

<template>
  <template v-if="member">
    <div class="mask" :class="{ on: open }" @click="emit('close')" />
    <aside class="side left" :class="{ on: open }" aria-label="成员活动">
      <header class="side-head">
        <span class="avatar md" :style="{ background: member.color }">
          <CoomiIcon :name="member.icon || 'chat'" :size="16" />
        </span>
        <div class="md-title">
          <h2>{{ member.name }}</h2>
          <p v-if="member.modelSelector">{{ member.modelSelector }}</p>
        </div>
        <button class="icon" @click="emit('close')"><CoomiIcon name="close" :size="16" /></button>
      </header>
      <div class="side-body">
        <p class="sec">思考 / 发言 / 交流</p>
        <div v-if="!activities.length" class="empty-sm">暂无活动记录</div>
        <div v-for="a in activities" :key="a.id" class="act">
          <span class="act-kind" :class="a.kind">{{ a.kind === 'directed' ? '定向' : '发言' }}</span>
          <div>
            <p>{{ a.detail }}</p>
          </div>
        </div>

        <p class="sec">相关消息</p>
        <div v-if="!recentMessages.length" class="empty-sm">暂无消息</div>
        <div v-for="(m, i) in recentMessages" :key="i" class="mini-msg">
          <strong>{{ m.from === 'user' ? '我' : m.from }}</strong>
          <span>{{ m.content.slice(0, 80) }}</span>
        </div>

        <p class="sec">共享记忆</p>
        <div v-if="!memory?.items?.length" class="empty-sm">暂无共享记忆</div>
        <div v-for="(it, i) in (memory?.items || []).slice(-8)" :key="i" class="mini-msg">
          <span>{{ memoryText(it) }}</span>
        </div>

        <button class="side-btn" @click="emit('openWorkDir')">
          <CoomiIcon name="folder" :size="14" /> 打开工作目录
        </button>
        <button class="side-btn" @click="emit('bind')">
          <CoomiIcon name="sparkle" :size="14" /> 绑定数字生命体
        </button>
        <button class="side-btn danger" @click="emit('remove')">
          <CoomiIcon name="trash" :size="14" /> 从本群移除
        </button>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.mask {
  position: absolute; inset: 0; z-index: var(--z-header);
  background: rgba(10,15,24,.42); opacity: 0; pointer-events: none;
  transition: opacity var(--dur-base) var(--ease-out);
}
.mask.on { opacity: 1; pointer-events: auto; }

.side {
  position: absolute; top: 0; bottom: 0; z-index: var(--z-sheet);
  width: min(90vw, 320px); background: var(--bg);
  display: flex; flex-direction: column;
  transition: transform var(--dur-base) var(--ease-out);
  box-shadow: 0 0 0 1px var(--border);
}
.side.left { left: 0; right: auto; transform: translate3d(-105%, 0, 0); }
.side.on { transform: translate3d(0, 0, 0); }

.side-head {
  display: flex; align-items: center; gap: 10px;
  padding: var(--sp-3) 14px; border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.avatar {
  display: grid; place-items: center; border-radius: var(--r-md); color: #fff; flex-shrink: 0;
}
.avatar.md { width: 40px; height: 40px; border-radius: var(--r-md); }
.md-title { flex: 1; min-width: 0; }
.md-title h2 { margin: 0; font-size: var(--fs-body-lg); font-weight: 700; }
.md-title p {
  margin: 2px 0 0; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.icon {
  width: 32px; height: 32px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-sm); background: var(--fill); color: var(--text-2);
  cursor: pointer; flex-shrink: 0;
}
.side-body { flex: 1; overflow-y: auto; padding: 14px; }

.sec {
  font-size: var(--fs-label); font-weight: 700; color: var(--text-2);
  margin: var(--sp-3) 0 6px;
}
.sec:first-child { margin-top: 0; }
/* 侧边详情面板里的空态更紧凑，只改留白，字号/颜色沿用 global.css。 */
.empty-sm { padding: var(--sp-2) 0; }

.act {
  display: flex; gap: var(--sp-2); margin-bottom: var(--sp-2); font-size: var(--fs-label);
  animation: coomi-enter-item var(--enter-item-dur) var(--ease-out) backwards; /* 4px 版 msgIn 与 coomi-enter-item 位移逐字一致，复用 token */
}
.act-kind {
  flex-shrink: 0; padding: 2px 6px; border-radius: var(--r-sm);
  background: var(--fill); font-size: var(--fs-caption); color: var(--text-2);
}
.act-kind.directed { background: var(--blue-soft); color: var(--blue); }

.mini-msg {
  display: flex; gap: 6px; font-size: var(--fs-label); margin-bottom: var(--sp-1);
  padding: 6px var(--sp-2); border-radius: var(--r-sm); background: var(--fill);
}
.mini-msg strong { flex-shrink: 0; color: var(--text-2); }
.mini-msg span { flex: 1; min-width: 0; color: var(--text-3); }

.side-btn {
  display: flex; align-items: center; gap: var(--sp-2);
  width: 100%; margin-top: 10px; padding: 10px var(--sp-3);
  border: 0; border-radius: var(--r-md); background: var(--fill);
  font-size: var(--fs-sub); cursor: pointer; text-align: left;
  color: var(--text); transition: background var(--dur-fast) var(--ease-out);
}
.side-btn:active { background: var(--fill-strong, #e8eaed); }
.side-btn.danger { color: var(--danger); }

/* 减弱动态效果：侧栏/遮罩状态翻转直接出现（取消过渡，切换仍瞬时生效） */
@media (prefers-reduced-motion: reduce) {
  .side, .mask { transition: none !important; }
}
</style>
