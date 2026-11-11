<script setup lang="ts">
import { computed, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { CollabTask } from '../types/collab'
import { taskStatusLabel } from '../utils/collabFormat'

const props = defineProps<{ task: CollabTask }>()
const emit = defineEmits<{ open: []; retry: []; remove: []; start: [] }>()
const expanded = ref(false)
const isFailed = computed(() => ['failed', 'partial', 'cancelled', 'interrupted'].includes(props.task.status))
const running = computed(() => ['starting', 'running', 'waiting'].includes(props.task.status))
const isDraft = computed(() => ['draft', 'queued'].includes(props.task.status))
const failedAgents = computed(() =>
  Object.values(props.task.agents).filter(a => a.status === 'failed' || a.error),
)
</script>

<template>
  <div class="wrap">
    <div class="row" :class="{ running, failed: isFailed }" @click="emit('open')">
      <span class="dot" :class="task.status" />
      <span class="title">{{ task.title }}</span>
      <span class="status" :class="task.status">{{ taskStatusLabel[task.status] }}</span>
      <button
        v-if="isFailed"
        class="mini"
        :aria-label="expanded ? '收起' : '展开查看错误'"
        @click.stop="expanded = !expanded"
      >
        <CoomiIcon :name="expanded ? 'chevronDown' : 'chevronRight'" :size="15" />
      </button>
      <button v-if="isFailed" class="mini retry" title="重试" @click.stop="emit('retry')">
        <CoomiIcon name="refresh" :size="15" />
      </button>
      <button v-if="isDraft" class="mini start" title="启动" @click.stop="emit('start')">
        <CoomiIcon name="play" :size="15" />
      </button>
      <button class="mini" title="删除" @click.stop="emit('remove')">
        <CoomiIcon name="trash" :size="14" />
      </button>
    </div>
    <div v-if="expanded && isFailed" class="detail">
      <p v-if="task.summary" class="summary">{{ task.summary.text }}</p>
      <div v-if="failedAgents.length" class="failures">
        <p v-for="agent in failedAgents" :key="agent.id">
          <strong>{{ task.roles.find(r => r.id === agent.roleId || r.id === agent.id)?.name || agent.id }}</strong>
          <span>{{ agent.error || agent.currentMessage || '执行失败' }}</span>
        </p>
      </div>
      <p v-if="!task.summary && !failedAgents.length" class="summary">任务异常，暂无详细错误信息。</p>
    </div>
  </div>
</template>

<style scoped>
.wrap { border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg-card); overflow: hidden; }
.row { display: flex; align-items: center; gap: var(--sp-2); padding: 11px 10px; cursor: pointer; }
.row:active { background: var(--fill); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); flex-shrink: 0; }
.dot.draft, .dot.queued { background: var(--orange); }
.dot.starting, .dot.running, .dot.waiting { background: var(--blue); }
.dot.completed { background: var(--ok); }
.dot.failed, .dot.interrupted { background: var(--danger); }
.dot.partial { background: var(--orange); }
.dot.cancelled { background: var(--text-3); }
.title { flex: 1; min-width: 0; font-size: var(--fs-sub); font-weight: 600; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.status { flex-shrink: 0; padding: 2px 7px; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); font-size: var(--fs-caption); }
.status.draft, .status.queued { background: var(--orange-soft,var(--fill)); color: var(--orange,var(--text-2)); }
.status.starting, .status.running, .status.waiting { background: var(--blue-soft); color: var(--blue); }
.status.completed { background: var(--ok-soft); color: var(--ok); }
.status.failed, .status.interrupted { background: var(--danger-soft); color: var(--danger); }
.status.partial { background: var(--orange-soft); color: var(--orange); }
.mini { display: grid; place-items: center; width: 26px; height: 26px; border: 0; border-radius: var(--r-sm); background: transparent; color: var(--text-3); flex-shrink: 0; }
.mini:active { background: var(--fill); }
.mini.retry { color: var(--blue); }
.mini.start { color: var(--ok); }
.detail { padding: 9px var(--sp-3) 11px; border-top: 1px solid var(--border); background: var(--fill); }
.summary { margin: 0; font-size: var(--fs-label); line-height: 1.5; color: var(--text-2); white-space: pre-wrap; }
.failures { display: flex; flex-direction: column; gap: 6px; margin-top: 7px; }
.failures p { margin: 0; font-size: var(--fs-caption); line-height: 1.45; color: var(--danger); display: flex; flex-direction: column; gap: 2px; }
.failures strong { font-weight: 600; }
.failures span { color: var(--text-2); }
</style>
