<script setup lang="ts">
/**
 * 顶栏：汉堡 / 模型名 / 上下文用量。
 * 忙的时候底边跑一条 2px 蓝色扫光，让「正在干活」这件事在最顶层也能看见。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import { useSessionsStore } from '@/stores/sessions'
import { apiGet } from '@/bridge/http'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import CoomiIcon from './CoomiIcon.vue'
import BalanceCard from './BalanceCard.vue'
import { REVERSE_FLAVOR_SHORT } from '@/utils/reverseMode'

const props = withDefaults(defineProps<{ focusedSubagentName?: string | null }>(), { focusedSubagentName: null })
defineEmits<{
  menu: []
  /** 子代理条目：callId 用于定位，name 用于顶栏展示。 */
  focusSubagent: [agentId: string, name: string]
  backToMain: []
  search: []
}>()

/** 顶栏只显示子代理名的一部分（不是全部）。 */
const shortSubagent = computed(() => {
  const name = props.focusedSubagentName ?? ''
  return name.length > 10 ? name.slice(0, 10) + '…' : name
})

const config = useConfigStore()
const session = useSessionStore()
const sessions = useSessionsStore()
const connection = useConnectionStore()
const router = useRouter()
const modelOpen = ref(false)
const usageOpen = ref(false)
const pathPickerOpen = ref(false)
const pathInput = ref('')
const pathNotice = ref('')
const activeModelCategory = ref('')
const pathQuickOptions = computed(() => session.cwd ? [session.cwd] : [])
const modelGroups = computed(() => {
  return [...config.providers]
    .sort((a, b) => Number(b.id === config.activeId) - Number(a.id === config.activeId))
    .map(provider => ({
      id: provider.id, label: provider.name, items: [...new Set([...(provider.models ?? []), provider.model].filter(Boolean))]
        .map(model => ({ providerId: provider.id, provider: provider.name, model: model! })),
    }))
})
const activeModelGroup = computed(() => modelGroups.value.find(group => group.id === activeModelCategory.value) ?? {
  id: '__empty__', label: '供应商', items: [] as Array<{ providerId: string; provider: string; model: string }>,
})
// ── §九 顶栏显示逻辑 ──
/** 已开始对话：有用户消息才算「开始」——新会话顶栏只留侧边栏按钮。 */
const hasConversation = computed(() => session.timeline.some(t => t.kind === 'user'))
/** 会话标题：开始对话后在侧边栏按钮旁渐显；没取到时退回模型名（点击仍是模型菜单）。 */
const chatTitle = computed(() => sessions.find(session.sessionId)?.title ?? '')
const usagePercent = computed(() => Math.min(100, Math.max(0, Math.round((session.usage?.contextRatio ?? 0) * 100))))
const categoryLabels = { system_tools: '系统工具', messages: '消息', skills: '技能', mcp_tools: 'MCP 工具', system_prompt: '系统提示', other: '其他' } as const
const categoryTotal = computed<number>(() => Object.values(session.usage?.contextCategories ?? {}).reduce<number>((sum, value) => sum + (value ?? 0), 0))

/* ── §四 分段用量环：每类占用一种颜色，从顶端（12 点）起沿圆环依次增长 ── */
/** 分段配色：固定柔和调色板（明亮/暗色两态都可读，不依赖会变黑的正文灰阶）。
 *  按占用量从大到小依次取色，保证相邻段颜色区分明显。 */
const SEGMENT_PALETTE = ['#5b6cff', '#14b8a6', '#f59e0b', '#f43f5e', '#8b5cf6', '#0ea5e9']
interface UsageSegment { key: string; label: string; tokens: number; percent: number; color: string; offset: number }
/** 分段按「占上下文窗口的百分比」画：总和 = 已用比例，未用部分由轨道衬底。 */
const segments = computed<UsageSegment[]>(() => {
  const cats = session.usage?.contextCategories ?? {}
  const windowSize = session.usage?.contextWindow ?? 0
  const total = windowSize > 0 ? windowSize : categoryTotal.value
  if (!total) return []
  let acc = 0
  const sorted = Object.entries(cats)
    .filter(([, value]) => (value ?? 0) > 0)
    .sort((a, b) => (b[1] ?? 0) - (a[1] ?? 0))
  // 分段封顶 6：超出部分合并为「其他」（分段环超过 5-6 段就不可读）。
  const capped: Array<[string, number]> = sorted.length > 6
    ? [...sorted.slice(0, 5), ['other', sorted.slice(5).reduce((sum, [, value]) => sum + (value ?? 0), 0)]]
    : sorted
  return capped
    .map(([key, value], index) => {
      const percent = ((value ?? 0) / total) * 100
      const segment: UsageSegment = {
        key, label: categoryLabels[key as keyof typeof categoryLabels] ?? key,
        tokens: value ?? 0, percent,
        color: SEGMENT_PALETTE[index % SEGMENT_PALETTE.length], offset: -acc,
      }
      acc += percent
      return segment
    })
})
/** 环的生长动画开关：打开面板时先置 false → 下一帧置 true，各段从 0 长到目标值。 */
const ringGrown = ref(false)

/* ── §四 底部时间统计 ──
   全部来自引擎计时（turn_end 的 elapsed_ms / llm_ms / tool_ms，会话累计走
   /api/sessions/{id}/timing）。缺失时显示 --，绝不拿「会话创建至今」冒充。 */
const timing = computed(() => session.timing)

