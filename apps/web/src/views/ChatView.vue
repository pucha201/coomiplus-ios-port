<script setup lang="ts">
/**
 * 主聊天窗口。
 *
 * 三件事和别处不一样：
 * 1) 抽屉打开时整个 shell 往右推 + 轻微缩放，是 DeepSeek 的那种层次感；
 * 2) 跟随滚动交给 useAutoScroll，高度变化用 ResizeObserver 兜住 ——
 *    markdown 重排、工具卡展开、软键盘弹出都会改高度，只 watch 数组长度会漏；
 * 3) 连续的工具调用合并成一个 ToolGroup，避免长任务把时间线冲成一堵卡片墙。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import { useDeviceStore } from '@/stores/device'
import { apiGet } from '@/bridge/http'
import { DEMO_PROMPT, isUnattended, shouldAutoplay } from '@/bridge/demoMode'
import { useAutoScroll } from '@/composables/useAutoScroll'
import { nativeImeInset } from '@/utils/keyboardInset'
import { blockIndexOfMessage, buildTimelineBlocks, reuseTimelineBlocks, type TimelineBlockItem } from '@/utils/chatTimeline'
import type { ApprovalDecision } from '@/protocol/commands'
import type { UserQuestion } from '@/protocol/events'
import TopBar from '@/components/TopBar.vue'
import SideDrawer from '@/components/SideDrawer.vue'
import StatusBar from '@/components/StatusBar.vue'
import { reportFlyTo } from '@/components/logoFly'
import Composer from '@/components/Composer.vue'
import EmptyState from '@/components/EmptyState.vue'
import TimelineBlock from '@/components/TimelineBlock.vue'
import HistoryDial from '@/components/HistoryDial.vue'
import type { DialTarget } from '@/components/HistoryDial.vue'
import HistorySearch from '@/components/HistorySearch.vue'
import SubagentChat from '@/components/SubagentChat.vue'
import type { SearchItem } from '@/components/HistorySearch.vue'
import LoopProgressBar from '@/components/LoopProgressBar.vue'
import ApprovalSheet from '@/components/ApprovalSheet.vue'
import QuestionSheet from '@/components/QuestionSheet.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const session = useSessionStore()
const sessions = useSessionsStore()
const config = useConfigStore()
const device = useDeviceStore()

const scroller = ref<HTMLElement | null>(null)
const virtualScroller = ref<InstanceType<typeof DynamicScroller> | null>(null)
/** 空状态使用 main，时间线挂载后切换到 DynamicScroller 自己的滚动容器。 */
const scrollHost = ref<HTMLElement | null>(null)
const drawerOpen = ref(false)
const isTablet = ref(false)
let tabletMedia: MediaQueryList | null = null
let tabletInit = false
/**
 * 平板（真·大屏）走静态两栏，不参与滑盖动画。
 *
 * 判断不能只看「宽度 ≥ 768 且横屏」：手机横屏（844×390）宽度就超过 768，
 * 会被误判成平板 → 走静态两栏 → 侧栏展开没有动画，正是「横屏适配不好」的来源。
 *
 * 真正的区别在**短边**：手机短边约 360–430，平板短边至少 600。
 * 所以这里叠加一条 shortEdge >= 600，手机横屏仍然走滑盖动画。
 */
const TABLET_MIN_SHORT_EDGE = 600
/**
 * 横屏 / 平板：一律静态双栏，侧栏滑盖动画整体关掉。
 *
 * 手机横屏短边只有 390~430，按旧逻辑仍走滑盖，但横向空间足够并排显示，
 * 推拉动画在这里只会让人等；判据改为「宽 ≥ 768 且高 < 宽」（横屏）或平板短边 ≥ 600。
 */
const applyTablet = () => {
  const portrait = window.innerHeight >= window.innerWidth
  const shortEdge = Math.min(window.innerWidth, window.innerHeight)
  const landscape = window.innerWidth >= 768 && !portrait
  const tablet = tabletMedia?.matches === true && shortEdge >= TABLET_MIN_SHORT_EDGE
  isTablet.value = landscape || tablet
  if (isTablet.value && !tabletInit) { tabletInit = true; drawerOpen.value = true }
}
/// 抽屉推拉期间（含退场动画播完）才为 true：
/// will-change 只在这段时间挂上。常驻会让浏览器永久保留一个 transform 合成层，
/// 切会话时消息列表整体重挂载替换该层内容 → WebView 重新合成 → 整屏闪一下。
const drawerPushing = ref(false)
let pushTimer: number | undefined
function setDrawerPushing(on: boolean): void {
  window.clearTimeout(pushTimer)
  if (on) { drawerPushing.value = true; return }
  // 退场动画时长（--dur-slow）+ 一小段余量，播完再摘
  let ms = 320
  try {
    const v = Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--dur-slow'))
    if (Number.isFinite(v) && v > 0) ms = v
  } catch { /* 读不到就用默认 */ }
  pushTimer = window.setTimeout(() => { drawerPushing.value = false }, ms + 60)
}
/** 全局轮询「后台运行中」状态的定时器（会话列表转圈的数据源）。 */
let runningPoll: ReturnType<typeof setTimeout> | null = null
let visibilityHandler: (() => void) | null = null
let pollActive = true
const openSessionFromNative = (event: Event) => {
  const id = (event as CustomEvent<{ sessionId?: string }>).detail?.sessionId
  if (id) void session.openSession(id)
}

const { following, pinNow, requestFollow, jumpToBottom } = useAutoScroll(scrollHost)

/**
 * 键盘高度变化时，如果正处在跟随态，把视口重新钉到底部。
 *
 * transform 模式下消息区不再缩高，而是靠底部 padding 扩展滚动范围 ——
 * 不补这一下，最后一条会被抬起来的输入栏盖住半行。
 */
watch(nativeImeInset, () => {
  if (!following.value) return
  requestAnimationFrame(() => pinNow())
})

/**
 * 会话切换的「揭幕门」。
 *
 * 切会话时列表先整块 visibility:hidden（保留布局，所以照样能量高度），
 * 等三件事都成立再显示：
 *   1) 引擎历史恢复结束（session.restoring === false）；
 *   2) 虚拟列表把可见条目测量完（$_undefinedSizes === 0，插件自己的收尾信号）；
 *   3) 连续两帧保持稳定。
 * 最多等 REVEAL_MAX_MS，超时也显示（宁可偶尔位置差一点，不能白屏）。
 *
 * 为什么不用 opacity 淡入：淡入会让用户看见「旧内容还在 → 新内容逐条冒出来」；
 * 隐藏期间位置已经在幕布后摆到真正的底部，揭幕就是一次完成的换页。
 */
const REVEAL_MAX_MS = 1200
const revealed = ref(false)
let revealToken = 0

function nextFrame(): Promise<void> {
  return new Promise(resolve => requestAnimationFrame(() => resolve()))
}

/**
 * 输入框跨档变高/变矮：消息区可视高度跟着变。
 * 贴底跟随中不用管（本来就钉在底部）；用户正在看历史时补一次 scrollTop，
 * 否则上面正在看的消息会整块位移。
 */
function onComposerResized(event: Event): void {
  const delta = Number((event as CustomEvent<{ delta?: number }>).detail?.delta ?? 0)
  if (!delta || following.value) return
  if (scroller.value) scroller.value.scrollTop += delta
}

/** vue-virtual-scroller 的「还没量到高度的可见条目数」：它自己的 scrollToBottom 也用它收尾。 */
function undefinedSizes(): number {
  const list = virtualScroller.value as unknown as { $_undefinedSizes?: number } | null
  return list?.$_undefinedSizes ?? 0
}

function syncScrollHost() {
  const el = virtualScroller.value?.$el
  scrollHost.value = el instanceof HTMLElement ? el : scroller.value
}

