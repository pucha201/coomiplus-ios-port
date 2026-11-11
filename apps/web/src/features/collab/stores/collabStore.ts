import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import { collabApi } from '../api/collabApi'
import type { CollabTask, CreateCollabTaskInput } from '../types/collab'

export const useCollabStore = defineStore('collab-v3', () => {
  const tasks = ref<CollabTask[]>([])
  const current = ref<CollabTask | null>(null)
  const loading = ref(false)
  const actionPending = ref(false)
  const error = ref('')
  /** 当前任务已消费到的事件序号（断线后 since_seq 增量补发） */
  const eventsSeq = ref(0)
  const runningTasks = computed(() => tasks.value.filter(task => ['starting', 'running', 'waiting'].includes(task.status)))

  const onEngineEvent = (event: Event) => {
    const detail = (event as CustomEvent<{ task_id?: string }>).detail
    if (detail?.task_id && detail.task_id === current.value?.id) void loadTask(detail.task_id, true)
    else if (detail?.task_id) void loadTasks()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('coomi:collab-event', onEngineEvent)
    onScopeDispose(() => window.removeEventListener('coomi:collab-event', onEngineEvent))
  }

  function upsert(task: CollabTask) {
    const index = tasks.value.findIndex(item => item.id === task.id)
    if (index < 0) tasks.value.unshift(task)
    else tasks.value[index] = task
    tasks.value.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    if (current.value?.id === task.id) current.value = task
  }

  async function loadTasks() {
    loading.value = true; error.value = ''
    try { tasks.value = (await collabApi.list()).tasks ?? [] }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause) }
    finally { loading.value = false }
  }

  async function loadTask(id: string, quiet = false) {
    if (!quiet) loading.value = true
    error.value = ''
    try {
      // quiet 轮询走 lite（无 events/output）；首次/手动打开走全文。
      const task = quiet
        ? await collabApi.getLite(id)
        : await collabApi.get(id)
      // lite 没有 messages/events 时，保留已加载的全文字段
      if (quiet && current.value?.id === id) {
        const prev = current.value
        current.value = {
          ...task,
          messages: task.messages.length ? task.messages : prev.messages,
          events: task.events.length ? task.events : prev.events,
          artifacts: task.artifacts.length ? task.artifacts : prev.artifacts,
        }
        upsert(current.value)
      } else {
        current.value = task
        upsert(task)
        eventsSeq.value = task.events.length
      }
      return current.value
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return null }
    finally { if (!quiet) loading.value = false }
  }

  /** 断线重连：从 eventsSeq 起增量拉事件并合并进当前任务。 */
  async function syncEvents(id: string) {
    if (current.value?.id !== id) return
    try {
      const { events, nextSeq } = await collabApi.events(id, eventsSeq.value)
      if (events.length) {
        // 增量事件仅用于触发感知；权威状态仍靠 loadTask 全量拉取。
        eventsSeq.value = nextSeq
        void loadTask(id, true)
      } else {
        eventsSeq.value = nextSeq
      }
    } catch { /* 增量失败不阻塞轮询 */ }
  }

  async function createTask(input: CreateCollabTaskInput) {
    actionPending.value = true; error.value = ''
    try { const task = await collabApi.create(input); upsert(task); current.value = task; return task }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return null }
    finally { actionPending.value = false }
  }

  async function startTask(id: string) {
    actionPending.value = true; error.value = ''
    try { const task = await collabApi.start(id); upsert(task); if (current.value?.id === id) current.value = task; return task }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return null }
    finally { actionPending.value = false }
  }

  async function runAction(id: string, action: 'cancel' | 'retry' | 'interrupt') {
    actionPending.value = true; error.value = ''
    try {
      if (action === 'interrupt') {
        await collabApi.interrupt(id)
        await loadTask(id, true)
        return current.value
      }
      const task = action === 'cancel' ? await collabApi.cancel(id) : await collabApi.retry(id)
      upsert(task); return task
    }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return null }
    finally { actionPending.value = false }
  }

  async function removeTask(id: string) {
    actionPending.value = true
    try { await collabApi.remove(id); tasks.value = tasks.value.filter(task => task.id !== id); if (current.value?.id === id) current.value = null; return true }
    catch (cause) { error.value = cause instanceof Error ? cause.message : String(cause); return false }
    finally { actionPending.value = false }
  }

  async function sendInstruction(content: string, to = 'all') {
    if (!current.value) return false
    try {
      await collabApi.sendMessage(current.value.id, content, to)
      await loadTask(current.value.id, true)
      return true
    }
    catch (cause) {
      error.value = cause instanceof Error ? cause.message : String(cause)
      return false
    }
  }

  return { tasks, current, loading, actionPending, error, runningTasks, eventsSeq, loadTasks, loadTask, syncEvents, createTask, startTask, runAction, removeTask, sendInstruction }
})