/* ── §二 子代理：从时间线里的子代理工具卡识别（运行态 / 名称 / 是否在跑） ── */
// 只认真子代理工具：以前用宽泛正则，claim_task / message_agent / wait_for_file
// 都会被误判成子代理，点进去必然 404。
const SUBAGENT_TOOLS = new Set(['spawn_agent', 'spawn_task', 'run_agent', 'start_agent', 'task', 'subagent', 'delegate'])
interface SubagentRow { callId: string; agentId: string; name: string; status: string; running: boolean; elapsed?: number }
interface LiveAgent { id: string; status: string; elapsed_ms?: number }
/** /api/agents 的实时状态：工具卡在派发返回后就是 success，不能拿它判断子代理还在不在跑。 */
const liveAgents = ref<Record<string, LiveAgent>>({})
let liveTimer: number | null = null
async function refreshLiveAgents() {
  // 后台时不轮询：手机负载高的时候，看不见的数据不该继续抢主线程。
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
  try {
    const data = await apiGet<{ agents?: LiveAgent[] }>('/api/agents')
    const next: Record<string, LiveAgent> = {}
    for (const agent of data.agents ?? []) next[agent.id] = agent
    // 状态没变就不替换对象：每 2 秒换一份新对象会让整个顶栏/子代理列表重算一遍。
    const before = Object.keys(liveAgents.value)
    const after = Object.keys(next)
    const unchanged = before.length === after.length && after.every(id => {
      const a = liveAgents.value[id]
      const b = next[id]
      return a && a.status === b.status && a.elapsed_ms === b.elapsed_ms
    })
    if (!unchanged) liveAgents.value = next
  } catch { /* 引擎短暂不可用时保留上一次状态 */ }
}
function startLivePolling() {
  if (liveTimer) return
  void refreshLiveAgents()
  liveTimer = window.setInterval(() => { void refreshLiveAgents() }, 2000)
}
function stopLivePolling() {
  if (liveTimer) { window.clearInterval(liveTimer); liveTimer = null }
}
const subagents = computed<SubagentRow[]>(() => {
  const rows: SubagentRow[] = []
  for (const item of session.timeline) {
    if (item.kind !== 'tool') continue
    if (!SUBAGENT_TOOLS.has(item.toolName)) continue
    const args = item.arguments as Record<string, unknown> | undefined
    const rawName = (args?.description ?? args?.session_title ?? args?.prompt ?? args?.task ?? '') as string
    const name = String(rawName || item.toolName).replace(/\s+/g, ' ').slice(0, 26)
    const running = item.status === 'running' || item.status === 'starting' || item.status === 'awaiting_approval'
    // spawn_agent 的返回里带 `agent_id: xxx`（部分网关会包成 JSON：`"agent_id":"xxx"`）
    // —— 两种形态都要认，拿不到就留空并禁用入口；绝不能拿 callId 冒充 agent_id。
    const hit = /"?agent_id"?\s*:\s*"?([\w.-]+)/.exec(item.resultFull ?? item.resultPreview ?? '')
    const agentId = hit?.[1] ?? ''
    const live = agentId ? liveAgents.value[agentId] : undefined
    const liveRunning = live ? (live.status === 'running' || live.status === 'pending') : null
    rows.push({
      callId: item.callId,
      agentId,
      name,
      status: live?.status ?? item.status,
      running: liveRunning ?? running,
      elapsed: live?.elapsed_ms != null ? live.elapsed_ms / 1000 : item.elapsed,
    })
  }
  return rows
})
const subagentRunning = computed(() => subagents.value.filter(row => row.running).length)
const subagentOpen = ref(false)
// 有可定位的子代理时才轮询实时状态；没有就停掉，避免空转请求。
watch(() => subagents.value.some(row => Boolean(row.agentId)), has => {
  if (has) startLivePolling()
  else stopLivePolling()
}, { immediate: true })
onBeforeUnmount(stopLivePolling)

function formatSpan(ms: number | null | undefined): string {
  if (ms == null) return '--'
  const totalSec = Math.round(ms / 1000)
  if (totalSec < 60) return totalSec + 's'
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return min + 'm' + (sec ? ' ' + sec + 's' : '')
  return Math.floor(min / 60) + 'h ' + (min % 60) + 'm'
}
function segmentPercentText(segment: UsageSegment): string {
  return segment.percent >= 1 ? segment.percent.toFixed(1) + '%' : segment.percent.toFixed(2) + '%'
}
function formatTokens(value: number): string {
  if (value >= 1000000) return (value / 1000000).toFixed(1) + 'M'
  if (value >= 1000) return (value / 1000).toFixed(1) + 'k'
  return String(value)
}
/** 累计命中率三态：引擎明确说不提供缓存计量时显示「未提供」，绝不用 0% 冒充命中率。 */
function formatCache(rate: number | null | undefined, available: boolean): string {
  if (!available) return '本模型/供应商未提供'
  return rate == null ? '—' : `${(rate * 100).toFixed(1)}%`
}
/** 本轮命中率：一轮刚开始时 turn_cache_data_available 也是 false，不能据此断言「不提供」——
    只有累计口径明确不支持时才那么说（与桌面端 turnAvailability 同一处理）。 */
function formatTurnCache(rate: number | null | undefined, totalAvailable: boolean, turnAvailable: boolean): string {
  if (!totalAvailable) return '本模型/供应商未提供'
  if (turnAvailable && rate != null) return `${(rate * 100).toFixed(1)}%`
  return '—'
}
function formatDuration(value: number | null | undefined): string {
  if (value == null) return '--'
  return value >= 1000 ? `${(value / 1000).toFixed(1)}s` : `${value}ms`
}

function choose(providerId: string, model: string) {
  session.selectModel(providerId, model)
  modelOpen.value = false
}

// ── 运行环境（上下文环卡片底部徽标，来自 /api/runtime/doctor 真检测）──
interface RuntimeDoctor {
  runtime: { backend?: string; status?: string; active_version?: string | null; error?: string | null }
  facts?: {
    backend?: string; sh?: boolean; python?: string | null; git?: string | null
    node?: string | null; curl?: string | null; workspace?: boolean; tmp_writable?: boolean
  } | null
  termux_available?: boolean
}
const runtimeInfo = ref<RuntimeDoctor | null>(null)
const envBadgeClass = computed(() => {
  const runtime = runtimeInfo.value?.runtime
  if (runtime?.status === 'ready' && runtimeInfo.value?.facts?.sh) return 'ok'
  if (runtime?.status === 'ready') return 'warn'
  if (runtimeInfo.value?.termux_available) return 'warn'
  return 'down'
})
const envBadgeLabel = computed(() => {
  const doctor = runtimeInfo.value
  const runtime = doctor?.runtime
  if (runtime?.status === 'ready') {
    return doctor?.facts?.sh ? 'Debian 12 · proot' : '环境异常'
  }
  if (doctor?.termux_available) return 'Termux 降级'
  return '运行环境未就绪'
})
const envDetail = computed(() => {
  const facts = runtimeInfo.value?.facts
  if (!facts) return ''
  const parts: string[] = []
  if (facts.python) parts.push(`python ${facts.python.replace(/^Python /, '')}`)
  if (facts.git) parts.push(`git ${facts.git.replace(/^git version /, '')}`)
  if (facts.node) parts.push(`node ${facts.node}`)
  if (facts.workspace !== false) parts.push('/workspace ✓')
  return parts.join(' · ')
})
onMounted(async () => {
  try {
    runtimeInfo.value = await apiGet<RuntimeDoctor>('/api/runtime/doctor')
  } catch {
    runtimeInfo.value = null
  }
  // 侧边栏是「盖子滑开」式浮层：打开抽屉时必须把顶栏这些 Teleport 到 body 的浮层收起来，
  // 否则它们（z-index 20，body 级）会一直压在抽屉上面且不消失（缺陷 10）。
  window.addEventListener('coomi:drawer-state', onDrawerState)
})