async function revealWhenSettled(token: number) {
  const deadline = performance.now() + REVEAL_MAX_MS
  following.value = true
  // 刚拿到目标会话的时间线：先同步贴一次底。以前要等两帧才 pinNow，
  // 那两帧就是切会话时「先空一拍、再落下」的来源。
  syncScrollHost()
  pinNow()
  // 1) 等恢复态结束：期间时间线可能还是本机缓存，甚至随后会被引擎历史整表替换。
  while (session.restoring && performance.now() < deadline) {
    await nextFrame()
    if (token !== revealToken) return
  }
  syncScrollHost()
  await nextTick()
  if (token !== revealToken) return
  // 2) 先把视口摆到尾部：虚拟列表只渲染视口附近的条目，不先到底部就量不到最后几条，
  //    那些条目会在揭幕之后才测量 → 用户看见的是「展开后又往上顶一下」。
  pinNow()
  // 3) 等测量稳定：每帧继续贴底（懒测量把尾部尺寸改大时跟着走），
  //    连续两帧没有未测量条目才揭幕。空时间线不需要测量，直接算稳定。
  let stable = 0
  while (performance.now() < deadline) {
    await nextFrame()
    if (token !== revealToken) return
    pinNow()
    if (session.timeline.length === 0 || undefinedSizes() === 0) stable += 1
    else stable = 0
    // 一帧稳定即可揭幕：无未测量条目时不会再有位置变化，
    // 原来的两帧等待只是让「切换」多空转 16ms。
    if (stable >= 1) break
  }
  if (token !== revealToken) return
  // 4) 最后再贴一次（插件的补偿可能晚一帧），然后揭幕。
  syncScrollHost()
  pinNow()
  await nextFrame()
  if (token !== revealToken) return
  pinNow()
  revealed.value = true
}

// 换会话立刻落幕（sync 之前已经 flush：这里是 pre，先于这帧渲染）。
// 提前自增 token：上一轮还在 await 的揭幕流程会被下面的 token 校验挡掉。
watch(() => session.sessionId, () => {
  revealed.value = false
  // 旧会话的滚动偏移会带进新列表：先归零再测量，省掉一帧「先跳到旧位置再回底」。
  if (scroller.value) scroller.value.scrollTop = 0
  revealToken += 1
  const token = revealToken
  void nextTick(() => { void revealWhenSettled(token) })
}, { immediate: true })

onBeforeUnmount(() => {
  window.removeEventListener('coomi:composer-resized', onComposerResized)

  // 带着打开的抽屉离开对话页会让补丁停留在 f=1：点击层还在 body 上，
  // 其它页面右侧的点击都会先被它吞掉。离开前先把开合状态交还给补丁归零。
  if (drawerOpen.value) closeDrawer()
  const drawerApi = (window as unknown as { __coomiDrawer?: { reset?: () => void } }).__coomiDrawer
  drawerApi?.reset?.()
  window.dispatchEvent(new Event('coomi:drawer-sync'))
  if (tabletMedia) tabletMedia.removeEventListener('change', applyTablet)
  window.removeEventListener('resize', applyTablet)
  window.removeEventListener('orientationchange', applyTablet)
  revealToken += 1
})

/**
 * 逐字揭示（rAF）不经过 Vue 的响应式更新 —— 用轻量事件驱动跟随，保证页面自己往下滑。
 * 跟随本身交给 useAutoScroll：这里只在「贴底状态」下请求一帧内贴底。
 */
function onRevealTick() {
  requestFollow()
}
window.addEventListener('coomi:reveal-tick', onRevealTick)
onBeforeUnmount(() => window.removeEventListener('coomi:reveal-tick', onRevealTick))

let previousBlocks: TimelineBlockItem[] = []
const blocks = computed<TimelineBlockItem[]>(() => {
  // 历史块按 key 复用旧对象：流式时只有正在长的那一块重渲染，
  // 长对话不会每个 chunk 把整条时间线重新 diff 一遍。
  previousBlocks = reuseTimelineBlocks(previousBlocks, buildTimelineBlocks(session.timeline))
  return previousBlocks
})

/** §三 刻度盘锚点：每条用户消息 = 一个跳转目标（含它在虚拟列表里的块序号）。 */
const historyTargets = computed<DialTarget[]>(() => {  const out: DialTarget[] = []
  blocks.value.forEach((block, index) => {
    if (block.t !== 'one' || block.item.kind !== 'user') return
    const text = block.item.content.trim()
    if (!text) return
    const next = blocks.value[index + 1]
    const reply = next && next.t === 'one' && next.item.kind === 'assistant'
      ? (next.item.content || '').trim().split('\n').slice(0, 2).join(' ').slice(0, 80)
      : ''
    const at = (block.item as unknown as { createdAt?: number }).createdAt
    // blockIndex 是打开转盘那一刻的快照；流式重组会让它失效，所以同时带上消息 id，
    // 跳转时优先按 id 重新定位（见 onDialJump → resolveBlockIndex）。
    const messageId = (block.item as { id?: string }).id
    out.push({ blockIndex: index, messageId, title: text.split('\n')[0].slice(0, 40) || '新对话', text, reply, at })
  })
  return out
})

/** 刻度盘选中项 → 背景对话滚到对应消息（并脱离贴底跟随：用户正在看历史）。 */
function onDialJump(targetIndex: number) {
  const target = historyTargets.value[targetIndex]
  if (!target) return
  scrollToBlock(resolveBlockIndex(target.messageId, target.blockIndex))
}

/**
 * 滚到某个 block 并脱离贴底跟随。
 * 三档回退：scrollToIndex → scrollToItem → 等一帧用 data-index 做 DOM 定位，
 * 保证虚拟列表 API 变更时跳转依然生效（之前子代理点进去不动就是这个原因）。
 */
/** blockIndex 是转盘/搜索打开那一刻的快照；流式重组会改变块序号，优先按消息 id 重找。 */
function resolveBlockIndex(messageId: string | undefined, fallback: number): number {
  if (!messageId) return fallback
  const index = blockIndexOfMessage(blocks.value, messageId)
  return index >= 0 ? index : fallback
}

function scrollToBlock(blockIndex: number) {
  following.value = false
  // DynamicScroller 的公开 API 是 scrollToItem(index)；以前按名字探测
  // scrollToIndex/scrollToItem 且只看 70ms 后的 DOM，远距离跳转经常找不到节点 → 静默失败。
  const scroller = virtualScroller.value as unknown as { scrollToItem?: (index: number) => void } | null
  const host = scrollHost.value
  if (!host) return
  // 远距离跳转：先把视口按比例挪到目标附近。虚拟列表对没量过高度的远端项
  // 只能估，直接 scrollToItem 经常停在列表头/尾；先粗定位，附近的项被量到后
  // 再 scrollToItem 就能一次对准。
  const total = blocks.value.length
  if (total > 1 && blockIndex > 4) {
    const ratio = blockIndex / Math.max(total - 1, 1)
    host.scrollTop = Math.max(0, (host.scrollHeight - host.clientHeight) * ratio)
  }
  requestAnimationFrame(() => scroller?.scrollToItem?.(blockIndex))
  let attempts = 0
  const tryReveal = () => {
    attempts += 1
    const target = host.querySelector(`[data-index="${blockIndex}"]`)
    if (target instanceof HTMLElement) {
      // 在虚拟列表内部居中，不调用 scrollIntoView —— 后者会连带外层容器一起滚。
      const targetRect = target.getBoundingClientRect()
      const hostRect = host.getBoundingClientRect()
      host.scrollTop += targetRect.top - hostRect.top - (host.clientHeight - targetRect.height) / 2
      return
    }
    if (attempts < 20) window.setTimeout(tryReveal, 80)
  }
  window.setTimeout(tryReveal, 40)
}

/* ── §二 子代理：从顶栏点条目 → 跳到对话里那次调用；顶栏下方「返回主会话」拉回最新 ── */
/** 当前聚焦的子代理（顶栏显示成「主会话 / 子代理名」）。 */
/** agentId = 引擎侧子代理 id（拉它的会话用），name 供顶栏「主会话 / 子代理名」展示。 */
const focusedSubagent = ref<{ agentId: string; name: string } | null>(null)
const subagentFocused = computed(() => focusedSubagent.value !== null)
/**
 * 进入子代理：打开它的会话视图（引擎 GET /api/agents/{id}/messages）。
 * 以前这里是「滚到那次调用的工具卡」，用户看不到子代理自己的消息 —— 现在直接进会话页。
 */
function onFocusSubagent(agentId: string, name: string) {
  if (!agentId) return
  focusedSubagent.value = { agentId, name }
}
function onBackToMain() {
  focusedSubagent.value = null
  following.value = true
  jumpToBottom()
}

/* ── §四 历史消息搜索：命中项 = 用户/助手消息（点结果跳转） ── */
const searchOpen = ref(false)
const searchItems = computed<SearchItem[]>(() => {
  const out: SearchItem[] = []
  blocks.value.forEach((block, index) => {
    if (block.t === 'one') {
      const item = block.item
      if (item.kind === 'user' || item.kind === 'assistant') {
        const text = item.content.trim()
        if (text) out.push({ blockIndex: index, messageId: item.id, kind: item.kind, text })
      }
      return
    }
    if (block.t === 'turn' && block.answer) {
      const text = block.answer.content.trim()
      if (text) out.push({ blockIndex: index, messageId: block.answer.id, kind: 'assistant', text })
    }
  })
  return out
})

