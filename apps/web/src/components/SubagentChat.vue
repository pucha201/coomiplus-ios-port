<script setup lang="ts">
/**
 * 子代理会话页。
 *
 * 视觉与普通对话页一致：同一套 TimelineBlock（过程块 / 消息气泡 / 工具卡 / 思考块）
 * 渲染子代理的完整消息序列；底部输入栏只保留「模型与思考强度跟随主会话」的锁定态，
 * 其余交互（发送插话 / 关闭子代理）仍然可用。
 *
 * 数据源：
 *   GET  /api/agents                  运行状态（列表轮询）
 *   GET  /api/agents/{id}/messages    完整对话（role/content/reasoning/tools）
 *   POST /api/agents/{id}/message     给运行中的子代理发一条插话
 *   POST /api/agents/{id}/close       关闭（中止）该子代理
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { apiGet, apiSend } from '@/bridge/http'
import { useConfigStore, REASONING_EFFORTS } from '@/stores/config'
import { buildTimelineBlocks } from '@/utils/chatTimeline'
import type { Timelineitem, ToolCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'
import TimelineBlock from './TimelineBlock.vue'

interface AgentInfo { id: string; status: string; task: string; output: string; elapsed_ms: number }
interface AgentToolCall { id?: string; name?: string; arguments?: unknown }
interface AgentMessage {
  role: string
  content: string
  reasoning?: string | null
  tools?: AgentToolCall[]
}

const props = defineProps<{ agentId: string; agentName?: string | null }>()
const emit = defineEmits<{ close: []; pick: [id: string] }>()
const config = useConfigStore()

const status = ref('')
const messages = ref<AgentMessage[]>([])
const agents = ref<AgentInfo[]>([])
const loading = ref(true)
const error = ref('')
const draft = ref('')
const sending = ref(false)
const sendError = ref('')
const streamEl = ref<HTMLElement | null>(null)
let timer: number | null = null
let following = true

const running = computed(() => status.value === 'running' || status.value === 'pending')
const title = computed(() => props.agentName || agents.value.find(a => a.id === props.agentId)?.task || props.agentId)
const modelLabel = computed(() => config.currentModel || '跟随主会话')
const effortLabel = computed(() => REASONING_EFFORTS.find(item => item.value === config.reasoningEffort)?.label || '自动')
const canSend = computed(() => running.value && draft.value.trim().length > 0 && !sending.value)

function parseArgs(raw: unknown): Record<string, unknown> {
  if (typeof raw === 'string') {
    try {
      const parsed: unknown = JSON.parse(raw)
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : { raw }
    } catch {
      return { raw }
    }
  }
  return raw && typeof raw === 'object' ? raw as Record<string, unknown> : {}
}

/** 引擎消息 → 对话页同一套时间线条目（工具结果按顺序配给前一条 tool_call）。 */
const timeline = computed<Timelineitem[]>(() => {
  const out: Timelineitem[] = []
  const pending: ToolCard[] = []
  messages.value.forEach((message, index) => {
    if (message.role === 'system') return
    if (message.role === 'user') {
      if (message.content.trim()) out.push({ kind: 'user', id: `u-${index}`, mid: '', content: message.content })
      return
    }
    if (message.reasoning?.trim()) {
      out.push({ kind: 'reasoning', id: `r-${index}`, content: message.reasoning, expanded: false })
    }
    if (message.role === 'assistant') {
      if (message.content.trim()) {
        out.push({ kind: 'assistant', id: `a-${index}`, mid: '', content: message.content, streaming: false })
      }
      ;(message.tools ?? []).forEach((call, toolIndex) => {
        const card: ToolCard = {
          kind: 'tool',
          callId: call.id || `call-${index}-${toolIndex}`,
          toolName: call.name || 'tool',
          arguments: parseArgs(call.arguments),
          status: 'running',
        }
        out.push(card)
        pending.push(card)
      })
      return
    }
    if (message.role === 'tool') {
      const match = pending.shift()
      if (match) {
        match.status = 'success'
        match.resultPreview = message.content
        match.resultFull = message.content
      } else if (message.content.trim()) {
        out.push({ kind: 'notice', id: `n-${index}`, tone: 'info', text: message.content.slice(0, 800) })
      }
    }
  })
  // 没有结果的工具调用：运行中显示在跑，结束后标记为已取消。
  for (const item of pending) item.status = running.value ? 'running' : 'cancelled'
  return out
})