function onDrawerState(event: Event): void {
  if (!(event as CustomEvent<{ open?: boolean }>).detail?.open) return
  usageOpen.value = false
  modelOpen.value = false
  subagentOpen.value = false
}

/**
 * 顶栏浮层（用量 / 模型 / 子代理 / 路径）也是「一层页面」：
 * 展开时系统返回必须先收起它。以前它们没登记到返回栈，展开用量详情后
 * 按返回键 closeTopOverlay() 为空 → 对话页直接退出应用。
 */
const TOPBAR_OVERLAY_IDS = ['topbar-usage', 'topbar-model', 'topbar-path', 'topbar-subagent'] as const
function bindOverlay(id: string, open: { value: boolean }) {
  watch(() => open.value, isOpen => {
    if (isOpen) registerOverlay(id, () => { open.value = false })
    else unregisterOverlay(id)
  }, { immediate: true })
}
bindOverlay('topbar-usage', usageOpen)
bindOverlay('topbar-model', modelOpen)
bindOverlay('topbar-path', pathPickerOpen)
bindOverlay('topbar-subagent', subagentOpen)

onBeforeUnmount(() => {
  window.removeEventListener('coomi:drawer-state', onDrawerState)
  for (const id of TOPBAR_OVERLAY_IDS) unregisterOverlay(id)
})

function toggleModel() {
  modelOpen.value = !modelOpen.value
  usageOpen.value = false
  if (modelOpen.value) {
    const selected = modelGroups.value.find(group => group.items.some(item => (
      item.providerId === config.currentProviderId && item.model === config.currentModel
    )))
    activeModelCategory.value = selected?.id ?? modelGroups.value[0]?.id ?? ''
  }
}

function toggleUsage() {
  usageOpen.value = !usageOpen.value
  modelOpen.value = false
}

// ── 逆向模式盾牌 ────────────────────────────────────────────────────────
// 直接吃引擎回执的 health，不用本地意图 —— 意图是「用户点了」，
// health 才是「契约真的注入进去了」。两者不一致时用户最需要知道。
const reverseBadge = computed(() => session.reverseHealth)
const reverseBadgeLabel = computed(() => `逆向模式：${reverseBadgeTitle.value}`)
const reverseBadgeTitle = computed(() => {
  switch (reverseBadge.value) {
    case 'active': return `逆向模式运行中（${REVERSE_FLAVOR_SHORT[config.reverseFlavor] ?? config.reverseFlavor}）`
    case 'restricted': return '逆向模式受限：只读权限或无可用模型，契约不会生效'
    case 'broken': return '逆向模式异常：契约校验失败，注入已拒绝'
    default: return '逆向模式未开启'
  }
})

/** §四 环生长：打开 → 下一帧置 grown，各段从 0 沿圆环长出；关闭 → 立刻回收，缩回小圆。 */
watch(usageOpen, open => {
  if (!open) { ringGrown.value = false; return }
  ringGrown.value = false
  requestAnimationFrame(() => requestAnimationFrame(() => { ringGrown.value = true }))
})

// ── 会话标记路径（第三批 5：绑定为会话执行目录）──
function openPathPicker() {
  pathInput.value = session.cwd || ''
  pathNotice.value = ''
  pathPickerOpen.value = true
  usageOpen.value = false
}

function pickPath(path: string) {
  pathInput.value = path
}

async function savePath() {
  const path = pathInput.value.trim()
  if (!path) return
  const ok = await session.setSessionCwd(path)
  pathNotice.value = ok ? '已设置，后续对话将在此目录执行' : '设置失败：路径不存在或引擎不可用'
  if (ok) setTimeout(() => { pathPickerOpen.value = false }, 900)
}

function browseInFileManager() {
  pathPickerOpen.value = false
  router.push('/files')
}
</script>