/** retry_confirmation 卡片的机器可读现场：轮次 / 最后在跑的工具 / 原因。 */
const retryMeta = computed(() => {
  const rc = session.retryConfirmation
  if (!rc) return ''
  const parts: string[] = []
  if (rc.roundsUsed != null) {
    // 工具次数已不设上限：不再展示「N/上限」，只报已经跑了多少轮。
    parts.push(`已执行 ${rc.roundsUsed} 轮工具调用`)
  }
  if (rc.lastTool) parts.push(`最后在跑：${rc.lastTool}`)
  if (rc.reason === 'tool_round_ceiling') parts.push('安全上限触发（疑似空转）')
  else if (rc.reason === 'turn_budget') parts.push('执行时间/用量已达上限')
  else if (rc.reason === 'upstream_unavailable') parts.push('上游服务不可用')
  return parts.join(' · ')
})
/** 引擎给的 detail 可能很长：只取首行前 220 字，与桌面端同一处理。 */
const retryDetail = computed(() => {
  const detail = session.retryConfirmation?.detail ?? ''
  return detail ? detail.split('\n')[0].slice(0, 220) : ''
})

/**
 * 当前是否有可用的引擎端点。云端未选电脑时没有端点，
 * 相对的 /api 请求会落回本地引擎 —— 那些请求必须停手，否则本地数据会混进云端界面。
 */
const engineReachable = computed(() =>
  device.mode === 'local' || Boolean(device.deviceId && device.engineBase),
)

function syncDigitalLifeMode() {
  if (!engineReachable.value) return
  config.syncDigitalLifeEnabled()
  if (!session.isBusy) session.syncLifeMode()
}

let ro: ResizeObserver | null = null
let observedHost: HTMLElement | null = null
let observedWrapper: HTMLElement | null = null

/**
 * 只观察「滚动宿主 + 它的内容层」：
 * 内容长高（流式正文、工具卡展开/收起、落定折叠）→ requestFollow 在下一帧贴底；
 * 宿主自身 resize（键盘、横竖屏、抽屉推拉）同理。
 * 尺寸补偿由 DynamicScroller 自己负责（itemsWithSize），这里不再做任何 scrollTop 计算。
 */
function observeHost() {
  if (!ro) return
  const host = scrollHost.value
  const wrapper = host?.querySelector<HTMLElement>('.vue-recycle-scroller__item-wrapper') ?? null
  if (host !== observedHost) {
    if (observedHost) ro.unobserve(observedHost)
    observedHost = host
    if (host) ro.observe(host)
  }
  if (wrapper !== observedWrapper) {
    if (observedWrapper) ro.unobserve(observedWrapper)
    observedWrapper = wrapper
    if (wrapper) ro.observe(wrapper)
  }
}

onMounted(() => {
  resetDrawerWhenClosed()
  const resumeFromBackground = () => {
    if (document.visibilityState === 'hidden') return
    if (drawerOpen.value) closeDrawer()
    resetDrawerWhenClosed()
  }
  window.addEventListener('focus', resumeFromBackground)
  document.addEventListener('visibilitychange', resumeFromBackground)
  tabletMedia = window.matchMedia('(min-width: 768px) and (orientation: landscape)')
  applyTablet()
  tabletMedia.addEventListener('change', applyTablet)
  // 媒体查询只覆盖「跨过 768」这两种情况，横竖屏互转时宽度可能一直在 768 以上，
  // 查询不会触发 change —— 但 shortEdge 变了，平板判定也该跟着重算。
  window.addEventListener('resize', applyTablet)
  window.addEventListener('orientationchange', applyTablet)
  session.connect()
  window.addEventListener('coomi:open-session', openSessionFromNative)
  document.addEventListener('touchstart', onDocTouchStart, { passive: true })
  document.addEventListener('touchmove', onDocTouchMove, { passive: true })
  document.addEventListener('touchend', onDocTouchEnd, { passive: true })
  document.addEventListener('touchcancel', onDocTouchEnd, { passive: true })
  window.addEventListener('coomi:flush-persistence', session.flushPersistence)
  window.addEventListener('coomi:composer-resized', onComposerResized)
  // 记录引擎当前工作目录，会话列表据此把不同项目的会话隔离开。
  if (engineReachable.value) {
    void apiGet<{
      cwd?: string
      guest_aliases?: boolean
      paths?: { workspace?: string; runtime_home?: string; build_kit?: string; tmp?: string; inbox?: string }
    }>('/api/runtime/health')
      .then(h => {
        if (!h?.cwd) return
        sessions.setCurrentCwd(h.cwd)
        // guest 别名映射只对安卓有意义：桌面端 /tmp、/workspace 就是真实路径。
        sessions.setEnginePaths({
          runtimeHome: h.paths?.runtime_home,
          buildKit: h.paths?.build_kit,
          tmp: h.paths?.tmp,
          inbox: h.paths?.inbox,
          guest: h.guest_aliases === true,
        })
        // 会话还没有自己的 cwd 时**不借根目录**：那会让冷启动首帧先显示根目录，
        // 随后再跳到 <root>/<session-id>（用户看到的「重启闪回」）。
        // 目录未定时宁可不显示，等 openSession / workspace 接口给出真实值。
      })
      .catch(() => { /* 引擎未就绪时保持空 cwd，列表退化为全部显示 */ })
  }
  // 上下文切换统一由 App 级 useConnectionContext 处理（任何页面切换都生效）。
  // 全局记忆开关以引擎为权威：启动即同步，避免「开关显示关、引擎实际开」的脱节。
  if (engineReachable.value) void config.syncGlobalMemoryFromEngine()
  syncDigitalLifeMode()
  window.addEventListener('focus', syncDigitalLifeMode)
  // 全局轮询各会话的「后台运行中」状态：切走会话后任务在引擎侧继续跑，
  // 抽屉/会话页据此显示转圈。轮询常驻（本地 API 开销极小），不依赖抽屉打开。
  if (engineReachable.value) void sessions.refreshRunning()
  /**
   * 后台状态轮询：自适应间隔 + 页面不可见时暂停。
   *
   * 旧实现是固定 2 秒一次、永远在跑 —— 每个 tick 都发 HTTP、parse JSON、
   * 重建 Set/数组，让侧栏与顶栏跟着重算。手机在其他 App 里时这些工作在
   * WebView 被节流的情况下照样堆积，回到前台就是一阵卡。
   * 现在：生成中 2s、空闲 6s，`document.hidden` 直接跳过一次。
   */
  const pollNow = () => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return
    if (!engineReachable.value) return
    sessions.refreshRunning()
    void session.refreshLifeUnread()
    session.autoDeliverLifeIfReady()
  }
  const schedulePoll = (delay: number) => {
    if (!pollActive) return
    runningPoll = setTimeout(() => {
      if (!pollActive) return
      pollNow()
      schedulePoll(session.isBusy ? 2000 : 6000)
    }, delay)
  }
  pollActive = true
  schedulePoll(2000)
  const onVisibility = () => { if (document.visibilityState === 'visible') pollNow() }
  document.addEventListener('visibilitychange', onVisibility)
  visibilityHandler = onVisibility
  if (engineReachable.value) void session.refreshLifeUnread()
  // 高度只要变就重新贴底（内部有 rAF 合并，不怕高频触发）
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => { requestFollow() })
    observeHost()
    void nextTick(observeHost)
  }
  nextTick(() => { syncScrollHost(); observeHost(); pinNow() })
  // 演示模式自动播一轮，省得进来还要先打字才能看见瀑布流。
  if (shouldAutoplay() && session.timeline.length === 0) {
    setTimeout(() => { if (session.timeline.length === 0) session.sendMessage(DEMO_PROMPT) }, 700)
  }
})

onBeforeUnmount(() => {
  window.clearTimeout(pushTimer)
  // 严格清理：监听 / 定时器 / ResizeObserver / 延迟同步全部摘掉，
  // 避免组件卸载后回调继续改全局 store（store 单例不销毁，流式照收）。
  window.removeEventListener('coomi:open-session', openSessionFromNative)
  window.removeEventListener('coomi:flush-persistence', session.flushPersistence)
  window.removeEventListener('focus', syncDigitalLifeMode)
  document.removeEventListener('touchstart', onDocTouchStart)
  document.removeEventListener('touchmove', onDocTouchMove)
  document.removeEventListener('touchend', onDocTouchEnd)
  document.removeEventListener('touchcancel', onDocTouchEnd)
  resetDrawerVisual()
  session.flushPersistence()
  pollActive = false
  if (runningPoll) { clearTimeout(runningPoll); runningPoll = null }
  if (visibilityHandler) { document.removeEventListener('visibilitychange', visibilityHandler); visibilityHandler = null }
  ro?.disconnect(); ro = null
})

