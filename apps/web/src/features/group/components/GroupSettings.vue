<script setup lang="ts">
/** 群设置底部抽屉：设置项分组，拇指区可达。 */
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { Room, RoomEffort, SpeakMode } from '../types'

defineProps<{
  room: Room | null
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  setMode: [mode: SpeakMode]
  setEffort: [effort: RoomEffort]
  toggleMute: [muted: boolean]
  toggleIdleChat: [enabled: boolean]
  openTopic: []
  openRename: []
  openWorkDir: []
  clearPaths: []
  resetQuotas: []
  clearHistory: []
  cancelRound: []
  editMembers: []
  deleteRoom: []
}>()

function modeLabel(m: SpeakMode) {
  if (m === 'open') return '抢麦'
  if (m === 'host') return '主持'
  return '轮流'
}

function effortLabel(e: RoomEffort) {
  if (e === 'ultra' || e === 'xhigh') return '⚡ Ultra'
  if (e === 'auto') return '自动'
  if (e === 'low') return '低'
  if (e === 'medium') return '中'
  return '高'
}

const modes: SpeakMode[] = ['round_robin', 'open', 'host']
const efforts: RoomEffort[] = ['auto', 'low', 'medium', 'high', 'ultra']
const isActive = (current: RoomEffort | undefined, e: RoomEffort) =>
  current === e || (e === 'ultra' && current === 'xhigh')
</script>

<template>
  <template v-if="room">
    <div class="mask" :class="{ on: open }" @click="emit('close')" />
    <aside class="sheet" :class="{ on: open }" aria-label="群设置">
      <div class="handle-wrap" @click="emit('close')"><span class="handle" /></div>
      <header class="sheet-head">
        <div class="room-chip">
          <span class="stack">
            <i
              v-for="(c, i) in room.members.slice(0, 3).map(m => m.color)"
              :key="i"
              :style="{ background: c }"
            />
          </span>
          <div class="room-meta">
            <h2>{{ room.name }}</h2>
            <p>{{ room.topic || `${room.members.length} 位成员` }}</p>
          </div>
        </div>
        <button class="close-btn" aria-label="关闭" @click="emit('close')">
          <CoomiIcon name="close" :size="16" />
        </button>
      </header>

      <div class="sheet-body">
        <p class="sec">发言模式</p>
        <div class="seg">
          <button
            v-for="m in modes"
            :key="m"
            :class="{ on: room.speakMode === m }"
            @click="emit('setMode', m)"
          >{{ modeLabel(m) }}</button>
        </div>

        <p class="sec">推理强度</p>
        <div class="seg">
          <button
            v-for="e in efforts"
            :key="e"
            :class="{ on: isActive(room.reasoningEffort, e), ultra: e === 'ultra' }"
            @click="emit('setEffort', e)"
          >{{ effortLabel(e) }}</button>
        </div>
        <p v-if="isActive(room.reasoningEffort, 'ultra')" class="sec-hint">Ultra：更长思考，耗时与 token 更高</p>

        <p class="sec">开关</p>
        <div class="switch-list">
          <label class="switch-row">
            <span>消息免打扰</span>
            <button
              type="button"
              role="switch"
              :aria-checked="!!room.muted"
              :class="{ on: room.muted }"
              @click="emit('toggleMute', !room.muted)"
            ><i /></button>
          </label>
          <label class="switch-row">
            <span>闲聊模式</span>
            <button
              type="button"
              role="switch"
              :aria-checked="!!room.idleChatEnabled"
              :class="{ on: room.idleChatEnabled }"
              @click="emit('toggleIdleChat', !room.idleChatEnabled)"
            ><i /></button>
          </label>
        </div>

        <p class="sec">管理</p>
        <div class="action-list">
          <button class="action" @click="emit('editMembers')">
            <span class="ai"><CoomiIcon name="people" :size="15" /></span>
            <span class="lbl">编辑成员</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="action" @click="emit('openTopic')">
            <span class="ai"><CoomiIcon name="pencil" :size="15" /></span>
            <span class="lbl">修改话题</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="action" @click="emit('openRename')">
            <span class="ai"><CoomiIcon name="chat" :size="15" /></span>
            <span class="lbl">重命名</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="action" @click="emit('openWorkDir')">
            <span class="ai"><CoomiIcon name="folder" :size="15" /></span>
            <span class="lbl">打开工作目录</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button v-if="room.contextPaths?.length" class="action" @click="emit('clearPaths')">
            <span class="ai"><CoomiIcon name="trash" :size="15" /></span>
            <span class="lbl">清除授权路径</span>
          </button>
          <button class="action" @click="emit('resetQuotas')">
            <span class="ai"><CoomiIcon name="refresh" :size="15" /></span>
            <span class="lbl">重置发言配额</span>
          </button>
          <button v-if="room.status === 'running'" class="action warn" @click="emit('cancelRound')">
            <span class="ai"><CoomiIcon name="stop" :size="15" /></span>
            <span class="lbl">停止本轮</span>
          </button>
          <button class="action danger" @click="emit('clearHistory')">
            <span class="ai"><CoomiIcon name="trash" :size="15" /></span>
            <span class="lbl">清空聊天记录</span>
          </button>
          <button class="action danger" @click="emit('deleteRoom')">
            <span class="ai"><CoomiIcon name="close" :size="15" /></span>
            <span class="lbl">删除群聊</span>
          </button>
        </div>
      </div>
    </aside>
  </template>