<template>
  <header class="topbar" :class="{ bare: !hasConversation }">
    <button class="icon-btn" aria-label="会话历史" @click="$emit('menu')">
      <CoomiIcon name="menu" />
    </button>

    <div v-if="hasConversation" class="center title-only">
      <span class="model">{{ chatTitle || config.currentModel }}</span>
      <!-- 进入子代理：主会话 / 子代理名（名字只显示一部分） -->
      <template v-if="focusedSubagentName">
        <span class="slash">/</span>
        <span class="subagent-title">{{ shortSubagent }}</span>
      </template>
      <span v-if="connection.demo" class="demo">演示</span>
      <span v-if="config.planMode" class="plan">计划</span>
    </div>

    <!-- 展开/收起各一条动画：这两块以前是 v-if 硬挂硬摘，关掉的那一帧直接消失，
         看起来就是「菜单没有开合」。<Transition> 让收起也有过程，
         动画类见下方 model-menu-enter-active / -leave-active（第二类语义，forwards）。 -->
    <Teleport to="body">
    <Transition name="model-scrim">
      <button v-if="modelOpen" class="model-scrim" aria-label="关闭模型选择" @click="modelOpen = false" />
    </Transition>
    <Transition name="model-menu">
      <div v-if="modelOpen" class="model-menu">
      <div v-if="modelGroups.length" class="model-tabs" role="tablist" aria-label="按供应商选择模型">
        <button
          v-for="group in modelGroups"
          :key="group.id"
          role="tab"
          :aria-selected="activeModelCategory === group.id"
          :class="{ active: activeModelCategory === group.id }"
          @click="activeModelCategory = group.id"
        >{{ group.label }}</button>
      </div>
      <section class="model-list" role="tabpanel">
        <button
          v-for="item in activeModelGroup.items" :key="item.providerId + ':' + item.model" class="model-row"
          :class="{ selected: item.providerId === config.currentProviderId && item.model === config.currentModel }"
          @click="choose(item.providerId, item.model)"
        >
          <span><b>{{ item.model }}</b><small>{{ item.provider }}</small></span>
          <CoomiIcon v-if="item.providerId === config.currentProviderId && item.model === config.currentModel" name="check" :size="15" />
        </button>
        <p v-if="activeModelGroup.items.length === 0" class="model-empty">{{ modelGroups.length ? '该供应商暂无可用模型' : '暂无已配置供应商' }}</p>
      </section>
      </div>
    </Transition>
    </Teleport>

    <!-- §二 子代理：有子代理才出现（小字 + 向下小符号），展开看运行状态与会话名称 -->
    <div v-if="hasConversation && subagents.length" class="subagent-wrap">
      <button class="subagent-chip" :class="{ running: subagentRunning > 0 }" :aria-expanded="subagentOpen" @click="subagentOpen = !subagentOpen">
        <span>{{ subagents.length }} 个子代理<template v-if="subagentRunning"> · {{ subagentRunning }} 运行中</template></span>
        <CoomiIcon name="chevronDown" :size="12" class="sa-chev" :class="{ open: subagentOpen }" />
      </button>
      <!-- scrim 不能 Teleport 到 body：菜单本身还在 .lid（z-index:2）里，
           根上下文的 scrim（z-index:19）会盖住整块 .lid，点行只会关菜单、
           永远进不了子代理会话页。放在 .subagent-wrap 内与菜单同一层叠
           上下文，菜单 z-index 20 才能压在 scrim 上面。 -->
      <Transition name="usage-scrim">
        <button v-if="subagentOpen" class="usage-scrim" aria-label="关闭子代理列表" @click="subagentOpen = false" />
      </Transition>
      <Transition name="usage-menu">
        <div v-if="subagentOpen" class="subagent-menu">
          <button class="sa-back" @click="subagentOpen = false; $emit('backToMain')">
            <CoomiIcon name="arrowLeft" :size="14" /><span>返回主会话</span>
          </button>
          <button
            v-for="row in subagents"
            :key="row.callId"
            class="sa-row"
            :disabled="!row.agentId"
            @click="subagentOpen = false; row.agentId && $emit('focusSubagent', row.agentId, row.name)"
          >
            <span v-if="row.running" class="sa-spin" aria-label="运行中" />
            <span v-else class="sa-dot" :class="row.status === 'error' || row.status === 'failed' ? 'err' : 'ok'" />
            <span class="sa-name">{{ row.name }}</span>
            <span class="sa-status">{{ !row.agentId ? '等待子代理 id' : (row.running ? '运行中' : (row.status === 'error' || row.status === 'failed' ? '失败' : (row.elapsed != null ? formatSpan(row.elapsed) : '完成'))) }}</span>
          </button>
        </div>
      </Transition>
    </div>

    <button v-if="hasConversation" class="usage-button" :class="{ 'rev-on': reverseBadge !== 'off' }" :aria-expanded="usageOpen" :aria-label="reverseBadge === 'off' ? '上下文用量' : reverseBadgeLabel" @click="toggleUsage">
      <svg class="usage-ring" viewBox="0 0 36 36" aria-hidden="true">
        <circle class="usage-track" cx="18" cy="18" r="15" pathLength="100" />
        <circle
          v-for="seg in segments"
          :key="seg.key"
          class="usage-seg"
          cx="18" cy="18" r="15" pathLength="100"
          :style="{
            stroke: seg.color,
            strokeDasharray: Math.max(0.8, seg.percent - 4) + ' ' + (100 - Math.max(0.8, seg.percent - 4)),
            strokeDashoffset: seg.offset,
          }"
        />
      </svg>
      <!--
        逆向模式盾牌：只在「开着」时出现，关着不占位、不加描边，
        顶栏与改动前完全一致。四态直接映射引擎回执的 health，
        用户不需要猜「到底有没有在跑」。
      -->
      <span v-if="reverseBadge !== 'off'" class="rev-badge" :class="'rev-' + reverseBadge" :title="reverseBadgeTitle">
        <CoomiIcon :name="reverseBadge === 'broken' ? 'shieldAlert' : 'shieldCheck'" :size="9" />
      </span>
    </button>

    <!-- 用量面板与模型菜单是同一个开合模式，一起处理，避免「一个关得动一个关不动」 -->
    <Teleport to="body"><Transition name="usage-scrim">
      <button v-if="usageOpen" class="usage-scrim" aria-label="关闭上下文数据" @click="usageOpen = false" />
    </Transition>
    <Transition name="usage-menu">
      <div v-if="usageOpen" class="usage-menu usage-card">
      <p class="usage-title">上下文用量</p>
      <!-- 左侧大环（由小圆放大而来）+ 右侧关键数字 -->
      <div v-if="session.usage" class="uc-top">
        <div class="uc-ring">
          <svg class="uc-ring-svg" :class="{ grown: ringGrown }" viewBox="0 0 36 36" aria-hidden="true">
            <circle class="usage-track" cx="18" cy="18" r="15" pathLength="100" />
            <circle
              v-for="seg in segments"
              :key="seg.key"
              class="usage-seg"
              cx="18" cy="18" r="15" pathLength="100"
              :style="{
                stroke: seg.color,
                strokeDasharray: ringGrown
                  ? Math.max(0.8, seg.percent - 4) + ' ' + (100 - Math.max(0.8, seg.percent - 4))
                  : '0 100',
                strokeDashoffset: seg.offset,
              }"
            />
          </svg>
          <div class="uc-center"><strong>{{ usagePercent }}%</strong><span>已用</span></div>
        </div>
        <div class="uc-side">
          <div class="uc-line"><span>已用</span><strong>{{ formatTokens(session.usage.contextUsed) }}</strong></div>
          <div class="uc-line"><span>剩余</span><strong>{{ formatTokens(Math.max(0, session.usage.contextWindow - session.usage.contextUsed)) }}</strong></div>
          <div class="uc-line"><span>消息数</span><strong>{{ session.timeline.filter(i => i.kind === 'user' || i.kind === 'assistant').length }}</strong></div>
          <div class="uc-line"><span>主要占用</span><strong>{{ segments[0]?.label ?? '--' }}</strong></div>
        </div>
      </div>
      <div v-if="session.usage && segments.length" class="uc-legend">
        <span v-for="seg in segments" :key="seg.key" class="uc-legend-item">
          <i :style="{ background: seg.color }" />{{ seg.label }} {{ segmentPercentText(seg) }}
        </span>
      </div>
      <div v-if="session.usage" class="uc-detail">
        <p class="usage-subtitle">分段明细</p>
        <div v-for="seg in segments" :key="seg.key" class="uc-detail-row">
          <span class="uc-detail-label"><i :style="{ background: seg.color }" />{{ seg.label }}</span>
          <span class="uc-detail-val">{{ segmentPercentText(seg) }} · {{ formatTokens(seg.tokens) }}</span>
        </div>
      </div>
      <div v-if="session.usage" class="uc-stats">
        <div><span>首次响应</span><strong>{{ formatDuration(session.usage.firstTokenLatencyMs) }}</strong></div>
        <div><span>LLM 用时</span><strong>{{ formatSpan(timing?.llmMs ?? null) }}</strong></div>
        <div><span>工具用时</span><strong>{{ formatSpan(timing?.toolMs ?? null) }}</strong></div>
        <div><span>会话总时长</span><strong>{{ formatSpan(timing?.elapsedMs ?? null) }}</strong></div>
      </div>
      <div v-if="session.usage" class="uc-cache">
        <span>缓存命中（统一）<strong>{{ formatCache(session.usage.cacheHitRate, session.usage.cacheDataAvailable) }}</strong></span>
        <span>本轮<strong>{{ formatTurnCache(session.usage.turnCacheHitRate, session.usage.cacheDataAvailable, session.usage.turnCacheDataAvailable) }}</strong></span>
        <span>输出<strong>{{ session.usage.outputTokensPerSecond == null ? '--' : session.usage.outputTokensPerSecond.toFixed(1) + ' tok/s' }}</strong></span>
      </div>
      <!-- 厂商余额：常驻一行；查不到时显示「当前账户无法查询」，不再整块消失。 -->
      <BalanceCard />
      <p v-if="!session.usage" class="usage-empty">此对话尚无用量数据</p>
      <button class="uc-search" @click="usageOpen = false; $emit('search')">
        <CoomiIcon name="search" :size="15" />
        <span>搜索历史消息</span>
        <span class="uc-search-cap">关键词</span>
      </button>
      <div class="usage-path">
        <span>会话标记路径</span>
        <button class="path-btn" @click="openPathPicker">{{ session.cwd || '点击选择' }}</button>
      </div>
      <div v-if="runtimeInfo" class="usage-env">
        <span>运行环境</span>
        <span class="env-row">
          <em class="env-badge" :class="envBadgeClass">{{ envBadgeLabel }}</em>
          <small v-if="envDetail" class="env-detail">{{ envDetail }}</small>
        </span>
      </div>
      </div>
    </Transition></Teleport>

    <Teleport to="body"><div v-if="pathPickerOpen" class="path-mask enter-flat" @click="pathPickerOpen = false">
      <div class="path-sheet" @click.stop>
        <p class="path-title">会话标记路径</p>
        <p class="path-desc">绑定为当前会话的执行目录，CoomiPlus 将在此目录下工作。</p>
        <input v-model="pathInput" class="path-input" placeholder="输入运行时路径" spellcheck="false" @keyup.enter="savePath" />
        <div class="path-quick">
          <button v-for="p in pathQuickOptions" :key="p" class="chip" @click="pickPath(p)">当前工作目录</button>
          <button class="chip" @click="browseInFileManager">在文件管理器中浏览…</button>
        </div>
        <p v-if="pathNotice" class="path-notice">{{ pathNotice }}</p>
        <div class="path-actions">
          <button class="btn ghost" @click="pathPickerOpen = false">取消</button>
          <button class="btn primary" @click="savePath">设置</button>
        </div>
      </div>
    </div></Teleport>

  </header>