/**
 * 无人值守演示（?demo=1&auto=1）：授权弹层和提问弹层过一会儿自己点掉。
 * 走的是 approve / answerQuestion —— 和真手指按下去完全同一条路，
 * 所以卡片状态、「已回答」气泡都跟着变。截图、录屏、摆着自演都靠它。
 */
if (isUnattended()) {
  const AUTOPILOT_DELAY = 1600
  watch(() => session.pendingApproval?.callId, id => {
    if (!id) return
    setTimeout(() => { if (session.pendingApproval?.callId === id) session.approve(id, 'allow') }, AUTOPILOT_DELAY)
  })
  watch(() => session.pendingQuestion?.callId, id => {
    if (!id) return
    setTimeout(() => {
      const q = session.pendingQuestion
      if (q?.callId === id) {
        session.answerQuestion(id, Object.fromEntries(q.questions.map((question: UserQuestion) => [question.id, question.options[0]?.label ?? ''])))
      }
    }, AUTOPILOT_DELAY)
  })
}

// 空态 main ↔ DynamicScroller 切宿主：等 DOM 落地后重新对齐观察目标并贴底一次。
// 不继承旧容器的 scrollTop（旧实现会继承 → 空态残留的 0 被带进新列表）。
watch([scroller, virtualScroller], () => {
  syncScrollHost()
  observeHost()
  requestFollow()
}, { flush: 'post' })
watch(scrollHost, () => { observeHost() }, { flush: 'post' })
watch([() => config.digitalLifeEnabled, () => config.lifeGlobalMode, () => session.isBusy], ([, , busy]) => {
  if (!busy) session.syncLifeMode()
})

// 厂商增删改激活后 config.providerRevision 自增：对话页重新拉一次 /api/providers，
// 否则设置页刚配好的模型回到对话页仍是旧列表，会被提示「还没有配置模型」。
watch(() => config.providerRevision, () => { void config.fetchProviders() })

function onDecide(callId: string, decision: ApprovalDecision) { session.approve(callId, decision) }
function onAnswer(callId: string, answers: Record<string, string>, comments?: Record<string, string>) { session.answerQuestion(callId, answers, comments) }
/** 空态即将卸载：记下 logo 的屏幕坐标，生成态的 logo 从这里飞向输入栏上方。 */
function onEmptyLeave(el: Element): void {
  reportFlyTo(el.querySelector('.logo-orbit') ?? el)
}

/** 路由/前后台切回时，如果抽屉是关的，强制把补丁状态归零，避免残留一帧。 */
function resetDrawerWhenClosed() {
  if (drawerOpen.value) return
  const api = (window as unknown as { __coomiDrawer?: { reset?: () => void } }).__coomiDrawer
  if (api?.reset) api.reset()
  else document.documentElement.style.setProperty('--cp-f', '0')
  window.dispatchEvent(new Event('coomi:drawer-sync'))
}

function toggleDrawer() { if (drawerOpen.value) closeDrawer(); else openDrawer() }
function setDrawerOpenState(open: boolean) {
  if (drawerOpen.value === open) return
  drawerOpen.value = open
  if (open) {
    registerOverlay('side-drawer', closeDrawer)
    window.dispatchEvent(new CustomEvent('coomi:drawer-state', { detail: { open: true } }))
  } else {
    unregisterOverlay('side-drawer')
    window.dispatchEvent(new CustomEvent('coomi:drawer-state', { detail: { open: false } }))
  }
}
function openDrawer() {
  if (drawerOpen.value) return
  // 平板两栏没有滑盖，直接切。
  if (isTablet.value) { setDrawerOpenState(true); return }
  // 预热帧：先把「最终视觉」挂上（面板露出、圆角/裁剪/阴影就位、顶栏模糊关闭），
  // 此时卡片还没位移，所以看不出变化；下一帧才开始纯 transform 的推拉。
  // 这样打开动画里不再发生任何重绘，3D 卡片也能保持完整。
  window.clearTimeout(settleTimer)
  drawerLive.value = true
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (!drawerLive.value) return
    setDrawerOpenState(true)
    // 动画播完就撤预热态（圆角/阴影由 .drawer-open 接手）：顶栏毛玻璃回来，
    // will-change 也摘掉，避免常驻合成层。
    window.clearTimeout(settleTimer)
    settleTimer = window.setTimeout(() => {
      if (drawerOpen.value && !dragLocked && !drawerDragging.value) drawerLive.value = false
    }, 420)
  }))
}
function closeDrawer() {
  if (dragLocked) { setDrawerOpenState(false); return }
  // 先挂回预热态的视觉（与打开态完全一致，看不出变化），再撤 open 只改 transform；
  // 过渡播完才撤预热态。顺序反了会让圆角/阴影在动画第一帧消失 → 整屏重绘。
  window.clearTimeout(settleTimer)
  if (drawerOpen.value) drawerLive.value = true
  setDrawerOpenState(false)
  settleTimer = window.setTimeout(() => {
    if (!drawerOpen.value && !dragLocked) resetDrawerVisual()
  }, 380)
}
/** 点被推开的卡片收回：拖动过的手势刚松手时忽略这次 click，避免误关。 */
function onDrawerTap() {
  if (Date.now() < tapSuppressUntil) return
  closeDrawer()
}

/** 侧栏滑动：右滑打开、左滑收回；位移全程跟手，抬手按位移+速度吸附。
 *  只改 transform（合成层单属性），不做 scale、不逐帧改圆角/阴影——
 *  非整数缩放与逐帧重绘是之前卡顿的根因。 */
const shellEl = ref<HTMLElement | null>(null)
/** 手势/吸附期间为 true：面板露出、卡片按打开态渲染圆角阴影。 */
const drawerLive = ref(false)
/** 手指按住期间为 true：关掉 .shell 的过渡，位移完全跟手。 */
const drawerDragging = ref(false)
/** 暗色下随拖动进度加深的模糊（0 → 7px），由 --drawer-blur 驱动。 */
const chatRootEl = ref<HTMLElement | null>(null)
const veilEl = ref<HTMLElement | null>(null)
const shadeEl = ref<HTMLElement | null>(null)
/** 只作为手动逃生口：`?fx=lite` 时去掉 3D 角度（默认始终是完整动画）。
 *  以前这里在打开动画里自动抽帧，3 帧慢就当场永久降级 —— 真机第一次打开
 *  本来就会慢（面板首绘 + 冷缓存），结果 3D 被当成性能问题砍掉，
 *  用户看到的就是「侧边栏打开动画消失」。自动降级已删除。 */
const fxLite = ref(
  typeof location !== 'undefined'
  && new URLSearchParams(location.search).get('fx') === 'lite',
)
/** 横屏/平板不用 3D 与模糊：布局已经是静态双栏，transform 只剩余副作用。 */
const noSlideFx = computed(() => isTablet.value || fxLite.value)
let tapSuppressUntil = 0
let settleTimer: number | undefined
let dragRaf = 0
let pendingP = 0
let dragP = 0
let dragBase = 0
let dragWidth = 1
let dragLocked = false
let swipeTracking = false
let swipeX = 0
let swipeY = 0
let dragLastX = 0
let dragLastT = 0
let dragVelocity = 0

function drawerOffset(): number {
  return Math.min(window.innerWidth * 0.82, 336)
}
function drawerTransform(p: number): string {
  if (p <= 0) return ''
  const angle = noSlideFx.value ? 0 : 14 * p
  return `translate3d(${(p * dragWidth).toFixed(2)}px, 0, 0) rotateY(${angle.toFixed(3)}deg)`
}
function applyDrawerTransform(p: number): void {
  const shell = shellEl.value
  dragP = p
  if (!shell) return
  const transform = drawerTransform(p)
  shell.style.transform = transform
  // 模糊随拖动进度加深（暗色生效；亮色 CSS 里不挂 filter）。
  // 0.5px 量化：减少每帧不同的高斯半径，观感连续但不至于每帧重算一次。
  const blur = Math.round(Math.min(1, Math.max(0, p)) * 14) / 2
  chatRootEl.value?.style.setProperty('--drawer-blur', `${blur}px`)
  // 阴影/压暗跟手：它们与 .shell 同 transform，半开时不会停在“全开”的位置。
  for (const layer of [veilEl.value, shadeEl.value]) {
    if (!layer) continue
    layer.style.transform = transform
    layer.style.opacity = p <= 0 ? '' : String(Math.min(1, p))
  }
}

