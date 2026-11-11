<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore, type TaskDetail, type TaskInfo } from '@/stores/sessions'

const priorityOptions = [
  { value: 'high', label: '高' },
  { value: 'normal', label: '普通' },
  { value: 'low', label: '低' },
]

const router = useRouter()
const session = useSessionStore()
const sessions = useSessionsStore()
const detail = ref<TaskDetail | null>(null)
let poll: ReturnType<typeof setInterval> | null = null

const active = computed(() => sessions.tasks.filter(task => task.running))
const recent = computed(() => sessions.tasks.filter(task => !task.running).slice(0, 20))

const statusLabels: Record<TaskInfo['status'], string> = {
  queued: '等待执行', waiting_lock: '等待资源', running: '执行中', pause_pending: '等待安全点暂停', paused: '已暂停', awaiting_approval: '等待授权', awaiting_input: '等待输入', completed: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断', conflict: '发生冲突',
}

const downloadLabels: Record<NonNullable<TaskInfo['download_status']>, string> = {
  downloading: '下载中', completed: '下载完成，等待使用', failed: '下载失败',
}

function openTask(task: TaskInfo) {
  session.openSession(task.session_id)
  router.push('/')
}

async function inspectTask(task: TaskInfo) {
  detail.value = await sessions.taskDetail(task.task_id)
}

async function act(task: TaskInfo, action: 'pause' | 'resume' | 'cancel' | 'retry') {
  await sessions.taskAction(task.task_id, action)
  detail.value = await sessions.taskDetail(task.task_id)
}

async function setPriority(task: TaskInfo, event: Event) {
  const priority = (event.target as HTMLSelectElement).value as TaskInfo['priority']
  await sessions.taskAction(task.task_id, 'priority', priority)
}