</template>

<style scoped>
/* §九/顶栏规范：分割线彻底去掉，改半透明轻模糊 + 底部 28px 渐隐遮罩 ——
   消息滚到顶栏底部时自然淡出，不再撞硬线。新会话裸态同规则。 */
.topbar.bare { background: transparent; backdrop-filter: none; -webkit-backdrop-filter: none; }
.topbar.bare::after { display: none; }
.center {
  flex: 1 1 auto; min-width: 0; overflow: hidden;
  display: flex; align-items: center; gap: 6px;
  animation: coomi-enter-append var(--enter-append-dur) var(--ease-out) backwards;
}
/* 会话标题可能来自一条很长的用户消息：顶栏必须能收缩并省略，不能把“计划/演示”徽标顶出屏幕。 */
.center .model { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.center .slash, .center .subagent-title, .center .demo, .center .plan { flex: none; }
.topbar {
  position: relative;
  display: flex; align-items: center; gap: var(--sp-2); min-height: calc(var(--safe-top) + 46px);
  padding: var(--safe-top) var(--sp-3) 0;
  background: color-mix(in srgb, var(--bg) 78%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  z-index: var(--z-header);
}
/* 顶栏与消息区的融合：底边向下 36px 渐隐遮罩，起点与顶栏半透明底同色 →
   消息滚到顶栏下方时自然淡出，没有硬边、也没有可辨认的线。 */
.topbar::after {
  content: '';
  position: absolute; left: 0; right: 0; bottom: -36px; height: 36px;
  background: linear-gradient(to bottom,
    color-mix(in srgb, var(--bg) 88%, transparent),
    color-mix(in srgb, var(--bg) 45%, transparent) 45%,
    transparent);
  pointer-events: none;
}
.model-scrim { position: fixed; inset: 0; z-index: calc(var(--z-header) - 1); border: 0; background: transparent; }
.model-menu {
  position: fixed; z-index: var(--z-header); top: calc(var(--safe-top) + 56px); left: 50%;
  width: min(78vw, 300px); max-height: min(52vh, 380px); overflow-y: auto;
  transform: translateX(-50%); padding: 6px; border: 1px solid var(--border);
  border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-2);
}
/* ── 模型菜单的开合：第二类语义（--expand-*，forwards）──
   菜单用 translateX(-50%) 居中，所以不能直接用 global.css 的 .expand-pop
   （它的终帧是 scale(1)，会把居中的 -50% 抹掉）。因此这里保留两条本处专属 keyframes，
   但判定依据与令牌一律照抄 global.css 的「两类动效语义」段：
     · 打开 = 出现 + 展开 → forwards，播完停在 translateX(-50%) scale(1)，
       这正是菜单打开时该有的样子，不会「弹一下又缩回去」；
     · 收起 = forwards，Vue <Transition> 在 leave 动画结束后才摘节点，
       播完那一帧（scale .96 + 透明）就是要停住的那一帧，中间任何回弹都会被看见。
   两条都只动 transform/opacity，所以 .model-row 的 :active 缩放不受影响
   （它们是子元素，不在同一个填充上下文里）。 */
.model-menu-enter-active {
  animation: model-menu-pop var(--expand-open-dur) var(--ease-out) forwards;
}
.model-menu-leave-active {
  animation: model-menu-collapse var(--expand-close-dur) var(--ease-emphasized) forwards;
}
@keyframes model-menu-pop {
  from { opacity: 0; transform: translateX(-50%) scale(.96); }
  to { opacity: 1; transform: translateX(-50%) scale(1); }
}
@keyframes model-menu-collapse {
  from { opacity: 1; transform: translateX(-50%) scale(1); }
  to { opacity: 0; transform: translateX(-50%) scale(.96); }
}
/* 遮罩只淡入淡出：它是 transparent 的，点它等于点外面，不该有位移。 */
.model-scrim-enter-active { animation: coomi-expand-fade var(--expand-open-dur) var(--ease-out) forwards; }
.model-scrim-leave-active { animation: coomi-expand-fade-out var(--expand-close-dur) var(--ease-emphasized) forwards; }
.model-tabs {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(96px, 1fr));
  max-width: 100%; overflow-x: auto; min-height: 42px; border-bottom: 1px solid var(--border);
}
.model-tabs button {
  position: relative; min-width: 0; padding: 0 3px;
  color: var(--text-3); font-size: var(--fs-label); font-weight: 600;
}
.model-tabs button.active { color: var(--blue); }
.model-tabs button.active::after {
  content: ''; position: absolute; right: 18%; bottom: -1px; left: 18%;
  height: 2px; border-radius: 2px; background: var(--blue);
}
.model-list { max-height: min(43vh, 322px); overflow-y: auto; padding-top: 5px; }
.usage-scrim { position: fixed; inset: 0; z-index: calc(var(--z-header) - 1); border: 0; background: transparent; }
.usage-menu {
  position: fixed; z-index: var(--z-header); top: calc(var(--safe-top) + 56px); right: var(--sp-2);
  width: min(92vw, 390px); max-height: min(72vh, 560px); overflow-y: auto; padding: var(--sp-3) 13px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
}
/* 用量面板的开合，与 model-menu 同语义：forwards + 成对方向。
   终帧 transform: none —— 这个面板靠 right 定位、不需要居中偏移，
   所以可以直接用 global.css 的 .expand-pop / .expand-pop-out。 */
