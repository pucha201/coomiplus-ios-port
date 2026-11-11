<script setup lang="ts">
/**
 * Proot 依赖补全（npm / pip / ssh）的实时进度弹层。
 *
 * 引擎在后台跑 apt，状态写在 runtime-v2/guest-env-status.json：
 * phase / log_tail / downloaded_bytes / speed_bps / elapsed_ms / mirror。
 * 这里只做轮询与展示，不阻塞用户；关闭弹层补全会继续，重新打开还能看进度。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import { apiGet, apiSend } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'

interface GuestEnvStatus {
  state: string
  phase?: string
  log_tail?: string
  downloaded_bytes?: number
  speed_bps?: number
  elapsed_ms?: number
  mirror?: string
  error?: string | null
  updated_at_ms?: number
}

interface RuntimeV2 {
  runtime?: { backend?: string; status?: string; error?: string | null }
  guest_env?: GuestEnvStatus
}

const props = withDefaults(defineProps<{ autoStart?: boolean }>(), { autoStart: false })
const emit = defineEmits<{ close: []; ready: []; failure: [message: string] }>()

// 只在展开时挂载：挂载即登记返回栈，系统返回先关这个浮层。
onMounted(() => registerOverlay('env-repair', () => emit('close')))
onBeforeUnmount(() => unregisterOverlay('env-repair'))

const status = ref<GuestEnvStatus | null>(null)
const starting = ref(false)
const localError = ref('')
const logEl = ref<HTMLElement | null>(null)
const stickToBottom = ref(true)
let timer: number | undefined
let finished = false
let disposed = false

const running = computed(() => status.value?.state === 'running' || starting.value)
const phaseLabel = computed(() => {
  switch (status.value?.phase) {
    case 'prepare': return '准备镜像与目录'
    case 'apt-update': return '更新软件源'
    case 'apt-install': return '安装 Node / Python / Git'
    case 'uv-install': return '安装 uv（uvx）'
    case 'downloading': return '下载软件包'
    case 'installing': return '解包并安装'
    case 'finalize': return '收尾'
    case 'done': return '已完成'
    case 'error': return '失败'
    default: return status.value?.state === 'pending' ? '等待开始' : '连接引擎'
  }
})
const stateLabel = computed(() => {
  if (starting.value) return '启动中'
  switch (status.value?.state) {
    case 'running': return '补全中'
    case 'ready': return '已就绪'
    case 'error': return '失败'
    default: return '等待开始'
  }
})
const phaseClass = computed(() => (status.value?.state === 'error' ? 'err' : status.value?.state === 'ready' ? 'ok' : ''))
const speedText = computed(() => formatSpeed(status.value?.speed_bps ?? 0))
const elapsedText = computed(() => formatElapsed(status.value?.elapsed_ms ?? 0))
const downloadedText = computed(() => formatBytes(status.value?.downloaded_bytes ?? 0))
const mirrorText = computed(() => status.value?.mirror || '正在读取镜像配置…')
const errorText = computed(() => localError.value || status.value?.error || '')

function formatBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '0 B'
  if (value < 1024) return `${Math.round(value)} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${(value / (1024 * 1024)).toFixed(1)} MB`
}

function formatSpeed(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '—'
  return `${formatBytes(value)}/s`
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}

function stopPolling() {
  if (timer) {
    window.clearInterval(timer)
    timer = undefined
  }
}

function startPolling() {
  stopPolling()
  timer = window.setInterval(() => { void refresh() }, 1000)
}

async function refresh() {
  try {
    const data = await apiGet<RuntimeV2>('/api/runtime/v2')
    status.value = data.guest_env ?? null
    localError.value = ''
    if (status.value?.state === 'ready') {
      stopPolling()
      if (!finished) { finished = true; emit('ready') }
    } else if (status.value?.state === 'error') {
      stopPolling()
      if (!finished) { finished = true; emit('failure', status.value.error || '依赖补全失败') }
    }
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  }
}

async function start() {
  if (starting.value || running.value) return
  starting.value = true
  localError.value = ''
  finished = false
  try {
    await apiSend('/api/runtime/v2', 'POST', { action: 'repair-env' })
    await refresh()
    startPolling()
  } catch (error) {
    localError.value = error instanceof Error ? error.message : String(error)
  } finally {
    starting.value = false
  }
}

function close() {
  stopPolling()
  emit('close')
}

function onLogScroll() {
  const el = logEl.value
  if (!el) return
  stickToBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 24
}

watch(() => status.value?.log_tail, async () => {
  if (!stickToBottom.value) return
  await nextTick()
  const el = logEl.value
  if (el) el.scrollTop = el.scrollHeight
})

onMounted(() => {
  void refresh().then(() => {
    if (disposed) return
    if (props.autoStart && status.value?.state !== 'ready' && status.value?.state !== 'running') {
      void start()
    } else if (running.value) {
      startPolling()
    }
  })
})

onBeforeUnmount(() => {
  disposed = true
  stopPolling()
})
</script>

<template>
  <Teleport to="body">
    <div class="env-mask">
      <section class="env-sheet" role="dialog" aria-modal="true" aria-label="补全运行环境">
        <header class="env-head">
          <div class="env-title">
            <span class="env-icon" :class="phaseClass"><CoomiIcon name="terminal" :size="17" /></span>
            <span>补全运行环境</span>
          </div>
          <button class="env-x" aria-label="关闭" @click="close"><CoomiIcon name="close" :size="16" /></button>
        </header>

        <div class="env-status">
          <span class="env-state" :class="phaseClass">{{ stateLabel }}</span>
          <span class="env-phase">{{ phaseLabel }}</span>
          <span class="env-time">{{ elapsedText }}</span>
        </div>

        <div class="env-metrics">
          <span>下载 <b>{{ downloadedText }}</b></span>
          <span>速度 <b>{{ speedText }}</b></span>
        </div>

        <p class="env-mirror">镜像源：{{ mirrorText }}</p>
        <p v-if="errorText" class="env-error">{{ errorText }}</p>

        <div class="env-log-head">
          <span>安装日志</span>
          <span v-if="running" class="env-live">实时</span>
        </div>
        <pre ref="logEl" class="env-log" @scroll.passive="onLogScroll">{{ status?.log_tail || (status ? '等待安装日志…' : '正在连接引擎…') }}</pre>

        <footer class="env-foot">
          <button v-if="status?.state === 'error'" class="env-btn primary" @click="start">重新补全</button>
          <button class="env-btn" @click="close">{{ running ? '后台运行' : '关闭' }}</button>
        </footer>
      </section>
    </div>
  </Teleport>
</template>

<style scoped>
.env-mask {
  position: fixed; inset: 0; z-index: var(--z-modal, 120);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-3);
  background: rgba(4, 6, 10, .36);
  backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
}
.env-sheet {
  width: min(100%, 560px); max-height: min(88vh, 720px);
  display: flex; flex-direction: column;
  padding: var(--sp-3) var(--sp-3) calc(var(--sp-3) + var(--safe-bottom, 0px));
  border: 1px solid var(--border); border-radius: var(--r-sheet);
  background: var(--bg); box-shadow: var(--shadow-2);
}
.env-head { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
.env-title { display: flex; align-items: center; gap: 9px; font-size: var(--fs-strong); font-weight: 700; color: var(--text); }
.env-icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-md); background: var(--blue-soft); color: var(--blue); }
.env-icon.err { background: var(--danger-soft); color: var(--danger); }
.env-icon.ok { background: var(--ok-soft); color: var(--ok); }
.env-x { display: grid; place-items: center; width: 34px; height: 34px; border: 0; border-radius: 50%; background: var(--fill); color: var(--text-2); }
.env-status { display: flex; align-items: center; gap: var(--sp-2); margin-top: 14px; font-size: var(--fs-sub); color: var(--text-2); }
.env-state { padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--blue-soft); color: var(--blue); font-weight: 600; }
.env-state.err { background: var(--danger-soft); color: var(--danger); }
.env-state.ok { background: var(--ok-soft); color: var(--ok); }
.env-phase { font-weight: 600; color: var(--text); }
.env-time { margin-left: auto; font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-3); }
.env-metrics { display: flex; gap: 18px; margin-top: 10px; font-size: var(--fs-caption); color: var(--text-3); }
.env-metrics b { color: var(--text); font-family: var(--font-mono); font-weight: 600; }
.env-mirror { margin: 10px 0 0; font-size: var(--fs-caption); color: var(--text-3); word-break: break-all; }
.env-error { margin: var(--sp-2) 0 0; padding: var(--sp-2) 10px; border-radius: var(--r-sm); background: var(--danger-soft); color: var(--danger); font-size: var(--fs-caption); line-height: 1.5; word-break: break-word; }
.env-log-head { display: flex; align-items: center; justify-content: space-between; margin-top: var(--sp-3); font-size: var(--fs-caption); font-weight: 600; color: var(--text-3); }
.env-live { color: var(--blue); }
.env-log {
  flex: 1; min-height: 120px; max-height: 40vh; margin: 6px 0 0; overflow: auto; overscroll-behavior: contain;
  padding: 10px var(--sp-3); border-radius: var(--r-md); background: var(--code-bg); color: var(--code-text);
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.55;
  white-space: pre-wrap; word-break: break-word;
}
.env-foot { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: var(--sp-3); }
.env-btn { min-height: 38px; padding: 0 var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); font-size: var(--fs-label); font-weight: 600; }
.env-btn.primary { border-color: var(--blue-border); background: var(--blue); color: #fff; }
.env-btn:active { opacity: .82; }
@media (min-width: 640px) { .env-mask { align-items: center; } }
@media (prefers-reduced-motion: reduce) { .env-mask { backdrop-filter: none; } }
</style>