/** 清掉拖拽期写下的内联值，交回类样式（打开/关闭的 CSS 过渡由类驱动）。 */
function clearDrawerLayerStyles(): void {
  for (const layer of [veilEl.value, shadeEl.value]) {
    if (!layer) continue
    layer.style.transform = ''
    layer.style.opacity = ''
  }
}
function queueDrawerProgress(p: number): void {
  pendingP = p
  if (dragRaf) return
  dragRaf = requestAnimationFrame(() => {
    dragRaf = 0
    applyDrawerTransform(pendingP)
  })
}
function resetDrawerVisual(): void {
  window.clearTimeout(settleTimer)
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0 }
  drawerLive.value = false
  drawerDragging.value = false
  if (shellEl.value) shellEl.value.style.transform = ''
  chatRootEl.value?.style.removeProperty('--drawer-blur')
  // 等 drawer-live 的类名真正撤掉再摘内联值，否则会闪回“全开”一帧。
  void nextTick(clearDrawerLayerStyles)
}
/** 抬手吸附：恢复过渡，把内联位移推到 0 或 1；过渡播完摘掉内联值与 live 态。 */
function settleDrawer(open: boolean): void {
  const shell = shellEl.value
  const width = dragWidth || drawerOffset()
  // 一帧内完成三件事，不要分开做：
  //  · 摘 drawerDragging（恢复 transition）
  //  · 设终态 transform
  //  · 更新 open 状态
  // 以前分几次赋值，浏览器会先按「无过渡 + 旧位移」渲染一帧，再按「有过渡 + 新位移」
  // 渲染 —— 中间那一帧就是松手时的抖动来源。
  drawerDragging.value = false
  setDrawerOpenState(open)
  const finalTransform = open
    ? `translate3d(${width.toFixed(2)}px, 0, 0) rotateY(${noSlideFx.value ? 0 : 14}deg)`
    : 'translate3d(0px, 0, 0) rotateY(0deg)'
  if (shell) shell.style.transform = finalTransform
  // 交回类过渡：保留当前半径→目标半径的插值（不要在松手瞬间抽掉，否则模糊会跳一下）。
  if (chatRootEl.value) {
    chatRootEl.value.style.setProperty('--drawer-blur', open ? '7px' : '0px')
  }
  // 压暗/阴影与卡片同一终态：清除内联值前它们必须已经在终点，否则会瞬移。
  for (const layer of [veilEl.value, shadeEl.value]) {
    if (!layer) continue
    layer.style.transform = finalTransform
    layer.style.opacity = open ? '1' : '0'
  }
  dragP = open ? 1 : 0
  window.clearTimeout(settleTimer)
  // 用 transitionend 摘 live，不用固定定时器：
  // 设备性能差时 360ms 可能不够过渡播完，提前摘 live 会让圆角/阴影回退一下。
  const done = () => {
    drawerLive.value = false
    if (shellEl.value) shellEl.value.style.transform = ''
    // 类名更新后再摘内联值：关闭时 drawer-live 还在的那一帧会把压暗层拉回全开。
    void nextTick(clearDrawerLayerStyles)
  }
  if (shell) {
    let fired = false
    const onEnd = (event: TransitionEvent) => {
      if (event.target !== shell || event.propertyName !== 'transform') return
      fired = true
      shell.removeEventListener('transitionend', onEnd)
      done()
    }
    shell.addEventListener('transitionend', onEnd, { once: false })
    // 兜底：过渡被跳过（元素隐藏 / 用户开了减少动效）时 transitionend 不会来。
    settleTimer = window.setTimeout(() => {
      if (!fired) { shell.removeEventListener('transitionend', onEnd); done() }
    }, 460)
  } else {
    settleTimer = window.setTimeout(done, 360)
  }
}
/** 起手点落在横向滚动容器里时让给容器：否则一横滑就把表格/代码块拖成抽屉。 */
function insideHScroll(el: HTMLElement | null): boolean {
  for (let node = el; node && node !== document.body; node = node.parentElement) {
    if (node.scrollWidth > node.clientWidth + 4) {
      const ox = getComputedStyle(node).overflowX
      if (ox === 'auto' || ox === 'scroll') return true
    }
  }
  return false
}
function onDocTouchStart(event: TouchEvent) {
  if (event.touches.length !== 1) return
  const touch = event.touches[0]
  const target = event.target as HTMLElement | null
  if (!target?.closest('.chat')) return
  if (target.closest('input, textarea, button, a, select, pre, code, .md-table-scroll, .entry-row, .cm-sheet-root')) return
  // 起手不限边缘：屏幕最左 20dp 归系统返回手势，抽屉靠「略微内侧起手 → 右滑」打开
  swipeX = dragLastX = touch.clientX
  swipeY = touch.clientY
  dragLastT = performance.now()
  dragVelocity = 0
  dragLocked = false
  swipeTracking = true
}
function onDocTouchMove(event: TouchEvent) {
  if (!swipeTracking) return
  const touch = event.touches[0]
  const dx = touch.clientX - swipeX
  const dy = touch.clientY - swipeY
  if (!dragLocked) {
    if (Math.abs(dx) < 10 && Math.abs(dy) < 10) return
    // 竖向占优 = 在滚动内容，不是抽抽屉
    if (Math.abs(dx) < Math.abs(dy) * 1.2) { swipeTracking = false; return }
    // 方向反了就不接管（开着还右滑、关着还左滑）
    if (!drawerOpen.value && dx < 0) { swipeTracking = false; return }
    if (drawerOpen.value && dx > 0) { swipeTracking = false; return }
    if (insideHScroll(event.target as HTMLElement | null)) { swipeTracking = false; return }
    dragLocked = true
    dragBase = drawerOpen.value ? 1 : 0
    dragWidth = drawerOffset()
    dragP = dragBase
    dragLastX = touch.clientX
    dragLastT = performance.now()
    window.clearTimeout(settleTimer)
    // will-change 要在**开始跟手之前**就挂上，而且必须与「设起始 transform」
    // 分在两帧里做：同一帧内既挂 will-change 又改 transform，浏览器来不及
    // 提升合成层，第一帧仍是主线程绘制 —— 那就是起手第一下卡顿的来源。
    drawerLive.value = true
    requestAnimationFrame(() => {
      drawerDragging.value = true
      // 起始位移也放到这一帧，保证与 will-change 生效同帧
      applyDrawerTransform(dragBase)
    })
  }
  const now = performance.now()
  const dt = now - dragLastT
  if (dt > 0) dragVelocity = (touch.clientX - dragLastX) / dt
  dragLastX = touch.clientX
  dragLastT = now
  const p = Math.max(0, Math.min(1, dragBase + dx / dragWidth))
  queueDrawerProgress(p)
}
function onDocTouchEnd() {
  if (!swipeTracking && !dragLocked) return
  swipeTracking = false
  if (!dragLocked) return
  dragLocked = false
  // 松手后的 click 不该被当成「点卡片收回」
  tapSuppressUntil = Date.now() + 260
  if (dragRaf) { cancelAnimationFrame(dragRaf); dragRaf = 0 }
  const p = pendingP
  applyDrawerTransform(p)
  // 快速轻扫（>0.45px/ms）优先看方向；否则过半吸附
  const flick = Math.abs(dragVelocity) > 0.45
  settleDrawer(flick ? dragVelocity > 0 : p > 0.5)
}
/**
 * 行高变了（流式正文长高、工具组自动收起、turn 收尾）：请求下一帧贴底。
 * 折叠已经改成瞬时高度、且开合前会先 keepAnchor 脱离跟随，
 * 所以这里不再需要「动画窗口内静音」的特判。
 */
function onItemResize() {
  requestFollow()
}

watch(() => session.pendingApproval?.callId, (id, previous) => {
  if (previous) unregisterOverlay(`approval:${previous}`)
  if (id) registerOverlay(`approval:${id}`, () => session.approve(id, 'deny'))
})
watch(() => session.pendingQuestion?.callId, (id, previous) => {
  if (previous) unregisterOverlay(`question:${previous}`)
  if (id) registerOverlay(`question:${id}`, () => session.answerQuestion(id, {}))
})
</script>