.usage-menu-enter-active { animation: coomi-expand-pop var(--expand-open-dur) var(--ease-out) forwards; }
.usage-menu-leave-active { animation: coomi-expand-pop-out var(--expand-close-dur) var(--ease-emphasized) forwards; }
.usage-scrim-enter-active { animation: coomi-expand-fade var(--expand-open-dur) var(--ease-out) forwards; }
.usage-scrim-leave-active { animation: coomi-expand-fade-out var(--expand-close-dur) var(--ease-emphasized) forwards; }
.usage-title { margin: 0 0 var(--sp-2); font-size: var(--fs-label); font-weight: var(--fw-semibold); color: var(--text-2); }
.usage-stats { display: grid; gap: var(--sp-2); }
.usage-stats div { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-3); }
.usage-stats span { font-size: var(--fs-label); color: var(--text-3); }
.usage-stats strong { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text); }
.usage-empty { margin: 0; font-size: var(--fs-label); line-height: 1.5; color: var(--text-3); }
.usage-subtitle { margin: var(--sp-3) 0 6px; padding-top: 10px; border-top: 1px solid var(--border); font-size: var(--fs-caption); font-weight: 600; color: var(--text-2); }
.category-grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap: 5px var(--sp-3); }
.category-grid div { display:flex; justify-content:space-between; gap: var(--sp-2); font-size: var(--fs-caption); }
.category-grid span { color:var(--text-3); }
.category-grid strong { color:var(--text-2); font-family:var(--font-mono); }
.effort-table { display: grid; gap: 1px; font-variant-numeric: tabular-nums; }
.effort-head, .effort-row { display: grid; grid-template-columns: 44px minmax(82px, 1.4fr) 54px 50px; align-items: center; gap: 5px; min-height: 27px; }
.effort-head { color: var(--text-3); font-size: var(--fs-caption); }
.effort-row { border-top: 1px solid var(--border); color: var(--text-2); font-size: var(--fs-caption); }
.effort-head span:not(:first-child), .effort-row span:not(:first-child) { text-align: right; }
.usage-path {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  margin-top: 10px; padding-top: 9px; border-top: 1px solid var(--border);
}
.usage-path span { font-size: var(--fs-label); color: var(--text-3); flex-shrink: 0; }
.usage-env {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  margin-top: 6px; padding-top: 9px; border-top: 1px solid var(--border);
}
.usage-env > span { font-size: var(--fs-label); color: var(--text-3); flex-shrink: 0; }
.usage-env .env-row { display: flex; flex-direction: column; gap: 3px; align-items: flex-end; min-width: 0; }
.env-badge {
  font-style: normal; font-size: var(--fs-caption); padding: 3px 9px; border-radius: var(--r-pill);
  white-space: nowrap;
}
.env-badge.ok { background: var(--ok-soft, #e8f5ee); color: var(--ok, #18794e); }
.env-badge.warn { background: var(--warn-soft, #fdf3e2); color: var(--focus, #b4690e); }
.env-badge.down { background: var(--fill); color: var(--text-3); }
.env-detail { font-size: var(--fs-caption); color: var(--text-3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 220px; }
.path-btn {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--blue);
  background: var(--blue-soft); border-radius: var(--r-sm); padding: 5px 9px;
}
.path-mask { position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(0, 0, 0, 0.4); display: flex; align-items: flex-end; }
.path-sheet {
  width: 100%;
  background: var(--bg-card);
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  padding: 18px var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  /* 底部弹层入场：rise（100% 上滑，已收敛 global.css），遮罩淡入由 .enter-flat 类负责 */
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.path-title { margin: 0; font-size: var(--fs-strong); font-weight: 600; }
.path-desc { margin: var(--sp-1) 0 var(--sp-3); font-size: var(--fs-label); color: var(--text-3); }
.path-input {
  width: 100%; min-height: 44px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--bg-input);
  color: var(--text);
  font-family: var(--font-mono);
  font-size: var(--fs-label);
}
.path-quick { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-3); }
.chip {
  padding: 6px var(--sp-3);
  border-radius: var(--r-pill);
  background: var(--fill-strong);
  color: var(--text-2);
  font-size: var(--fs-label);
}
.path-notice { margin: 10px 0 0; font-size: var(--fs-label); color: var(--ok); }
.path-actions { display: flex; gap: 10px; margin-top: var(--sp-4); }
.path-actions .btn { flex: 1; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.model-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; min-height: 38px; padding: 7px 9px; border: 0; border-radius: var(--r-sm); background: none; color: var(--text); text-align: left; }
.model-row span { display: flex; flex: 1; min-width: 0; flex-direction: column; overflow: hidden; }
.model-row b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-label); font-weight: 500; }
.model-row small { overflow: hidden; color: var(--text-3); font-size: var(--fs-caption); text-overflow: ellipsis; white-space: nowrap; }
.model-row.selected { background: var(--blue-soft); color: var(--blue); }
.model-row:active { background: var(--fill-press); }
.model-empty { padding: var(--sp-4) 10px; text-align: center; font-size: var(--fs-label); color: var(--text-3); }
/* 左右两侧的操作统一 44×44 触达区，图标 20（CoomiIcon 默认尺寸） */
/* 顶栏按钮规范：完整圆形按钮（描边 + 浅底 + 按压反馈），不再是裸图标。 */
.icon-btn {
  display: grid; place-items: center; flex-shrink: 0;
  width: 44px; height: 44px;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--fill); color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.icon-btn:active { background: var(--fill-press); color: var(--blue); }
.usage-button {
  position: relative; display: grid; place-items: center; flex-shrink: 0;
  width: 44px; height: 44px;
  border: 1px solid var(--border); border-radius: 50%;
  background: var(--fill); color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out);
}
.usage-button:active { background: var(--fill-press); }

