<script setup lang="ts">
/**
 * 环境检测面板：显示活跃运行时里真实执行命令的结果（backend / 命令 / 镜像 / 网络）。
 * 不做任何猜测——报告来自 /api/runtime/env-check。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import CoomiIcon from './CoomiIcon.vue'
import { apiGet } from '@/bridge/http'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

interface EnvCommand { name: string; found: boolean; path?: string | null; version?: string | null }
interface EnvNetwork { url: string; ok: boolean; status: string }
interface EnvReport {
  backend?: string
  status?: string
  active_version?: string | null
  rootfs?: string | null
  home?: string
  shell_ok?: boolean
  commands?: EnvCommand[]
  mirrors?: Record<string, string>
  network?: EnvNetwork[]
  missing?: string[]
  ok?: boolean
  fixable?: boolean
  error?: string | null
}

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: []; repair: [] }>()

const report = ref<EnvReport | null>(null)
const loading = ref(false)
const error = ref('')

const backendLabel = computed(() => {
  switch (report.value?.backend) {
    case 'proot_linux': return 'Proot Linux'
    case 'legacy_termux': return 'Termux 兼容环境'
    case 'host': return '宿主机'
    default: return report.value?.backend || '未知'
  }
})
const statusLabel = computed(() => {
  switch (report.value?.status) {
    case 'ready': return '就绪'
    case 'needs_repair': return '需要修复'
    case 'not_installed': return '未安装'
    case 'initializing': return '初始化中'
    case 'downloading': return '下载中'
    default: return report.value?.status || '未知'
  }
})
const healthy = computed(() => report.value?.ok === true)
const commands = computed(() => report.value?.commands || [])
const network = computed(() => report.value?.network || [])
const mirrors = computed(() => Object.entries(report.value?.mirrors || {}))
const missing = computed(() => report.value?.missing || [])

async function load() {
  if (!props.open) return
  loading.value = true
  error.value = ''
  try {
    report.value = await apiGet<EnvReport>('/api/runtime/env-check')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

watch(() => props.open, value => {
  // 展开时登记返回栈：系统返回先关面板，不会把整页带走。
  if (value) { registerOverlay('runtime-env', () => emit('close')); void load() }
  else unregisterOverlay('runtime-env')
}, { immediate: true })
onBeforeUnmount(() => unregisterOverlay('runtime-env'))
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <section class="sheet">
      <div class="grip" />
      <header class="head">
        <span class="tile"><CoomiIcon name="cpu" :size="20" /></span>
        <div class="title">
          <h2>环境检测</h2>
          <p>在活跃运行时里实际执行命令，不使用路径猜测。</p>
        </div>
        <button class="x" aria-label="关闭" @click="emit('close')"><CoomiIcon name="close" :size="16" /></button>
      </header>

      <div v-if="loading" class="state">正在检测（最多约 60 秒）…</div>
      <div v-else-if="error" class="state err">{{ error }}</div>

      <template v-else-if="report">
        <div class="summary" :class="healthy ? 'ok' : 'warn'">
          <span class="dot" />
          <div>
            <strong>{{ healthy ? '环境可用' : '环境需要处理' }}</strong>
            <small>{{ backendLabel }} · {{ statusLabel }}<template v-if="report.active_version"> · v{{ report.active_version }}</template></small>
          </div>
          <button class="mini" :disabled="loading" @click="load"><CoomiIcon name="refresh" :size="14" />重测</button>
        </div>

        <p v-if="report.error" class="banner err">{{ report.error }}</p>
        <p v-else-if="missing.length" class="banner warn">
          缺少：{{ missing.join('、') }}。MCP / Skill 安装可能因此失败。
        </p>

        <section class="block">
          <h3>命令</h3>
          <div class="rows">
            <div v-for="command in commands" :key="command.name" class="row">
              <span class="name">{{ command.name }}</span>
              <code class="path" :title="command.path || ''">{{ command.path || '未找到' }}</code>
              <span class="ver">{{ command.version || '—' }}</span>
              <span class="mark" :class="command.found ? 'ok' : 'bad'">
                <CoomiIcon :name="command.found ? 'check' : 'close'" :size="12" />
              </span>
            </div>
            <p v-if="!commands.length" class="muted">没有返回命令结果。</p>
          </div>
        </section>

        <section class="block">
          <h3>镜像</h3>
          <div class="chips">
            <span v-for="[key, value] in mirrors" :key="key" class="chip">
              <b>{{ key }}</b>{{ value }}
            </span>
            <span v-if="!mirrors.length" class="muted">没有镜像配置。</span>
          </div>
        </section>

        <section class="block">
          <h3>网络</h3>
          <div class="rows">
            <div v-for="probe in network" :key="probe.url" class="row net">
              <code class="url" :title="probe.url">{{ probe.url }}</code>
              <span class="ver">{{ probe.status }}</span>
              <span class="mark" :class="probe.ok ? 'ok' : 'bad'">
                <CoomiIcon :name="probe.ok ? 'check' : 'close'" :size="12" />
              </span>
            </div>
            <p v-if="!network.length" class="muted">没有网络探测结果（可能缺少 curl）。</p>
          </div>
        </section>

        <div class="actions">
          <button class="btn ghost" @click="emit('close')">关闭</button>
          <button v-if="report.fixable && !healthy" class="btn primary" @click="emit('repair')">
            一键修复环境
          </button>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-sheet);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .45);
}
.sheet {
  width: 100%; max-width: 560px; max-height: 88vh; overflow-y: auto;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); box-shadow: var(--shadow-sheet);
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grip { width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-3); border-radius: var(--r-pill); background: var(--fill-strong); }
.head { display: flex; align-items: center; gap: var(--sp-2); }
.tile { display: grid; place-items: center; width: var(--sp-9); height: var(--sp-9); border-radius: var(--r-md); background: var(--blue-soft); color: var(--blue); }
.title { flex: 1; min-width: 0; }
.title h2 { margin: 0; color: var(--text); font-size: var(--fs-strong); font-weight: 700; }
.title p { margin: 2px 0 0; color: var(--text-3); font-size: var(--fs-caption); }
.x { display: grid; place-items: center; width: var(--sp-8); height: var(--sp-8); border: 0; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); }
.state { padding: var(--sp-5) 0; color: var(--text-3); font-size: var(--fs-sub); text-align: center; }
.state.err { color: var(--danger); }
.summary {
  display: flex; align-items: center; gap: var(--sp-2);
  margin-top: var(--sp-4); padding: var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); border: 1px solid var(--border);
}
.summary.ok { border-color: color-mix(in srgb, var(--ok) 35%, var(--border)); background: var(--ok-soft); }
.summary.warn { border-color: color-mix(in srgb, var(--orange) 35%, var(--border)); background: var(--orange-soft); }
.summary .dot { width: var(--sp-2); height: var(--sp-2); border-radius: 50%; background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.summary.warn .dot { background: var(--orange); box-shadow: 0 0 0 3px color-mix(in srgb, var(--orange) 18%, transparent); }
.summary div { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.summary strong { color: var(--text); font-size: var(--fs-sub); }
.summary small { color: var(--text-2); font-size: var(--fs-caption); }
.mini { display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 28px; padding: 0 var(--sp-2); border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--bg); color: var(--text-2); font-size: var(--fs-caption); font-weight: 600; }
.banner { margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-label); line-height: var(--lh-label); }
.banner.err { background: var(--danger-soft); color: var(--danger); }
.banner.warn { background: var(--orange-soft); color: var(--orange); }
.block { margin-top: var(--sp-4); }
.block h3 { margin: 0 0 var(--sp-2); color: var(--text-2); font-size: var(--fs-label); font-weight: 600; }
.rows { display: flex; flex-direction: column; gap: 1px; border: 1px solid var(--border); border-radius: var(--r-md); overflow: hidden; background: var(--border); }
.row { display: flex; align-items: center; gap: var(--sp-2); padding: 9px var(--sp-3); background: var(--bg); min-width: 0; }
.row.net .url { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.name { width: 64px; flex-shrink: 0; color: var(--text); font-size: var(--fs-label); font-weight: 600; }
.path { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-2); font-family: var(--font-mono); font-size: var(--fs-caption); }
.ver { max-width: 44%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-size: var(--fs-caption); }
.mark { display: grid; place-items: center; width: 18px; height: 18px; border-radius: 50%; flex-shrink: 0; }
.mark.ok { background: var(--ok-soft); color: var(--ok); }
.mark.bad { background: var(--danger-soft); color: var(--danger); }
.chips { display: flex; flex-wrap: wrap; gap: var(--sp-1); }
.chip { display: inline-flex; align-items: center; gap: 5px; padding: var(--sp-1) var(--sp-2); border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); font-size: var(--fs-caption); }
.chip b { color: var(--text-3); font-weight: 600; }
.muted { margin: var(--sp-2) 0 0; color: var(--text-3); font-size: var(--fs-caption); }
.actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-4); }
.btn { flex: 1; min-height: var(--sp-9); border: 0; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.btn.primary { background: var(--blue); color: #fff; }
</style>