<template>
  <div
    ref="chatRootEl"
    class="chat"
    :class="{ 'drawer-open': drawerOpen, 'drawer-live': drawerLive, 'drawer-dragging': drawerDragging, 'fx-lite': noSlideFx, tablet: isTablet }"
    :data-lid="drawerOpen || drawerLive ? '1' : null"
  >
    <!-- 阴影独立层：只在 opacity 上过渡，不参与任何重绘。
         必须放在 .shell 之前（同属 .chat 的绝对定位子元素），
         这样它和 .shell 各自独立合成，动画期间互不影响。 -->
    <div ref="shadeEl" class="shell-shade" aria-hidden="true" />
    <!-- pushing：仅抽屉推拉期间挂（will-change 只在这时生效），关闭后摘掉避免常驻合成层 -->
  <div
      ref="shellEl"
      class="shell drawer-host"
    >
      <!-- 盖子容器：只有它做位移/圆角/阴影；输入栏留在 .shell 里，不受 transform 影响 -->
      <div class="lid">
      <TopBar
        :focused-subagent-name="focusedSubagent?.name ?? null"
        @menu="toggleDrawer"
        @search="searchOpen = true"
        @focus-subagent="onFocusSubagent"
        @back-to-main="onBackToMain"
      />

      <!-- §二 顶栏下方：从子代理跳转后可一键回到主会话 -->
      <Transition name="back-main">
        <button v-if="subagentFocused" class="back-main" @click="onBackToMain">
          
          <CoomiIcon name="arrowLeft" :size="15" /><span>返回主会话</span>
        </button>
      </Transition>

      <!-- 空态脱离滚动区，做成 .shell 的直属绝对定位层：
           屏幕正中央 = .shell 的中心（TopBar 与输入区都不再挤偏它）。
           pointer-events:none 保证不挡住输入框；内部可点元素各自恢复。 -->
      <div
        v-if="session.timeline.length === 0"
        class="empty-center"
      >
        <EmptyState @before-leave="onEmptyLeave" />
      </div>

      <main ref="scroller" class="stream" :class="{ 'stream-hidden': !revealed }">
        <!-- 单一滚动容器（对齐 Comax）：生成中与落定后都走同一个 DynamicScroller。
             以前落定时把整段普通 DOM 换成虚拟列表，等于整树替换 —— 那就是「生成完闪一下」
             和「切会话闪一下」的共同来源。高度变化交给 ResizeObserver / emit-resize。 -->
        <DynamicScroller
          v-if="session.timeline.length > 0"
          ref="virtualScroller"
          :items="blocks"
          key-field="key"
          :min-item-size="48"
          :buffer="640"
          class="virtual-stream"
        >
          <template #default="{ item, index, active }">
            <DynamicScrollerItem
              :item="item"
              :active="active"
              :data-index="index"
              class="virtual-item"
              emit-resize
              @resize="onItemResize"
            >
              <TimelineBlock :block="item" no-enter />
            </DynamicScrollerItem>
          </template>
        </DynamicScroller>
      </main>

      <LoopProgressBar v-if="session.loop.active" :loop="session.loop" />
      <div v-if="session.retryConfirmation" class="retry-confirm">
        <div><CoomiIcon name="alert" :size="16" /><span>{{ session.retryConfirmation.message }}</span></div>
        <p v-if="retryMeta" class="retry-meta">{{ retryMeta }}</p>
        <p v-if="retryDetail" class="retry-detail">{{ retryDetail }}</p>
        <div class="retry-actions">
          <button class="retry-secondary" @click="session.dismissRetry()">结束任务</button>
          <button class="retry-secondary" @click="session.retryInterruptedTurn()">重试</button>
          <button class="retry-primary" @click="session.continueInterruptedTurn()">继续这一轮</button>
        </div>
      </div>
      <div v-if="session.undoConfirm" class="retry-confirm">
        <div><CoomiIcon name="arrowLeft" :size="16" /><span>确定回撤这一轮？将撤回该轮执行与产生的所有修改，并返回上一轮状态。</span></div>
        <div class="retry-actions">
          <button class="retry-secondary" @click="session.cancelUndo()">取消</button>
          <button class="retry-primary" @click="session.confirmUndo()">确认回撤</button>
        </div>
      </div>
      <Transition name="pop">
        <button
          v-if="session.lifeUnread.length && session.isGlobalSession && session.mode === 'life' && !session.isBusy"
          class="life-pill"
          type="button"
          @click="session.deliverLife()"
        >
          <CoomiIcon name="lifeRings" :size="15" />
          <span class="life-pill-label">{{ session.lifeUnreadName || '数字生命体' }} 想对你说</span>
          <span class="life-pill-preview">{{ session.lifeUnread[0].text }}</span>
        </button>
      </Transition>
      <StatusBar />
      </div><!-- /.lid -->

      <!-- 回到底部只保留右侧历史转盘上的「最新」入口：屏幕正中不再放第二颗悬浮键。 -->
      <HistoryDial v-if="historyTargets.length >= 2" :targets="historyTargets" @jump="onDialJump" @latest="jumpToBottom()" />

      <!-- 粘性错误条：429/500 这类厂商错误不再只留在时间线里滚走 -->
      <div v-if="session.errorBanner" class="error-banner" role="alert">
        <CoomiIcon name="alert" :size="15" />
        <span>{{ session.errorBanner }}</span>
        <button class="eb-close" aria-label="关闭" @click="session.dismissErrorBanner()">×</button>
      </div>

      <Composer :model-locked="focusedSubagent !== null" />

      <!-- 子代理会话（只读）：数据来自引擎 /api/agents/{id}/messages -->
      <SubagentChat
        v-if="focusedSubagent"
        :agent-id="focusedSubagent.agentId"
        :agent-name="focusedSubagent.name"
        @close="onBackToMain"
      />

      <!-- §四 历史消息搜索：展开/收起都有过渡 -->
      <HistorySearch
        v-if="searchOpen"
        :items="searchItems"
        @close="searchOpen = false"
        @jump="(index) => { const hit = searchItems[index]; scrollToBlock(resolveBlockIndex(hit?.messageId, hit?.blockIndex ?? index)); searchOpen = false }"
      />
    </div>

    <!-- 压暗 + 页面高光：与 .shell 同 transform 的兄弟层。
         常驻挂载（不再 v-if）—— 挂载即带 open 类会让 opacity 没有起始帧，
         表现就是「阴影直接附上去、没有过渡」。模糊只加在 .shell 上，
         半径由 --drawer-blur 随滑动进度连续加深（暗色生效）。 -->
    <div ref="veilEl" class="drawer-veil" aria-hidden="true" />

    <!-- 点被推开的卡片收回侧栏：必须在 .shell 外面 —— 放在里面会被卡片自身的
         位移再推走一个抽屉宽，点击区域直接落到屏幕外。 -->
    <div v-if="drawerOpen" class="drawer-tap" @click="onDrawerTap" />

    <SideDrawer :open="drawerOpen" @close="closeDrawer" />

    <ApprovalSheet
      v-if="session.pendingApproval"
      :card="session.pendingApproval"
      @decide="(d: ApprovalDecision) => onDecide(session.pendingApproval!.callId, d)"
    />
    <QuestionSheet
      v-else-if="session.pendingQuestion"
      :card="session.pendingQuestion"
      @answer="(answers: Record<string, string>, comments: Record<string, string>) => onAnswer(session.pendingQuestion!.callId, answers, comments)"
      @cancel="() => onAnswer(session.pendingQuestion!.callId, {})"
    />
  </div>
</template>

<style scoped>
.chat {
  height: 100%;
  min-height: 0;
  position: relative;
  /* 卡片推开距离 = 侧栏宽度；perspective 给 rotateY 一点纵深 */
  --drawer-w: min(82vw, 336px);
  perspective: 1600px;
  background-color: transparent;
  background-image:
    linear-gradient(var(--chat-background-overlay), var(--chat-background-overlay)), var(--chat-background-image);
  background-position: center;
  background-size: cover;
}

.shell {
  position: relative; z-index: var(--z-sticky);
  display: flex; flex-direction: column; height: 100%; min-height: 0;
  /* 卡片要是不透明的，侧栏推开时才不会被底图透出来。背景与 .chat 同源。 */
  background-color: var(--bg);
  background-image:
    linear-gradient(var(--chat-background-overlay), var(--chat-background-overlay)), var(--chat-background-image);
  background-position: center; background-size: cover;
  /* 旋转轴贴左边缘：像一张被按住左边、右边缘被推开的卡片 */
  transform-origin: left center;
  backface-visibility: hidden;
  /* 圆角与裁切改成常驻：关闭态四角露出的也是 .chat 同一张壁纸，肉眼看不出来。
     以前它们在预热帧才加上，等于动画第 0 帧让整屏重绘一次（border-radius
     与 overflow 都是 paint 属性），WebView 就会闪一下。 */
  border-radius: var(--r-card);
  overflow: hidden;
  /* 只过渡 transform。圆角是 paint 属性，放进 transition 等于 340ms 里每帧
     重绘整屏 —— 这就是「打开侧栏卡/动画不完整」的主因。 */
  transition: transform .34s cubic-bezier(.22, .68, .19, 1);
}
.chat.drawer-open .shell {
  transform: translateX(var(--drawer-w)) rotateY(14deg);
}
/* 卡片左侧 36px 圆角让出的缺口，过去露出的是 .chat 的白壁纸（比侧栏 --page 亮），
   跟随卡片移动就是那块「亮白色小区域」。打开/拖拽期间把底图换成侧栏同色，
   缺口与面板同色，移动时不再有亮斑。 */