</template>

<style scoped>
.mask {
  position: absolute; inset: 0; z-index: var(--z-header);
  background: rgba(10, 15, 24, 0.42);
  opacity: 0; pointer-events: none;
  transition: opacity var(--dur-base) var(--ease-out);
}
.mask.on { opacity: 1; pointer-events: auto; }

.sheet {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: var(--z-sheet);
  max-height: min(82vh, 640px);
  display: flex; flex-direction: column;
  background: var(--bg);
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  box-shadow: var(--shadow-sheet);
  transform: translate3d(0, 105%, 0);
  transition: transform var(--dur-base) var(--ease-out);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.sheet.on { transform: translate3d(0, 0, 0); }

.handle-wrap {
  display: grid; place-items: center;
  padding: var(--sp-2) 0 var(--sp-1); cursor: pointer;
}
.handle {
  width: 36px; height: 4px; border-radius: var(--r-pill);
  background: var(--border-strong);
}

.sheet-head {
  display: flex; align-items: center; gap: 10px;
  padding: 6px var(--sp-4) var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.room-chip { flex: 1; min-width: 0; display: flex; align-items: center; gap: 10px; }
.stack { display: flex; flex-shrink: 0; }
.stack i {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  border: 2px solid var(--bg); margin-left: calc(-1 * var(--sp-2));
}
.stack i:first-child { margin-left: 0; }
.room-meta { min-width: 0; }
.room-meta h2 {
  margin: 0; font-size: var(--fs-body-lg); font-weight: 700; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.room-meta p {
  margin: 1px 0 0; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.close-btn {
  width: 32px; height: 32px; display: grid; place-items: center;
  border: 0; border-radius: var(--r-md);
  background: var(--fill); color: var(--text-2);
  cursor: pointer; flex-shrink: 0;
}

.sheet-body {
  flex: 1; overflow-y: auto;
  padding: var(--sp-3) var(--sp-4) var(--sp-5);
  -webkit-overflow-scrolling: touch;
}

.sec {
  margin: 14px 0 var(--sp-2);
  font-size: var(--fs-caption); font-weight: 700; letter-spacing: 0.04em;
  color: var(--text-3); text-transform: none;
}
.sec:first-child { margin-top: var(--sp-1); }

.seg {
  display: grid; grid-auto-flow: column; grid-auto-columns: 1fr;
  gap: var(--sp-1); padding: 3px;
  background: var(--fill); border-radius: var(--r-md);
}
.seg button {
  border: 0; border-radius: var(--r-sm); padding: var(--sp-2) var(--sp-1);
  background: transparent; color: var(--text-2);
  font-size: var(--fs-label); font-weight: 600; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.seg button.on {
  background: var(--bg); color: var(--blue);
  box-shadow: var(--shadow-1);
}
.seg button.ultra { font-size: var(--fs-caption); letter-spacing: -0.02em; }
.seg button.ultra.on {
  background: linear-gradient(135deg, var(--blue), #6b8ef0);
  color: #fff;
}
.sec-hint {
  margin: 6px 0 0;
  font-size: var(--fs-caption); color: var(--text-3); line-height: 1.4;
}

.switch-list {
  border-radius: var(--r-card); background: var(--fill);
  overflow: hidden;
}
.switch-row {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-3); padding: var(--sp-3) 14px;
  font-size: var(--fs-sub); color: var(--text); cursor: pointer;
}
.switch-row + .switch-row { border-top: 1px solid var(--border); }
.switch-row button {
  width: 44px; height: 26px; border: 0; border-radius: var(--r-pill);
  background: var(--border-strong); position: relative;
  cursor: pointer; transition: background var(--dur-base) var(--ease-out); flex-shrink: 0;
  padding: 0;
}
.switch-row button.on { background: var(--blue); }
.switch-row button i {
  position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.15);
  transition: transform var(--dur-base) var(--ease-out);
}
.switch-row button.on i { transform: translateX(18px); }

.action-list {
  display: flex; flex-direction: column; gap: 2px;
  border-radius: var(--r-card); background: var(--fill);
  overflow: hidden;
}
.action {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: var(--sp-3) 14px;
  border: 0; background: transparent;
  font-size: var(--fs-sub); color: var(--text); text-align: left;
  cursor: pointer; transition: background var(--dur-fast) var(--ease-out);
}
.action:active { background: var(--fill-press); }
.action + .action { border-top: 1px solid var(--border); }
.action .ai {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  display: grid; place-items: center;
  background: var(--blue-soft); color: var(--blue); flex-shrink: 0;
}
.action .lbl { flex: 1; min-width: 0; }
.action .chev { color: var(--text-3); flex-shrink: 0; }
.action.danger { color: var(--danger); }
.action.danger .ai { background: var(--danger-soft); color: var(--danger); }
.action.warn { color: var(--warn); }
.action.warn .ai { background: var(--warn-soft); color: var(--warn); }

/* 减弱动态效果：抽屉/遮罩状态翻转直接出现（取消过渡，切换仍瞬时生效） */
@media (prefers-reduced-motion: reduce) {
  .sheet, .mask { transition: none !important; }
}
</style>