/* 逆向模式盾牌：钉在用量环的右下角，2px 描边用页面背景色把它从环上"抠"出来。 */
.rev-badge {
  position: absolute; right: -1px; bottom: -1px;
  display: grid; place-items: center;
  width: 16px; height: 16px;
  border-radius: 50%;
  background: var(--bg);
  border: 2px solid var(--bg);
  color: var(--blue);
  pointer-events: none;
}
.rev-badge.rev-active { color: var(--blue); }
.rev-badge.rev-restricted { color: var(--orange); }
.rev-badge.rev-broken { color: var(--danger); }
.usage-button.rev-on { border-color: var(--blue-border); }
.usage-ring { width: 30px; height: 30px; transform: rotate(-90deg); }
/* §四 分段环：每类一种颜色，从顶端沿圆环依次增长（dasharray/dashoffset 过渡）。 */
/* 分段：更粗 + 圆角端帽（现代分段环的通用观感），段间留 1.2% 间隙 */
.usage-seg {
  fill: none; stroke-width: 3.4; stroke-linecap: round;
  transition: stroke-dasharray .5s var(--ease-out), stroke-dashoffset .5s var(--ease-out);
}
.usage-ring .usage-seg { stroke-width: 2.6; }
.usage-ring .usage-track { stroke-width: 3.4; }

/* §二 子代理：顶栏小字 + 向下小符号，展开小列表 */
.subagent-wrap { position: relative; flex: none; }
.subagent-chip {
  display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 32px; padding: 0 var(--sp-2);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-label); font-weight: 600; white-space: nowrap;
}
.subagent-chip.running { color: var(--blue); border-color: var(--blue-border); background: var(--blue-soft); }
.sa-chev { transition: transform var(--dur-base) var(--ease-out); }
.sa-chev.open { transform: rotate(180deg); }
.subagent-menu {
  position: absolute; z-index: var(--z-header); top: calc(100% + 6px); right: 0;
  width: min(76vw, 280px); max-height: min(52vh, 320px); overflow-y: auto;
  padding: 6px; border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
}
.sa-back {
  display: flex; align-items: center; gap: var(--sp-1); width: 100%;
  padding: var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-label); font-weight: 600; text-align: left;
}
.sa-back:active { background: var(--fill-press); }
.sa-row { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: 9px var(--sp-2); border: 0; border-radius: var(--r-sm); background: none; text-align: left; }
.sa-row:active { background: var(--fill-press); }
.sa-row[disabled] { opacity: .55; }
.sa-dot { flex: none; width: 7px; height: 7px; border-radius: 50%; background: var(--border-strong); }
.sa-dot.ok { background: var(--ok); }
.sa-dot.err { background: var(--danger); }
.sa-spin {
  flex: none; width: 10px; height: 10px;
  border: 1.6px solid color-mix(in srgb, var(--blue) 28%, transparent);
  border-top-color: var(--blue); border-radius: 50%;
  animation: sa-spin .8s linear infinite;
}
@keyframes sa-spin { to { transform: rotate(360deg); } }
@media (prefers-reduced-motion: reduce) { .sa-spin { animation-duration: 2.4s; } }
.sa-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sub); color: var(--text); }
.sa-status { flex: none; font-size: var(--fs-caption); color: var(--text-3); }