.chat.drawer-open,
.chat.drawer-live {
  background-color: var(--page);
  background-image: none;
}

/* 侧栏展开时只由 .shell-shade 负责投影。
   compat-rc104.css 还给了 .shell 本人一条 40px 模糊的 box-shadow（且带 !important 权重），
   跟着 transform 一起动 = 每帧重绘一整块模糊，这是展开卡顿的主因之一。 */
.chat[data-lid] > .shell { box-shadow: none !important; }

/* 对话侧压暗 + 页面高光：与 .shell 同 transform 的兄弟层，盖住整张卡片。
   常驻挂载（opacity:0），类切换才有 0→1 的起始帧 —— 这就是「阴影直接附上去」的修复。
   层级 11：在 .shell（10）之上、.drawer-tap（12）之下；pointer-events:none。 */
.chat > .drawer-veil {
  position: absolute; inset: 0;
  z-index: 11;
  /* 与卡片同一圆角几何：左上/左下 36，右侧直角（vendor 的 .shell 规则）。
     以前这里用 --r-card 四角全圆，顶部会露出一道不属于卡片的边界。 */
  border-radius: 36px 0 0 36px;
  overflow: hidden;
  pointer-events: none;
  opacity: 0;
  transform-origin: left center;
  background: rgb(10 12 16 / .16);
  transition: opacity .34s cubic-bezier(.22, .68, .19, 1),
              transform .34s cubic-bezier(.22, .68, .19, 1);
  will-change: transform;
}
/* 页面高光：**铺满整张对话页**，不是只描上沿。
   首页中部没有组件时，卡片本来是一块死黑；这里用一层全幅柔光把整面提亮，
   左上再加主光、右上斜向反光、四周一层内发光，读作“整块玻璃被推后”。
   这层是静态画一遍，动画只动 opacity/transform，不产生逐帧模糊。 */
.chat > .drawer-veil::after {
  content: '';
  position: absolute; inset: 0;
  background:
    /* 全幅柔光底：保证中部（首页空态）也有亮度，不再是纯黑 */
    linear-gradient(180deg,
      rgb(255 255 255 / .11) 0%,
      rgb(255 255 255 / .055) 46%,
      rgb(255 255 255 / .075) 100%),
    /* 左上主光：从抽屉那一侧打过来 */
    radial-gradient(140% 100% at 0% 0%,
      rgb(255 255 255 / .17) 0%,
      rgb(255 255 255 / .06) 34%,
      transparent 68%),
    /* 右上斜向反光：让整面有“玻璃”的方向感，而不是上下两条带 */
    linear-gradient(128deg,
      transparent 26%,
      rgb(255 255 255 / .055) 50%,
      transparent 74%);
  /* 整圈极细亮边 + 顶/底高光 + 四周内发光：整张卡都像被光包住。 */
  box-shadow:
    inset 0 0 0 1px rgb(255 255 255 / .065),
    inset 0 1px 0 rgb(255 255 255 / .14),
    inset 0 -1px 0 rgb(255 255 255 / .09),
    inset 0 0 130px rgb(255 255 255 / .05);
  opacity: 0;
  transition: opacity .34s cubic-bezier(.22, .68, .19, 1);
}
.chat.drawer-open > .drawer-veil {
  opacity: 1;
  transform: translateX(var(--drawer-w)) rotateY(14deg);
}
.chat.fx-lite.drawer-open > .drawer-veil { transform: translateX(var(--drawer-w)); }
.chat.drawer-dragging > .drawer-veil { transition: none; }
.chat.tablet > .drawer-veil { display: none; }
:root[data-theme="dark"] .chat > .drawer-veil,
body[data-theme="dark"] .chat > .drawer-veil { background: rgb(0 0 0 / .44); }
:root[data-theme="dark"] .chat > .drawer-veil::after,
body[data-theme="dark"] .chat > .drawer-veil::after { opacity: 1; }

/* 暗色：模糊随 --drawer-blur（0 → 7px）连续加深；按钮开合由 .chat 上的
   自定义属性过渡驱动，拖拽时由 JS 每帧写同一个变量 —— 两条路一致。
   fx-lite / 减弱动态效果一律不模糊。 */
/* 亮色与暗色都模糊：只保留 blur，不再叠加 brightness/saturate。
   以前暗色挂了 brightness(.82)，动画结束整条规则被撤掉时亮度会回弹一下
   —— 用户看到的「最后突然变亮一点」就是这个。压暗交给 .drawer-veil 的底色，
   它和模糊一起淡出，收尾没有二次变化。 */
.chat.drawer-open > .shell,
.chat.drawer-live > .shell {
  filter: blur(var(--drawer-blur, 0px));
  /* filter 的输出不受元素自身 border-radius 裁切：亮色下会把卡片白底“渗”到
     圆角外，落在侧栏底色上 —— 那就是跟着卡片走的那块亮白小区域。
     clip-path 用同一半径把模糊输出裁掉，圆角外保持侧栏底色。 */
  clip-path: inset(0 round 36px 0 0 36px);
  will-change: filter;
}
.chat.drawer-open > .shell { clip-path: inset(0 round 36px 0 0 36px); }
.chat { --drawer-blur: 0px; transition: --drawer-blur .34s cubic-bezier(.22, .68, .19, 1); }
.chat.drawer-dragging { transition: none; }
.chat.drawer-open { --drawer-blur: 7px; }
.chat.fx-lite > .shell,
.chat.tablet > .shell { filter: none !important; }
@media (prefers-reduced-motion: reduce) {
  .chat > .shell { filter: none !important; }
  .chat { transition: none; }
}
[data-motion='off'] .chat > .shell { filter: none !important; }

/* 这台机器帧预算不够时只保留位移（3D 角度去掉），观感只差一点，但不掉帧 */
.chat.fx-lite.drawer-open .shell {
  transform: translateX(var(--drawer-w));
}
/* 阴影挪到独立兄弟层，只过渡 opacity（纯合成）。
   以前阴影挂在 .shell 上，预热帧才出现 → 第 0 帧要画一次 40px 大模糊，
   那一帧就是「闪一下」。独立层常驻、只改透明度，不触发任何重绘。 */
.shell-shade {
  position: absolute; inset: 0; z-index: calc(var(--z-sticky) - 1);
  border-radius: var(--r-card);
  pointer-events: none;
  opacity: 0;
  transition: opacity .34s cubic-bezier(.22, .68, .19, 1);
  transform: translateX(0);
  box-shadow:
    0 2px 10px rgb(17 22 31 / .16),
    0 2px 44px rgb(17 22 31 / .16);
}
.chat.drawer-open .shell-shade,
.chat.drawer-live .shell-shade {
  opacity: 1;
  transform: translateX(var(--drawer-w)) rotateY(14deg);
}
.chat.fx-lite.drawer-open .shell-shade {
  transform: translateX(var(--drawer-w));
}
:root[data-theme="dark"] .shell-shade,
body[data-theme="dark"] .shell-shade {
  box-shadow:
    0 2px 10px rgb(0 0 0 / .55),
    0 2px 44px rgb(0 0 0 / .55);
}
/* will-change 只在预热~落定这段挂；常驻会永久保留一个整页合成层。
   由 JS 在类切换前一帧设置，避免「挂 will-change 与切类同帧」导致的重新分层。 */
.chat.drawer-live .shell { will-change: transform; }
/* 手指按住时位移必须即时跟手，不能有 340ms 的拖尾 */
.chat.drawer-dragging .shell { transition: none; }

.stream {
  flex: 1; min-width: 0; min-height: 0; max-width: 100%; overflow-x: hidden; overflow-y: auto;
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
  /* 浏览器自带的滚动锚定会和虚拟列表的尺寸补偿各算一遍，叠成双倍位移 */
  overflow-anchor: none;
}
.inner {
  display: flex; flex-direction: column; gap: var(--sp-3);
  /* 底部留白收紧：以前 18px + 状态栏空带 = 消息提前“消失”在输入栏上方。 */
  width: 100%; min-width: 0; min-height: 100%; padding: 10px var(--sp-3) var(--sp-1); overflow-x: hidden;
}
/* 空态三件（logo / 主标题 / 工作目录）真正水平居中。
   .inner 是 flex + 默认 align-items:stretch，子元素会被拉满宽、贴左；
   .empty-sm 的 text-align 只管「文字」居中，管不到 logo 与工作目录框这种「盒子」。 */