const blocks = computed(() => buildTimelineBlocks(timeline.value))

async function loadMessages() {
  try {
    const data = await apiGet<{ status?: string; messages?: AgentMessage[] }>(`/api/agents/${encodeURIComponent(props.agentId)}/messages`)
    status.value = data.status ?? ''
    messages.value = data.messages ?? []
    error.value = ''
    if (!running.value) stopPolling()
  } catch (e) {
    error.value = friendlyError(e)
  } finally {
    loading.value = false
  }
}

/** 引擎的 404 文案是英文且带技术细节：翻成用户能照着做的一句话。 */
function friendlyError(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause)
  if (/not found|unknown agent|pruned|404|非 JSON|非JSON|空响应/i.test(message)) {
    return '这个子代理的会话已不可用（可能已被清理，或引擎版本过旧）。请返回主会话重新派发。'
  }
  return message
}

async function loadAgents() {
  try {
    const data = await apiGet<{ agents?: AgentInfo[] }>('/api/agents')
    agents.value = data.agents ?? []
  } catch { /* 列表失败不阻塞会话展示 */ }
}

async function send() {
  if (!canSend.value) return
  const text = draft.value.trim()
  sending.value = true
  sendError.value = ''
  try {
    await apiSend(`/api/agents/${encodeURIComponent(props.agentId)}/message`, 'POST', { text })
    draft.value = ''
    window.setTimeout(() => { void loadMessages() }, 600)
  } catch (e) {
    sendError.value = e instanceof Error ? e.message : String(e)
  } finally {
    sending.value = false
  }
}

async function closeAgent() {
  try { await apiSend(`/api/agents/${encodeURIComponent(props.agentId)}/close`, 'POST') } catch { /* ignore */ }
  void loadMessages()
}

function startPolling() {
  stopPolling()
  timer = window.setInterval(() => { void loadMessages(); void loadAgents() }, 1500)
}
function stopPolling() { if (timer) { window.clearInterval(timer); timer = null } }
function retry() {
  loading.value = true
  error.value = ''
  void loadMessages()
  startPolling()
}

function onScroll() {
  const el = streamEl.value
  if (!el) return
  following = el.scrollHeight - el.scrollTop - el.clientHeight < 60
}

// 新消息到达时跟随底部；用户上滑看历史时不抢滚动。
watch(messages, async () => {
  await nextTick()
  const el = streamEl.value
  if (el && following) el.scrollTop = el.scrollHeight
}, { deep: true })

onMounted(() => {
  void loadAgents()
  void loadMessages()
  startPolling()
})
watch(() => props.agentId, () => { loading.value = true; following = true; void loadMessages(); startPolling() })
onBeforeUnmount(stopPolling)

defineExpose({ reload: loadMessages })
</script>

<template>
  <div class="sa-overlay">
    <header class="sa-head">
      <button class="sa-back" @click="emit('close')"><CoomiIcon name="arrowLeft" :size="16" /><span>返回主会话</span></button>
      <span class="sa-title">{{ title }}</span>
      <span class="sa-status" :class="{ run: running }">{{ running ? '运行中' : (status === 'failed' ? '失败' : '已结束') }}</span>
    </header>

    <div ref="streamEl" class="sa-stream" @scroll.passive="onScroll">
      <p v-if="loading" class="sa-hint">正在读取子代理会话…</p>
      <div v-else-if="error" class="sa-hint err">
        <span>读取失败：{{ error }}</span>
        <button class="sa-retry" @click="retry">重试</button>
      </div>
      <p v-else-if="!blocks.length" class="sa-hint">这个子代理还没有可展示的消息。</p>

      <div v-for="block in blocks" :key="block.key" class="sa-block">
        <TimelineBlock :block="block" no-enter readonly />
      </div>
    </div>

    <footer class="sa-foot">
      <div class="sa-field">
        <div class="sa-locks">
          <span class="sa-lock"><CoomiIcon name="terminal" :size="14" /><span>{{ modelLabel }}</span></span>
          <span class="sa-lock"><CoomiIcon name="brain" :size="14" /><span>思考强度：{{ effortLabel }}</span></span>
          <span class="sa-lock-note">跟随主会话（不可修改）</span>
        </div>
        <div class="sa-input-row">
          <input
            v-model="draft"
            class="sa-input"
            type="text"
            :disabled="!running"
            :placeholder="running ? '给子代理补充指令…' : '子代理已结束'"
            enterkeyhint="send"
            @keydown.enter.prevent="send"
          />
          <button class="sa-send" :disabled="!canSend" aria-label="发送" @click="send">
            <CoomiIcon name="arrowUp" :size="17" />
          </button>
        </div>
        <p v-if="sendError" class="sa-send-err">{{ sendError }}</p>
      </div>
      <div class="sa-foot-actions">
        <button class="sa-danger" :disabled="!running" @click="closeAgent">关闭子代理</button>
      </div>
    </footer>
  </div>