function elapsed(startedAt: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - startedAt))
  if (seconds < 60) return `${seconds} 秒`
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟`
  return `${Math.floor(seconds / 3600)} 小时`
}

onMounted(() => {
  void sessions.refreshTasks()
  poll = setInterval(() => sessions.refreshTasks(), 1500)
})
onBeforeUnmount(() => { if (poll) clearInterval(poll) })
</script>

<template>
  <div class="page">
    <PageHead title="任务中心" @back="router.push('/')" />
    <main class="body">
      <div class="summary">
        <span><strong>{{ active.length }}</strong> 个任务运行中</span>
        <span>并发上限 {{ sessions.taskConcurrencyLimit }}</span>
      </div>

      <p class="sec-label">当前任务</p>
      <div v-if="active.length" class="task-list">
        <div v-for="task in active" :key="task.task_id" :class="['task-row', 'enter-item', { download: task.task_kind === 'download' }]">
          <button class="task-main" @click="inspectTask(task)">
            <span class="task-title">{{ task.session_title }}</span>
            <span class="task-meta">
              <span class="live-dot" />{{ task.download_status ? downloadLabels[task.download_status] : statusLabels[task.status] }} · {{ elapsed(task.started_at) }}
              <template v-if="task.download_label"> · {{ task.download_label }}</template>
              <template v-else-if="task.current_tool"> · {{ task.current_tool }}</template>
            </span>
          </button>
          <button v-if="task.status === 'running'" class="control" aria-label="暂停任务" title="暂停任务" @click="act(task, 'pause')">
            <CoomiIcon name="pause" :size="17" />
          </button>
          <button v-if="task.status === 'paused' || task.status === 'pause_pending'" class="control" aria-label="恢复任务" title="恢复任务" @click="act(task, 'resume')">
            <CoomiIcon name="play" :size="17" />
          </button>
          <button class="stop" aria-label="取消任务" title="取消任务" @click="act(task, 'cancel')">
            <CoomiIcon name="stop" :size="17" />
          </button>
        </div>
      </div>
      <UiEmpty
        v-else
        icon="check"
        title="当前没有运行中的任务"
        desc="在对话里让它跑起来，任务会出现在这里。"
      />

      <template v-if="recent.length">
        <p class="sec-label">最近任务</p>
        <div class="task-list">
          <button v-for="task in recent" :key="task.task_id" class="task-row recent enter-item" @click="inspectTask(task)">
            <span class="task-main">
              <span class="task-title">{{ task.session_title }}</span>
              <span class="task-meta" :class="task.status">{{ statusLabels[task.status] }} · {{ elapsed(task.started_at) }}前开始</span>
            </span>
            <CoomiIcon name="chevronRight" :size="17" class="chevron" />
          </button>
        </div>
      </template>

      <section v-if="detail" class="detail">
        <div class="detail-head">
          <div>
            <p class="sec-label">任务详情</p>
            <strong>{{ detail.task.session_title || detail.task.kind }}</strong>
          </div>
          <button class="control" aria-label="关闭详情" title="关闭详情" @click="detail = null"><CoomiIcon name="close" :size="17" /></button>
        </div>
        <div class="detail-grid">
          <label>优先级
            <UiSelect
              :model-value="detail.task.priority"
              :options="priorityOptions"
              block
              @update:model-value="v => detail && setPriority(detail.task, { target: { value: v } } as any)"
            />
          </label>
          <span>状态<strong>{{ statusLabels[detail.task.status] }}</strong></span>
          <span>模型<strong>{{ detail.task.model || '未记录' }}</strong></span>
          <span>重试<strong>{{ detail.task.retries ?? 0 }}</strong></span>
        </div>
        <p v-if="detail.task.error" class="error">{{ detail.task.error }}</p>
        <p class="detail-label">资源</p>
        <ul class="resource-list">
          <li v-for="resource in detail.task.resources" :key="resource.key.kind + resource.key.identity">
            <code>{{ resource.key.kind }} · {{ resource.access }}</code><span>{{ resource.key.identity }}</span>
          </li>
        </ul>
        <p class="detail-label">事件日志</p>
        <ol class="event-list">
          <li v-for="event in detail.events.slice().reverse()" :key="event.at_ms + event.event">
            <time>{{ new Date(event.at_ms).toLocaleTimeString() }}</time><strong>{{ statusLabels[event.status] }}</strong><span>{{ event.summary }}</span>
          </li>
        </ol>
        <div class="detail-actions">
          <button v-if="['failed', 'cancelled', 'interrupted', 'conflict', 'completed'].includes(detail.task.status)" @click="act(detail.task, 'retry')"><CoomiIcon name="refresh" :size="16" />重试</button>
          <button @click="openTask(detail.task)"><CoomiIcon name="chat" :size="16" />打开会话</button>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 10px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6)); }
.summary { display: flex; justify-content: space-between; align-items: baseline; min-height: 40px; padding: var(--sp-2) var(--sp-1); color: var(--text-2); font-size: var(--fs-sub); }
.summary strong { color: var(--blue); font-size: var(--fs-title); }
.sec-label { margin: 14px var(--sp-1) 7px; }
.task-list { background: var(--bg); border: 1px solid var(--border); border-radius: var(--r-card); overflow: hidden; }
.task-row { display: flex; align-items: center; width: 100%; min-height: 66px; text-align: left; }
.task-row + .task-row { border-top: 1px solid var(--border); }
.task-row.download { background: var(--blue-soft); }
.task-row.download .task-title::before { content: '下载 · '; color: var(--blue); font-weight: 600; }
.task-main { display: flex; flex: 1; min-width: 0; flex-direction: column; gap: 5px; padding: 11px 6px 11px 14px; text-align: left; }
.task-title { overflow: hidden; color: var(--text); font-size: var(--fs-body); font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.task-meta { display: flex; align-items: center; min-width: 0; overflow: hidden; color: var(--text-3); font-size: var(--fs-label); text-overflow: ellipsis; white-space: nowrap; }
.live-dot { width: 7px; height: 7px; margin-right: 6px; border-radius: 50%; background: var(--blue); --pulse-min: 0.35; animation: pulse var(--dur-loop) var(--ease-in-out) infinite; }
/* pulse 已收敛到 global.css（进行中指示点），谷值经 --pulse-min: 0.35 保留。 */
.stop { display: grid; place-items: center; flex: 0 0 44px; width: 44px; height: 44px; margin-right: 6px; border-radius: 50%; color: var(--danger); }
.control { display: grid; place-items: center; flex: 0 0 40px; width: 40px; height: 40px; border-radius: 50%; color: var(--text-2); }
.stop:active { background: var(--danger-soft); }
.recent { padding: 0; }
.recent:active { background: var(--fill); }
.recent .task-main { pointer-events: none; }
.task-meta.failed { color: var(--danger); }
.task-meta.completed { color: var(--ok); }
.chevron { margin-right: var(--sp-3); color: var(--text-3); }

.detail { margin-top: 22px; padding: 14px var(--sp-1) 0; border-top: 1px solid var(--border); }
.detail-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-3); }
.detail-head .sec-label { margin: 0 0 var(--sp-1); }
.detail-head strong { font-size: var(--fs-body-lg); }
.detail-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px var(--sp-4); margin-top: var(--sp-4); }
.detail-grid > span, .detail-grid label { display: flex; min-width: 0; flex-direction: column; gap: var(--sp-1); color: var(--text-3); font-size: var(--fs-caption); }
.detail-grid strong, .detail-grid select { overflow: hidden; min-height: 30px; color: var(--text); font-size: var(--fs-sub); text-overflow: ellipsis; }
.detail-grid select { border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); }
.detail-label { margin: var(--sp-4) 0 7px; color: var(--text-3); font-size: var(--fs-caption); font-weight: 600; }
.resource-list, .event-list { display: grid; gap: var(--sp-2); margin: 0; padding: 0; list-style: none; }
.resource-list li { display: grid; gap: 3px; min-width: 0; }
.resource-list code { color: var(--blue); font-size: var(--fs-caption); }
.resource-list span { overflow-wrap: anywhere; color: var(--text-2); font-size: var(--fs-label); }
.event-list li { display: grid; grid-template-columns: 76px 74px minmax(0, 1fr); gap: 6px; color: var(--text-2); font-size: var(--fs-caption); }
.event-list time { color: var(--text-3); }
.event-list span { overflow-wrap: anywhere; }
.error { margin-top: var(--sp-3); color: var(--danger); font-size: var(--fs-label); overflow-wrap: anywhere; }
.detail-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-4); }
.detail-actions button { display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 var(--sp-3); border-radius: var(--r-sm); background: var(--fill); color: var(--text-2); font-size: var(--fs-label); }
</style>
