<script setup lang="ts">
/** 项目列表弹层：切换 / 新建 / 删除。 */
import type { ProjectSummary } from '../types'

defineProps<{
  projects: ProjectSummary[]
  activeId?: string
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  pick: [id: string]
  create: []
  remove: [id: string, name: string]
}>()
</script>

<template>
  <div v-if="open" class="mask enter-flat" @click.self="emit('close')">
    <div class="modal">
      <h3>项目列表</h3>
      <p>选择要进入的项目，或创建新项目。</p>
      <div class="rows">
        <div
          v-for="p in projects"
          :key="p.id"
          class="row enter-item"
          :class="{ on: p.id === activeId }"
          role="button"
          tabindex="0"
          @click="emit('pick', p.id)"
          @keydown.enter="emit('pick', p.id)"
        >
          <span class="icon">📁</span>
          <span class="meta">
            <strong>{{ p.name }}</strong>
            <small>{{ p.roomCount }} 群 · {{ p.identityCount }} 成员</small>
          </span>
          <span v-if="p.id === activeId" class="tag">当前</span>
          <button class="del" type="button" @click.stop="emit('remove', p.id, p.name)">删除</button>
        </div>
      </div>
      <div class="actions">
        <button class="btn ghost" @click="emit('close')">关闭</button>
        <button class="btn primary" @click="emit('create')">新建项目</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: var(--z-toast);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: min(360px, 92vw); max-height: 80vh;
  background: var(--bg); border-radius: var(--r-card); padding: var(--sp-4);
  display: flex; flex-direction: column;
  /* 居中弹层入场：modalIn（已收敛 global.css，语义 = enter-pop），遮罩淡入由 .enter-flat 类负责 */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.modal h3 { margin: 0 0 var(--sp-1); font-size: var(--fs-strong); }
.modal > p { margin: 0 0 10px; font-size: var(--fs-label); color: var(--text-3); }
.rows { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 6px; }
.row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); cursor: pointer;
  border: 1px solid transparent;
}
.row.on { border-color: var(--blue, #2d61c6); background: var(--blue-soft, #e8f0fe); }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.meta strong { font-size: var(--fs-sub); }
.meta small { font-size: var(--fs-caption); color: var(--text-3); }
.tag { font-size: var(--fs-caption); color: var(--blue, #2d61c6); font-weight: 600; }
.del {
  border: 0; background: transparent; color: var(--danger);
  font-size: var(--fs-label); font-weight: 600; padding: var(--sp-1) 6px; cursor: pointer;
}
.actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.btn {
  flex: 1; padding: 10px; border: 0; border-radius: var(--r-md);
  font-size: var(--fs-sub); cursor: pointer;
}
.btn.ghost { background: var(--fill); }
.btn.primary { background: var(--blue, #2d61c6); color: #fff; }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .modal { animation: none; }
}
:root[data-motion='off'] .modal { animation: none; }
</style>