/* 屏幕正中央：以 .shell（position:relative）为基准铺满整屏，再双向居中。
   .stream 是滚动区（overflow-y:auto），空态放进去会被它裁切，所以提到 .shell 直属。
   pointer-events:none → 这层盖住输入区但不拦点击；.empty-sm 内元素自行恢复。 */
.empty-center {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 0 var(--sp-4);
  pointer-events: none;
  transition: opacity 160ms var(--ease-out);
}
/* 输入区活跃（聚焦 / 有草稿 / 托盘展开）时，空态层整块退场。
   它原来是 inset:0 的绝对定位层，键盘抬起、输入区上移后仍然画在托盘按钮上面，
   把「更多」按钮挡住、还吃掉点击。这里让它在活跃态直接隐身且不接收事件。 */
/* 输入区活跃时不再整层隐藏空态：只需要保证输入区/托盘在空态层之上
   （.lid 已有 z-index:2）。隐藏整层会让 logo / 标题 / 目录选择一起消失。 */
/* ★ 关键：.empty-sm 自己是块级容器且占满整宽，text-align 只管其中的「文字」，
   管不到 logo(44px) 与 cwdbar(固定宽) 这两个「盒子」—— 所以它们一直贴左。
   把它改成 flex 列 + align-items:center，三件才会共用同一垂直中轴、且 logo 在标题上方。 */
.empty-center :deep(.empty-sm) {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
}
.virtual-stream {
  width: 100%; height: 100%; min-width: 0; min-height: 0; box-sizing: border-box;
  padding: 10px var(--sp-3) var(--sp-1); overflow-y: auto; overflow-x: hidden;
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
  overflow-anchor: none;
}
/* 每条时间线项之间的呼吸位。写死 --sp-3(12px) 而不是「间距令牌」：
   这一项的值必须和 ChatView 版心内边距（.virtual-stream / .inner 的 10px 12px 18px）
   同档，否则虚拟列表算出的项高与实际渲染高度对不上，滚动时就会出现消息互相压住。
   改这里之前请先量 .virtual-stream 的左右内边距，两边必须一致。 */
.virtual-item { width: 100%; min-width: 0; padding-bottom: var(--sp-3); }

/* 切会话/首次进入：内容与尺寸都落定之前先隐藏（visibility 保留布局与测量，
   不像 opacity 那样要淡入，也不像 display:none 那样量不到高度）。
   揭幕门在 ChatView 逻辑里置 revealed=true，画面一次到位。 */
.stream.stream-hidden { visibility: hidden; }
/* 虚拟列表里的行会因滚动被销毁/重建：任何入场动画重播都是「闪一下」。
   组件层已经通过 no-enter 关掉了，这里再兜住硬编码 cascade 的条目（如通知条）。 */
.virtual-stream :deep(.cascade) { animation: none !important; }
.pop-enter-active, .pop-leave-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: translateY(8px) scale(.9); }

.life-pill {
  display: flex; align-items: center; gap: 7px;
  margin: 0 var(--sp-3) 6px; padding: var(--sp-2) var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  border-radius: var(--r-md);
  background: linear-gradient(105deg, color-mix(in srgb, var(--accent-soft) 80%, var(--bg)), var(--bg));
  color: var(--accent);
  box-shadow: var(--shadow-1);
  text-align: left;
}
.life-pill-label { flex: none; font-size: var(--fs-label); font-weight: 600; }
.life-pill-preview {
  flex: 1; min-width: 0; overflow: hidden; white-space: nowrap; text-overflow: ellipsis;
  color: var(--text-3); font-size: var(--fs-label);
}

.retry-confirm { margin: 0 var(--sp-3) var(--sp-1); padding: var(--sp-3) var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); box-shadow: var(--shadow-1); }.retry-confirm > div:first-child { display: flex; align-items: center; gap: 7px; font-size: var(--fs-sub); color: var(--text-2); }
.retry-actions { display: flex; justify-content: flex-end; gap: var(--sp-2); margin-top: 9px; }
.retry-actions button { min-height: 36px; padding: 0 var(--sp-3); border-radius: var(--r-sm); font-size: var(--fs-sub); font-weight: 600; }
.retry-secondary { background: var(--fill); color: var(--text-2); }
.retry-primary { background: var(--blue); color: #fff; }
.retry-meta { margin: 7px 0 0; color: var(--text-3); font-size: var(--fs-label); line-height: 1.5; }
.retry-detail { margin: var(--sp-1) 0 0; color: var(--text-3); font-size: var(--fs-caption); line-height: 1.5; overflow-wrap: anywhere; }

/* §二 返回主会话：顶栏下方一条轻量入口，出现/消失都带过渡。 */
.back-main {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  align-self: flex-start; margin: var(--sp-1) var(--sp-3) 0;
  padding: 6px var(--sp-3);
  border: 1px solid var(--blue-border); border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-label); font-weight: 600;
}
.back-main:active { background: var(--blue-soft); }
.back-main-enter-active, .back-main-leave-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.back-main-enter-from, .back-main-leave-to { opacity: 0; transform: translateY(-6px); }

/* 减弱动态效果：抽屉推开主内容的位移取消过渡（状态切换仍瞬时生效） */
@media (prefers-reduced-motion: reduce) {
  .shell { transition: none; }
}

/* 抽屉是「底图」：rc33 的逐帧 JS 已停用，面板固定不动，
   露不露出来完全由上面那张卡片滑开多少决定。
   面板本身的定位/宽度/显隐在 compat-rc104.css（全局）：scoped 选择器
   带不到 SideDrawer 的 DOM，写在这里不会生效。 */
.chat > .drawer-root {
  position: absolute; inset: 0; z-index: 5;
  pointer-events: none;
}
.chat.drawer-open > .drawer-root { pointer-events: auto; }
.chat.drawer-live > .drawer-root { pointer-events: auto; }
/* 抽屉打开时，点被推开的卡片任意处即可收回 */
.drawer-tap { position: absolute; inset: 0 0 0 var(--drawer-w); z-index: 12; }

/* rc33 补丁接管抽屉：这里只保留 .lid 的布局骨架（不参与任何动画） */
.lid {
  position: relative;
  /* 高于空态层（z-index:1）：输入区与托盘永远在空态层之上，
     即使空态层将来因为别的条件重新出现，也不会盖住「更多」按钮。 */
  z-index: 2;
  display: flex; flex-direction: column;
  flex: 1; min-height: 0;
}
.chat { overflow-x: clip; }
/* 侧栏手势：别再给祖先写 touch-action: pan-y —— 它按「祖先交集」语义生效，
   会把表格/代码块的横向滚动一并封死，还会让手势只剩抽屉能接（缺陷 13）。
   manipulation 只禁双击缩放，横竖滚动都交回浏览器；抽屉手势靠 rAF + 方向比判定。 */
.chat, .stream { touch-action: pan-y; }
/* 表格这类必须先横滚的容器：显式声明两轴可达，并把滚动链锁在本容器内 */
.md-table-scroll, .md-table-full-body, .md > table { touch-action: auto; overscroll-behavior-x: contain; }


/* ── 平板（横屏宽屏）：静态两栏，收缩不参与滑盖动画 ── */
.chat.tablet { display: flex; flex-direction: row; }
.chat.tablet > .drawer-root {
  position: static; order: 0; width: 320px; height: 100%;
  display: block; pointer-events: auto;
}
.chat.tablet:not(.drawer-open) > .drawer-root { display: none; }
.chat.tablet > .drawer-root .scrim,
.chat.tablet .coomi-drawer-tap { display: none !important; }
.chat.tablet > .shell {
  order: 1; flex: 1; min-width: 0; height: 100%;
  margin-left: 0; transform: none !important;
  border-radius: 0 !important; box-shadow: none !important;
  transition: none !important;
}

/* 粘性错误条（厂商 429/500 等）：固定在输入区上方，不随时间线滚走 */
.error-banner {
  flex: none;
  margin: 0 var(--sp-3) var(--sp-1);
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--danger-border); border-radius: var(--r-md);
  background: var(--danger-soft); color: var(--danger);
  font-size: var(--fs-label); line-height: 1.5;
}
.error-banner span { flex: 1; min-width: 0; word-break: break-word; }
.error-banner .eb-close {
  flex: none; width: var(--sp-4); min-height: var(--sp-4); border: 0; border-radius: 50%;
  background: transparent; color: inherit; font-size: var(--fs-strong); line-height: 1;
}
</style>