/* §四 用量卡片：左大环（由小圆放大）+ 右侧数字 / 图例 / 分段明细 / 时间统计 */
.usage-card { width: min(92vw, 360px); }
.uc-top { display: flex; align-items: center; gap: var(--sp-3); margin: var(--sp-2) 0; }
.uc-ring { position: relative; flex: none; width: 104px; height: 104px; }
/* 内圈柔面：环里不是空的，也不是黑的 —— 一层与卡片同色的浅面。 */
.uc-ring::before {
  content: ''; position: absolute; inset: 16%; border-radius: 50%;
  background: color-mix(in srgb, var(--fill) 70%, transparent);
}
.uc-ring-svg {
  width: 100%; height: 100%;
  transform: rotate(-90deg) scale(1);
  transform-origin: 50% 50%;
  transition: transform .34s var(--ease-out), opacity .3s var(--ease-out);
}
.uc-ring-svg:not(.grown) { transform: rotate(-90deg) scale(.26); opacity: .35; }
.uc-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 1px; }
.uc-center strong { font-size: var(--fs-title); font-weight: 700; color: var(--text); }
.uc-center span { font-size: var(--fs-caption); color: var(--text-3); }
.uc-side { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.uc-line { display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2); }
.uc-line span { font-size: var(--fs-label); color: var(--text-3); }
.uc-line strong { font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text); }
.uc-legend { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); margin-bottom: var(--sp-2); }
.uc-legend-item { display: inline-flex; align-items: center; gap: var(--sp-1); font-size: var(--fs-caption); color: var(--text-2); }
.uc-legend-item i { width: 8px; height: 8px; border-radius: 2px; }
.uc-detail-row { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding: 5px 0; }
.uc-detail-label { display: inline-flex; align-items: center; gap: 6px; font-size: var(--fs-sub); color: var(--text-2); }
.uc-detail-label i { width: 8px; height: 8px; border-radius: 2px; }
.uc-detail-val { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-3); }
.uc-stats {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2) var(--sp-3);
  padding-top: var(--sp-2); margin-top: var(--sp-2);
  border-top: 1px solid var(--border);
}
.uc-stats div { display: flex; flex-direction: column; gap: 2px; }
.uc-stats span { font-size: var(--fs-caption); color: var(--text-3); }
.uc-stats strong { font-size: var(--fs-sub); color: var(--text); }
.uc-cache { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-3); margin-top: var(--sp-2); }
.uc-cache span { font-size: var(--fs-caption); color: var(--text-3); }

/* 用量卡片里的搜索入口 */
.uc-search {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  margin-top: var(--sp-2); padding: 10px var(--sp-2);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600; text-align: left;
}
.uc-search:active { background: var(--fill-press); color: var(--blue); }
.uc-search .uc-search-cap { margin-left: auto; font-size: var(--fs-caption); font-weight: 500; color: var(--text-3); }
.usage-ring circle { fill: none; stroke-width: 3.8; }
/* 轨道：低对比中性色 —— 用文字色的低透明度混出来，明暗两态都不发黑
   （对齐 Material 3 的 surfaceVariant 轨道 / Ant Design 的 rgba(0,0,0,.06) 轨道思路）。 */
/* fill:none 必须有：漏了它，SVG circle 会按默认黑色填充 —— 就是「用量圈里面是黑的」那团黑盘。 */
.usage-track { fill: none; stroke: color-mix(in srgb, var(--text) 10%, transparent); }
.uc-ring-svg circle { fill: none; }
/* 大环：灰轨道恒宽于彩段（彩段必须落在灰圈内） */
.uc-ring-svg .usage-track { stroke-width: 4.4; stroke-linecap: butt; }
.uc-ring-svg .usage-seg { stroke-width: 3.4; }
.usage-value { stroke: var(--blue); stroke-linecap: round; transition: stroke-dasharray var(--dur-base) var(--ease-out); }

/* 顶栏顺序：侧边栏按钮 → 会话标题（紧挨其右、左对齐）→ … → 用量小圆（最右）。 */
.center {
  flex: 1; min-width: 0;
  display: inline-flex; align-items: center; justify-content: flex-start; gap: var(--sp-1);
  height: 40px; padding: 0 var(--sp-2) 0 2px;
  border: 0; border-radius: var(--r-pill); background: none; color: var(--text);
  text-align: left;
}
/* 标题只占一条窄带：字号小一档、最多半屏，右侧留给空白，不再把整条顶栏塞满。 */
.model {
  font-size: var(--fs-sub); font-weight: var(--fw-semibold); letter-spacing: -.1px;
  max-width: 52vw;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.slash { flex: none; color: var(--text-3); font-weight: 400; }
.subagent-title {
  min-width: 0; max-width: 40%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  color: var(--text-2); font-weight: var(--fw-semibold);
  animation: coomi-enter-append var(--enter-append-dur) var(--ease-out) backwards;
}
.plan {
  flex-shrink: 0; padding: 2px 7px; border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-caption); font-weight: var(--fw-semibold);
}
/* 演示标记用点缀橙，和蓝色的功能性标记（计划）区分开。 */
.demo {
  flex-shrink: 0; padding: 2px 7px; border-radius: var(--r-pill);
  background: var(--orange-soft); color: var(--orange);
  font-size: var(--fs-caption); font-weight: var(--fw-semibold);
}
.caret { color: var(--text-3); }


@media (prefers-reduced-motion: reduce) {
  /* 路径弹层直接出现 */
  .path-sheet { animation: none; }
  /* 菜单开合降级：终态必须写死，否则 leave 方向会停在「打开」那一帧、面板关不掉 */
  .model-menu-enter-active, .usage-menu-enter-active,
  .model-scrim-enter-active, .usage-scrim-enter-active { animation: none; opacity: 1; transform: none; }
  .model-menu-leave-active, .usage-menu-leave-active,
  .model-scrim-leave-active, .usage-scrim-leave-active { animation: none; opacity: 0; }
}
:root[data-motion='off'] .path-sheet { animation: none; }
:root[data-motion='off'] .model-menu-enter-active, :root[data-motion='off'] .usage-menu-enter-active,
:root[data-motion='off'] .model-scrim-enter-active, :root[data-motion='off'] .usage-scrim-enter-active { animation: none; opacity: 1; transform: none; }
:root[data-motion='off'] .model-menu-leave-active, :root[data-motion='off'] .usage-menu-leave-active,
:root[data-motion='off'] .model-scrim-leave-active, :root[data-motion='off'] .usage-scrim-leave-active { animation: none; opacity: 0; }
</style>