</template>

<style scoped>
.sa-overlay {
  position: absolute; inset: 0; z-index: calc(var(--z-header) + 1);
  display: flex; flex-direction: column;
  background: var(--bg);
}
.sa-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.sa-back {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  min-height: 32px; padding: 0 var(--sp-2); border: 0; background: none;
  color: var(--text-2); font-size: var(--fs-label);
}
.sa-title {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text); font-size: var(--fs-sub); font-weight: 600;
}
.sa-status {
  flex-shrink: 0; padding: 2px var(--sp-2); border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-3); font-size: var(--fs-caption); font-weight: 600;
}
.sa-status.run { background: var(--blue-soft); color: var(--blue); }

.sa-stream {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px var(--sp-3) var(--sp-1);
}
.sa-block { padding-bottom: var(--sp-3); }

.sa-hint { margin: var(--sp-4) 0; text-align: center; color: var(--text-3); font-size: var(--fs-sub); }
.sa-hint.err { display: flex; flex-direction: column; align-items: center; gap: var(--sp-2); color: var(--danger); }
.sa-retry {
  min-height: 30px; padding: 0 var(--sp-3); border: 1px solid var(--border);
  border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
}

.sa-foot {
  flex-shrink: 0; padding: var(--sp-2) var(--sp-3) calc(var(--sp-3) + var(--safe-bottom));
  border-top: 1px solid var(--border); background: var(--bg);
}
.sa-field {
  padding: var(--sp-2) 6px 6px var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-sheet);
  background: var(--fill);
  box-shadow: inset 0 1px 0 color-mix(in srgb, #fff 55%, transparent), 0 8px 20px -16px rgba(16, 24, 40, .35);
}
.sa-locks { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; }
.sa-lock {
  display: inline-flex; align-items: center; gap: var(--sp-1); max-width: 44%;
  padding: 2px var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2); font-size: var(--fs-caption); font-weight: 600;
}
.sa-lock span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sa-lock-note { color: var(--text-3); font-size: var(--fs-caption); }
.sa-input-row { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-1); }
.sa-input {
  flex: 1; min-width: 0; min-height: 34px; border: 0; background: none; outline: none;
  color: var(--text); font: inherit; font-size: var(--fs-strong);
}
.sa-input:disabled { color: var(--text-3); }
.sa-input::placeholder { color: var(--text-3); }
.sa-send {
  display: grid; place-items: center; flex-shrink: 0; width: 36px; height: 36px;
  border: 0; border-radius: 50%; background: var(--blue); color: #fff;
}
.sa-send:disabled { background: var(--border-strong); color: var(--text-3); }
.sa-send-err { margin: var(--sp-1) 2px 0; color: var(--danger); font-size: var(--fs-caption); }
.sa-foot-actions { display: flex; justify-content: flex-end; margin-top: var(--sp-2); }
.sa-danger {
  min-height: 30px; padding: 0 var(--sp-3); border: 1px solid var(--danger-border);
  border-radius: var(--r-pill); background: var(--danger-soft); color: var(--danger);
  font-size: var(--fs-label); font-weight: 600;
}
.sa-danger:disabled { opacity: .55; }
</style>
