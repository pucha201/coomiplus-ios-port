<script setup lang="ts">
/**
 * 输入区。
 * DeepSeek 的输入框是「一整块大圆角卡片」：文本在上，模式开关和发送在下一行。
 * 这里的两个 chip 都对应真实协议能力（enter/exit_plan_mode、set_permission_mode），
 * ⊕ 展开指令面板：Android SAF 文件导入 + 可滚动的斜杠指令列表。
 *
 * ── 本轮优化：文件 chip ──
 * 已添加的文件不再直接填入输入框文本，而是显示在输入框上方的 chip 容器中。
 * 类似 DeepSeek / 豆包的交互：选择文件 → chip 出现在输入框上 → 发送时自动在 prompt 中引用。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { PERMISSION_MODES, REASONING_EFFORTS, REASONING_HINT, useConfigStore } from '@/stores/config'
import PlanCapsule from '@/components/PlanCapsule.vue'
import { useSessionStore, type AttachedFile } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import { useRouter } from 'vue-router'
import CoomiIcon from './CoomiIcon.vue'
import DeviceSwitcherSheet from './DeviceSwitcherSheet.vue'
import { useDeviceStore } from '@/stores/device'
import { pickDirectory } from '@/utils/folderPicker'
import { trayState } from '@/utils/trayState'
import { decideProviderGate } from '@/utils/providerGate'
import AttachedFileChipContainer from './AttachedFileChipContainer.vue'
import { isDemoMode } from '@/bridge/demoMode'
import { reversePillState, reversePillLabel, reversePillTitle } from '@/utils/reverseMode'
import { currentKeyboardInsetPx, keyboardVisible, nativeImeInset } from '@/utils/keyboardInset'
import { handoffFrame } from '@/utils/bottomHandoff'
import { decideHold, decideClick, movedBeyondSlop } from '@/utils/holdGesture'
import ReverseConsent from './ReverseConsent.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const session = useSessionStore()
const config = useConfigStore()
const connection = useConnectionStore()
const router = useRouter()
const device = useDeviceStore()
const deviceSheetOpen = ref(false)
/** 首页（空会话）才显示输入栏下方的设备/工作目录条；发送后自然消失。 */
const showDockMeta = computed(() => !dockRetired.value && session.timeline.length === 0 && !session.isBusy && !session.restoring)
/** 这个会话里已经发过东西：dock 永久退场，不再因为「回合结束 + 时间线意外为空」浮回来。 */
const dockRetired = ref(false)
watch(() => session.sessionId, () => { dockRetired.value = false })

/** dock 跟随键盘/加号面板收起：键盘弹起时这块留给键盘，收起后再回来。 */
const dockCollapsed = computed(() => bottomBusy.value || trayState.open)
const deviceLabel = computed(() => {
  if (device.mode === 'local') return '本机'
  return device.activeDevice?.name || '选择电脑'
})
const cwdShort = computed(() => {
  const value = session.cwd || ''
  if (!value) return '工作目录'
  const normalized = value.replace(/\\/g, '/').replace(/\/+$/, '')
  const name = normalized.split('/').filter(Boolean).pop() || value
  return name.length > 18 ? '…' + name.slice(-17) : name
})

async function applyWorkspace(path: string) {
  if (!path) return
  const ok = await session.setSessionCwd(path)
  if (!ok) noticeFlash('切换工作目录失败（目录不存在或无权限）')
}

async function pickWorkspace() {
  // 云端：目录在电脑上，必须走应用内远程目录选择器；原生 SAF 选的是手机目录。
  if (device.mode === 'cloud') {
    const path = await pickDirectory(session.cwd || '')
    if (path) await applyWorkspace(path)
    return
  }
  const bridge = (window as any).CoomiAndroid
  if (bridge?.pickDirectory) {
    const onSelected = (event: Event) => {
      window.removeEventListener('coomi:folder-selected', onSelected)
      const path = (event as CustomEvent<{ path?: string }>).detail?.path
      if (path) void applyWorkspace(path)
    }
    window.addEventListener('coomi:folder-selected', onSelected)
    bridge.pickDirectory()
    return
  }
  const path = await pickDirectory(session.cwd || '')
  if (path) await applyWorkspace(path)
}

/** 斜杠指令：点击后填入输入框，可编辑后发送。 */
const SLASH_COMMANDS = [
  { name: '/loop', desc: '循环执行直到完成' },
  { name: '/plan', desc: '进入计划模式' },
  { name: '/mcp', desc: '管理 MCP 服务器' },
  { name: '/skills', desc: '查看可用技能' },
  { name: '/memory', desc: '查看 CoomiPlus 内建持久记忆' },
  { name: '/compact', desc: '立即压缩当前上下文' },
]

const text = ref('')
const textarea = ref<HTMLTextAreaElement | null>(null)
const quickOpen = ref(false)
const effortOpen = ref(false)
/**
 * 加号面板与键盘的底部交接。
 * panelSlotH 是面板在 composer 流内占的高度；它由 rAF 驱动，
 * 与原生键盘垫高之和（reserve）恒走一条曲线 —— 见 utils/bottomHandoff.ts。
 */
const panelSlotH = ref(0)
const panelFullH = ref(0)
/** 内容额外上浮（px）：即使键盘瞬间退场，也让面板有 24px 的滑入感。 */
const panelLift = ref(0)
const panelBusy = ref(false)
/** 最近一次键盘高度：收起面板时用它当目标，键盘升起的过程里面板让位。 */
const lastIme = ref(0)
let panelToken = 0
let panelRaf = 0
const panelActive = computed(() => quickOpen.value || panelSlotH.value > 0.5)
const bottomBusy = computed(() => panelActive.value || panelBusy.value || keyboardVisible.value)
watch(nativeImeInset, value => { if (value > 0 && value > lastIme.value) lastIme.value = value })
const photoInput = ref<HTMLInputElement | null>(null)
const fullscreenOpen = ref(false)
const fsTextarea = ref<HTMLTextAreaElement | null>(null)
/** 长文本全屏编辑：同一个 text 源，关掉后回到输入框，不额外保存一份草稿。 */
function openFullscreen(): void {
  closeQuick({ focus: false })
  modelSheetOpen.value = false
  effortOpen.value = false
  fullscreenOpen.value = true
  void nextTick(() => fsTextarea.value?.focus())
}
function closeFullscreen(): void {
  fullscreenOpen.value = false
  void nextTick(() => { textarea.value?.focus(); autoGrow() })
}
function sendFromFullscreen(): void {
  fullscreenOpen.value = false
  void submit()
}
/** 添加照片：原生有专用选择器就走原生，否则用隐藏的 file input（走同一条上传链路）。 */
function pickPhoto(): void {
  const bridge = (window as unknown as { CoomiAndroid?: { pickImage?: () => void } }).CoomiAndroid
  if (bridge?.pickImage) { bridge.pickImage(); return }
  photoInput.value?.click()
}
const effortLabel = computed(() => REASONING_EFFORTS.find(item => item.value === config.reasoningEffort)?.label || '自动')
/**
 * 当前模型是否支持思考。
 * 判据来自模型参数里的 reasoningEffort / reasoningField 或能力覆盖；
 * 都没有时按「支持」处理（旧引擎没这些字段，不能凭空禁用）。
 */
const reasoningSupported = computed(() => {
  const provider = config.providers.find(p => p.id === config.currentProviderId)
  if (!provider) return true
  const model = config.currentModel
  const override = model ? provider.capabilityOverrides?.[model] : undefined
  if (override?.reasoning === false) return false
  const params = model ? provider.modelParameters?.[model] : undefined
  if (params?.reasoningEffort || params?.reasoningField) return true
  return true
})

function toggleEffort(): void {
  if (quickOpen.value || panelSlotH.value > 0) closeQuick({ focus: false })
  if (modelSheetOpen.value) modelSheetOpen.value = false
  effortOpen.value = !effortOpen.value
}
function pickEffort(effort: typeof REASONING_EFFORTS[number]['value']): void {
  session.setReasoningEffort(effort)
  effortOpen.value = false
}
const lifeStatsOpen = ref(false)
const transferText = ref('')
const transferProgress = ref(0)
const textareaScrollable = ref(false)
/** 子代理上下文：输入框不允许自定义模型（跟随主会话）。 */
const props = withDefaults(defineProps<{ modelLocked?: boolean }>(), { modelLocked: false })

const hasNative = typeof window !== 'undefined' && !!window.CoomiAndroid

/** 连接没就绪时发送键就是点不动：判据来自 store 的同一个闸门，输入框不另算一套。 */
const canSend = computed(() => text.value.trim().length > 0 && !session.turnBlock)

/**
 * 把输入栏自身高度写到 --composer-h：回到底部圆钮/错误条用它定位，
 * 键盘抬起、错误条出现、输入框长高都自动跟随（不用猜固定 px）。
 */
const composerEl = ref<HTMLElement | null>(null)
let composerRo: ResizeObserver | null = null
/**
 * 输入栏高度的兜底值。
 *
 * 为什么需要：onMounted 那一帧元素刚挂载，offsetHeight 可能还是 0（字体未就绪、
 * 布局未完成）。直接写 0px 会让「回到底部」按钮瞬间贴到屏幕底边再跳回来 ——
 * 这就是「按钮时高时低」的直接原因。低于这个值一律当作尚未测量。
 */
const COMPOSER_H_MIN = 56
function applyComposerHeight(el: HTMLElement) {
  const h = el.offsetHeight
  const value = h >= COMPOSER_H_MIN ? h : COMPOSER_H_MIN
  document.documentElement.style.setProperty('--composer-h', `${Math.round(value)}px`)
}
onMounted(() => {
  const el = composerEl.value
  if (!el) return
  // 先同步写一次，不等 ResizeObserver：观察器的首次回调在下一帧，
  // 中间那一帧按钮位置用的是 CSS 里的兜底值 96px，会跟实际高度对不上。
  applyComposerHeight(el)
  if (typeof ResizeObserver === 'undefined') return
  composerRo = new ResizeObserver(() => applyComposerHeight(el))
  composerRo.observe(el)
})
onBeforeUnmount(() => { composerRo?.disconnect(); composerRo = null })

/** 有待发内容（文本或附件）：即使连不上也要能点，点了才知道为什么发不出去。 */
const hasDraft = computed(() => text.value.trim().length > 0 || session.attachedFiles.length > 0)

/**
 * 输入区是否处于「活跃」态（聚焦或有草稿）：挂在 <html> 上，
 * 让对话页的空态层自动退场。
 *
 * 为什么用 body 类而不是 props 上抛：空态层在 ChatView 里，Composer 是它的
 * 兄弟节点，中间隔着模板层级；用根类名是最短的一条线，且不引入新的响应式依赖
 * 传递链。卸载时必须摘掉，否则下次进入对话页空态层会一直隐身。
 */
function setComposerActive(active: boolean): void {
  if (typeof document === 'undefined') return
  document.documentElement.classList.toggle('cm-composer-active', active)
}
function onInputFocus(): void {
  // 面板开着时拿到焦点：面板让位给键盘（键盘由这次 focus 拉起）。
  if (quickOpen.value) closeQuick({ focus: true })
  setComposerActive(true)
  // 不再 scrollIntoView：键盘弹起时系统会自己调整可视视口，前端再滚一次等于
  // 和键盘抢同一段动画 —— 用户看到的是「先猛地上跳，再弹回来」。
  // 输入栏本来就在 flex 列底部，键盘顶起它即可；消息区只做 padding 变化。
}
function onInputBlur(): void { setComposerActive(hasDraft.value || trayState.open) }
watch([hasDraft, () => trayState.open], ([draft, tray]) => {
  setComposerActive(draft || tray)
})
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('cm-composer-active')
  }
})

// ── §六：模型选择器（从顶栏迁入输入栏；按厂商分组平铺，当前项高亮） ──
const modelSheetOpen = ref(false)

/** 输入栏浮层打开时打一个根标记：让右下角悬浮控件（fixed + z 80）自动让位，
 *  否则它永远压在这些面板上面（缺陷 11）。 */
watch([quickOpen, lifeStatsOpen, modelSheetOpen, effortOpen], ([a, b, c, d]) => {
  if (typeof document === 'undefined') return
  document.body.classList.toggle('cm-panel-open', Boolean(a || b || c || d))
}, { immediate: false })
onBeforeUnmount(() => {
  if (typeof document !== 'undefined') document.body.classList.remove('cm-panel-open')
})

const modelQuery = ref('')
const modelCollapsed = ref<Record<string, boolean>>({})
/** 搜索过滤：命中模型名或厂商名；空查询显示全部。 */
const filteredModelGroups = computed(() => {
  const q = modelQuery.value.trim().toLowerCase()
  return modelGroups.value
    .map(group => ({
      ...group,
      items: q
        ? group.items.filter(item => item.model.toLowerCase().includes(q) || group.label.toLowerCase().includes(q))
        : group.items,
    }))
    .filter(group => group.items.length > 0)
})
function toggleModelGroup(id: string) {
  modelCollapsed.value = { ...modelCollapsed.value, [id]: !modelCollapsed.value[id] }
}
const modelGroups = computed(() => [...config.providers]
  .sort((a, b) => Number(b.id === config.activeId) - Number(a.id === config.activeId))
  .map(provider => ({
    id: provider.id,
    label: provider.name,
    items: [...new Set([...(provider.models ?? []), provider.model].filter(Boolean))]
      .map(model => ({ providerId: provider.id, model: model! })),
  })))
function toggleModelSheet() {
  effortOpen.value = false
  // 子代理会话不允许切换模型（规格：子代理输入框不能自定义模型）。
  if (props.modelLocked) {
    noticeFlash('子代理会话跟随主会话模型')
    return
  }
  // 互斥：打开模型列表时收起功能面板（有序切换，不叠加）。
  if (!modelSheetOpen.value && (quickOpen.value || panelSlotH.value > 0)) {
    closeQuick({ focus: false })
    window.setTimeout(() => { modelSheetOpen.value = true; modelQuery.value = '' }, 160)
    return
  }
  modelSheetOpen.value = !modelSheetOpen.value
  // 与 ⊕ 同规矩：面板是目标，键盘不弹（面板里的搜索框要键盘时才由用户主动点）。
  if (modelSheetOpen.value) { textarea.value?.blur(); modelQuery.value = '' }
}
function pickModel(providerId: string, model: string) {
  modelSheetOpen.value = false
  void session.selectModel(providerId, model)
}
const isJumpIn = computed(() => session.isBusy && canSend.value)
const showStop = computed(() => session.isBusy && !canSend.value)
const modeLabel = computed(() => PERMISSION_MODES.find(m => m.mode === config.permissionMode)?.label ?? '')
const providerReady = computed(() => config.providers.some(provider => (
  provider.id === config.activeId
  && (provider.models.length > 0 || Boolean(provider.model?.trim()))
  && Boolean(provider.baseUrl)
)))

/**
 * 输入框高度走**离散档**（1 / 2 / 5 行），超过 5 行内部滚动。
 *
 * 旧实现每次都把高度设成 scrollHeight（上限 132px）：超过上限后高度在
 * 「内容高 / 132」之间反复，消息区可视高度跟着抖，再叠加贴底跟随 ——
 * 每打一个字上面的消息就跳一次。
 * 离散档只在跨档时改高度，且把高度差通知给消息区做一次滚动补偿。
 */
/* 逐行档：第 3 行不再一次跳 3 行（旧 1/2/5 档单次 72px，观感很硬）。
   只在跨行时改高度，配合下面的滚动补偿，不会回到「每打一字都跳」。 */
const INPUT_LINE_TIERS = [1, 2, 3, 4, 5]
let lastInputLength = 0
function autoGrow() {
  const el = textarea.value
  if (!el) return
  const style = window.getComputedStyle(el)
  const lineHeight = Number.parseFloat(style.lineHeight) || 22
  const padding = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0)
  const previous = el.offsetHeight
  // 只有在「内容变短」时才需要先收缩再量：正常打字是变长，scrollHeight 本身
  // 就是完整内容高度，省掉每键一次「height=0 → 读 → 写」的强制重排。
  const growing = text.value.length >= lastInputLength
  lastInputLength = text.value.length
  if (!growing) el.style.height = '0px'
  const content = Math.max(0, el.scrollHeight - padding)
  const rows = Math.max(1, Math.round(content / lineHeight))
  const tier = Math.min(INPUT_LINE_TIERS[INPUT_LINE_TIERS.length - 1], Math.max(1, rows))
  const next = Math.round(tier * lineHeight + padding)
  textareaScrollable.value = rows > tier
  if (Math.abs(next - previous) < 2) {
    el.style.height = next + 'px'
    return
  }
  el.style.height = next + 'px'
  const delta = next - previous
  if (delta !== 0) {
    window.dispatchEvent(new CustomEvent('coomi:composer-resized', { detail: { delta } }))
  }
}

async function submit() {
  if (session.turnBlock) { noticeFlash(session.turnBlock); return }
  if (!canSend.value && session.attachedFiles.length === 0) return
  // 本地斜杠指令：不进模型，立即处理，避免「无响应」
  const raw = text.value.trim()
  if (raw.startsWith('/')) {
    const handled = await handleLocalSlash(raw)
    if (handled) {
      text.value = ''
      await nextTick()
      autoGrow()
      return
    }
  }
  if (!providerReady.value) {
    await config.fetchProviders()
    const gate = decideProviderGate({ ready: providerReady.value, known: config.providersKnown })
    // 「还没读到」不是「没有模型」：这种时候只说一声，别把人踢进添加模型控制台。
    if (gate === 'reading') {
      noticeFlash(config.lastError ? `模型列表没拉到：${config.lastError}` : '模型列表正在读取，稍等一下再发')
      return
    }
    if (gate === 'add-model') { await router.push('/providers'); return }
  }
  // 文件引用不再拼接到消息文本中，而是作为独立附件随消息发送
  // （界面侧已通过 session.attachedFiles 存储，sendMessage 内部读取并附加到 timeline 条目）
  dockRetired.value = true
  closeQuick({ focus: false })
  session.sendMessage(text.value.trim())
  text.value = ''
  await nextTick()
  autoGrow()
}

/** 处理 /skills 等本地指令；返回 true 表示已消费，不再发给模型。 */
async function handleLocalSlash(raw: string): Promise<boolean> {
  const cmd = raw.split(/\s+/)[0].toLowerCase()
  if (cmd === '/skills' || cmd === '/skill') {
    try {
      // 走 apiGet：带引擎基址（云端时问的是那台电脑，不是手机自己），
      // 并且非 JSON 响应会被翻译成「检查连接」而不是 r.json() 的解析异常。
      const { apiGet } = await import('@/bridge/http')
      const data = await apiGet<{ skills?: Array<{ name: string; description: string }> }>('/api/local-model/skills-list')
      const list = (data.skills ?? []) as Array<{ name: string; description: string }>
      const body = list.length
        ? list.map(s => `· ${s.name}${s.description ? ' — ' + s.description : ''}`).join('\n')
        : '（暂无已安装 Skill）'
      text.value = `已安装 Skill（本地列表，未发给模型）：\n${body}`
      await nextTick()
      autoGrow()
      noticeFlash('已列出本地 Skill')
    } catch (e) {
      noticeFlash(`Skill 列表失败：${e instanceof Error ? e.message : String(e)}`)
    }
    return true
  }
  if (cmd === '/mcp') {
    void router.push('/catalog')
    return true
  }
  if (cmd === '/memory') {
    void router.push('/memory')
    return true
  }
  // /plan /loop /compact 仍交给引擎
  return false
}

let transferTimer = 0
watch(transferText, (value) => {
  if (!value) return
  window.clearTimeout(transferTimer)
  transferTimer = window.setTimeout(() => { transferText.value = ''; transferProgress.value = 0 }, 4000)
})

function noticeFlash(msg: string) {
  // 简单提示：写入输入框上方状态区若无，用 toast 风格 title
  transferText.value = msg
  setTimeout(() => { transferText.value = '' }, 2400)
}

/** 主按钮：空着且在忙 = 停止，其余 = 发送 / 插队。 */
function tapPrimary() {
  if (showStop.value) session.cancel()
  else submit()
}

function onKeydown(e: KeyboardEvent) {
  // Enter 默认换行（需求：换行键就换行）；Ctrl/Cmd+Enter 仍可快捷发送。
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit() }
}

function onInput() {
  autoGrow()
  // 输入 / 时自动弹出指令面板
  if (text.value === '/') quickOpen.value = true
}

function cycleMode() { session.setPermissionMode(config.cyclePermissionMode()) }

// ── 逆向模式 pill：单击开关 / 长按选口味 ──────────────────────────────────
//
// 手势的正确性全靠 decideHold/decideClick（utils/holdGesture.ts）。浏览器在
// pointerup 之后**总会**补发一次 click，漏挡就会变成「长按选完口味开关被翻一次」
// 或「短按翻两次正好抵消 = 点了没反应」。这两个错法在真机上都不报错。
const reverseHoldMs = 450
const reverseHolding = ref(false)
let reverseHoldTimer: ReturnType<typeof setTimeout> | null = null
let reverseHoldPointer: number | null = null
let reverseHoldStart = { x: 0, y: 0 }
let reverseSuppressClick = false
/** 这一次按下是否被滑走取消过。滑走之后补发的 click 也要吞掉，
 *  否则用户从 pill 上划出去再松手，开关会被误切。 */
let reverseMovedAway = false

const reversePillInput = computed(() => ({
  target: config.reverseModeTarget,
  committed: session.reverseModeCommitted,
  consented: session.reverseConsented,
  // 只读权限下契约不会被注入 —— 但不要自动提权，只把状态说清楚。
  permitted: session.reverseHealth !== 'restricted',
  flavor: config.reverseFlavor,
}))
const reverseVerdict = computed(() => reversePillState(reversePillInput.value))
const reverseLabel = computed(() => reversePillLabel(reversePillInput.value))
const reverseHint = computed(() => reversePillTitle(reversePillInput.value))

function clearReverseHold() {
  if (reverseHoldTimer) { clearTimeout(reverseHoldTimer); reverseHoldTimer = null }
  reverseHoldPointer = null
  reverseHolding.value = false
}

function onReversePointerDown(event: PointerEvent) {
  // 只认主键 / 触摸，右键留给 contextmenu.prevent 之外的其他用途。
  if (event.pointerType === 'mouse' && event.button !== 0) return
  clearReverseHold()
  reverseHoldPointer = event.pointerId
  reverseSuppressClick = false
  reverseMovedAway = false
  reverseHoldStart = { x: event.clientX, y: event.clientY }
  reverseHoldTimer = setTimeout(() => {
    reverseHoldTimer = null
    reverseHolding.value = true
    // 长按到点就开 sheet，并标记「这次不要当成单击」。
    reverseSuppressClick = true
    try { navigator.vibrate?.(18) } catch { /* 无振动马达：静默跳过 */ }
    // 未同意免责时长按也走同一个 sheet —— 它会先显示风险提示，
    // 用户同意后自动落到口味选择，不需要二次操作。
    session.openReverseSheet()
  }, reverseHoldMs)
}

function onReversePointerMove(event: PointerEvent) {
  if (reverseHoldPointer !== event.pointerId || !reverseHoldTimer) return
  const dx = event.clientX - reverseHoldStart.x
  const dy = event.clientY - reverseHoldStart.y
  if (movedBeyondSlop(dx, dy)) { reverseMovedAway = true; clearReverseHold() }
}

function onReversePointerUp(event: PointerEvent) {
  if (reverseHoldPointer !== null && reverseHoldPointer !== event.pointerId) return
  // 判定交给纯函数（utils/holdGesture.ts）：那里把「长按 / 短按 / 划走 /
  // 非主键」四种情形穷举了，并有单元测试钉住。这里只负责把事实喂进去、
  // 把结果执行掉。事件顺序的正确性全靠它。
  const outcome = decideHold({
    primaryButton: event.button === 0 || event.pointerType !== 'mouse',
    movedBeyondSlop: reverseMovedAway,
    heldToCompletion: reverseHolding.value,
    releasedBeforeTimer: reverseHoldTimer !== null,
  })
  clearReverseHold()
  if (outcome === 'open-sheet') {
    // 长按已在计时器回调里开了 sheet。留下吞 click 的标记，
    // 交给 onReverseClick 消费 —— **不能在这里清**，否则补发的 click 会把开关翻一次。
    return
  }
  if (outcome === 'toggle') {
    reverseSuppressClick = true
    session.toggleReverseMode()
    return
  }
  if (outcome === 'swallow') {
    // 划走 / 非主键：补发的 click 也必须被吞掉，否则从 pill 上划出去再松手会把开关误切。
    reverseSuppressClick = true
    return
  }
  // 'ignore'：连 pointerdown 都没正常开始过，不碰 click 标记。
}

function onReversePointerCancel() { clearReverseHold() }

/**
 * 指针离开 pill 时取消长按。
 *
 * 不能复用 onReversePointerMove：那个函数只在**位移超阈值**时才取消，
 * 而 pointerleave 可能是「位移很小但元素被滚走/键盘顶起」造成的 ——
 * 那种情况不取消，计时器会继续跑到点，在用户手指已经离开的情况下
 * 突然弹出 sheet。这里无条件取消。
 *
 * 触摸设备上 pointerleave 在 pointerup 之后才触发，此时计时器已清，
 * clearReverseHold 是幂等的，不会误伤刚完成的短按。
 */
function onReversePointerLeave() {
  // 已经长按触发（sheet 已开）就不动它，否则用户手指一滑就把面板关了。
  if (reverseHolding.value) return
  clearReverseHold()
}

/** click 兜底：某些 WebView 不派 pointerup（比如手势被系统截走）时仍会来 click。 */
function onReverseClick(event: MouseEvent) {
  // 判定同样在纯函数里：'吞掉 / 忽略 / 当短按' 三选一。
  // pointerHandled 用「这次 click 之前有没有走过 pointerdown」判断。
  const outcome = decideClick(reverseSuppressClick, reverseHoldPointer !== null || reverseHolding.value)
  // 标记是一次性的：不管走哪个分支都清掉，不能留到下一次点击。
  reverseSuppressClick = false
  if (outcome === 'swallow') { event.preventDefault(); return }
  if (outcome === 'toggle') session.toggleReverseMode()
}

onBeforeUnmount(clearReverseHold)

async function insert(t: string) {
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + '\n' + t : t
  closeQuick({ focus: true })
  await nextTick()
  autoGrow()
  textarea.value?.focus()
}

/** 斜杠指令：直接替换输入框内容，可继续编辑。 */
async function insertSlash(cmd: string) {
  text.value = cmd
  closeQuick({ focus: true })
  await nextTick()
  autoGrow()
  textarea.value?.focus()
}

function cancelPanelRaf(): void {
  if (panelRaf) { cancelAnimationFrame(panelRaf); panelRaf = 0 }
}

/**
 * 当前键盘占用的高度（CSS px），以**布局真实收缩量**为准。
 *
 * 原生把键盘垫在 content view 上，WebView 的 innerHeight 会同步变矮；用这个差值
 * 做补偿，和布局在同一帧生效。只读原生推送值会在「系统已经改布局、JS 还没收到」
 * 的那一帧产生最多 20~30px 的错位（真机上就是 hold 段的细微抖动）。
 */
let baseViewportHeight = 0
function imeNow(): number {
  if (typeof window === 'undefined') return 0
  const native = Math.max(0, nativeImeInset.value)
  // 没有键盘也没有面板：视口就是全高，顺便校准基准（覆盖横竖屏 / 分屏）。
  if (native <= 1 && !keyboardVisible.value && panelSlotH.value <= 0.5) {
    baseViewportHeight = window.innerHeight
    return 0
  }
  if (!baseViewportHeight) baseViewportHeight = window.innerHeight + native
  const shrink = Math.max(0, Math.round(baseViewportHeight - window.innerHeight))
  if (shrink > 1) return shrink
  return native
}

function finishPanel(open: boolean): void {
  cancelPanelRaf()
  panelBusy.value = false
  panelLift.value = 0
  if (open) {
    panelSlotH.value = panelFullH.value
  } else {
    panelSlotH.value = 0
    quickOpen.value = false
  }
}

/**
 * 展开加号面板：键盘先退，面板按“接住键盘让出的空间”的节奏长出来。
 * 关键点是 from/to/nativeReserve 三者一起交给 handoffFrame，输入栏的
 * 屏幕位置只按 (键盘高 → 面板高) 的差值移动，不会出现「两块同屏」。
 */
function openQuick(): void {
  if (quickOpen.value || panelBusy.value) return
  effortOpen.value = false
  lifeStatsOpen.value = false
  modelSheetOpen.value = false
  const token = ++panelToken
  cancelPanelRaf()
  const ime = imeNow()
  // 目标高度按「整屏高」算：键盘弹起时 innerHeight 已经变矮，不能拿它当基准。
  const screenHeight = window.innerHeight + ime
  panelFullH.value = Math.round(Math.min(screenHeight * 0.42, 340))
  panelSlotH.value = 0
  panelLift.value = 0
  panelBusy.value = true
  quickOpen.value = true
  const startedAt = performance.now()
  const holdMs = ime > 1 ? 260 : 0
  const adjustMs = ime > 1 ? 160 : 240
  const from = ime
  const to = panelFullH.value
  let holdElapsed: number | undefined
  // 先以 0 高度就位再 blur：键盘退场的第一帧就有容器接住，不会先掉一帧。
  textarea.value?.blur()
  const step = (now: number) => {
    if (token !== panelToken) return
    const native = imeNow()
    const elapsed = now - startedAt
    const holdDone = ime > 1 && native <= Math.max(1, ime * 0.04)
    if (holdDone && holdElapsed == null) holdElapsed = elapsed
    const frame = handoffFrame({
      from, to, nativeReserve: native, elapsed, holdMs, adjustMs, holdDone, holdElapsed,
    })
    panelSlotH.value = frame.panelH
    if (frame.phase !== 'done') {
      panelRaf = requestAnimationFrame(step)
      return
    }
    // 收尾：reserve 已经到目标，但键盘可能还没完全退场（慢速输入法）。
    // 这时不能把面板强行拉满 —— 那会让「原生垫高 + 面板」超量，输入栏被顶一下。
    // 保持 reserve = to，等 native 退到 0 再落定（1.5s 兜底，防止个别机型不回报 0）。
    if (native > 1 && elapsed < 1500) {
      panelSlotH.value = Math.max(0, to - native)
      panelRaf = requestAnimationFrame(step)
      return
    }
    // 个别输入法拒绝 blur：面板拿不到空间，取消展开，绝不回到「两块都在」。
    if (frame.panelH < 1) {
      quickOpen.value = false
      panelSlotH.value = 0
      panelBusy.value = false
      panelLift.value = 0
      return
    }
    finishPanel(true)
  }
  panelRaf = requestAnimationFrame(step)
}

/** 收起加号面板。focus=true 表示接下来要弹键盘（点输入框 / 插入指令）。 */
function closeQuick(options: { focus?: boolean } = {}): void {
  if (!quickOpen.value && panelSlotH.value <= 0) return
  const token = ++panelToken
  cancelPanelRaf()
  const focus = options.focus === true
  const to = focus ? lastIme.value : 0
  const from = Math.max(0, panelSlotH.value)
  quickOpen.value = false
  panelBusy.value = true
  if (focus) textarea.value?.focus({ preventScroll: true })
  const startedAt = performance.now()
  const holdMs = focus && to > 1 ? 240 : 0
  const adjustMs = focus && to > 1 ? 140 : 180
  let holdElapsed: number | undefined
  const step = (now: number) => {
    if (token !== panelToken) return
    const native = imeNow()
    const elapsed = now - startedAt
    const holdDone = focus && to > 1 && native >= Math.max(1, to * 0.96)
    if (holdDone && holdElapsed == null) holdElapsed = elapsed
    const frame = handoffFrame({
      from, to, nativeReserve: native, elapsed, holdMs, adjustMs, holdDone, holdElapsed,
    })
    panelSlotH.value = frame.panelH
    if (frame.phase !== 'done') {
      panelRaf = requestAnimationFrame(step)
      return
    }
    // 同理：键盘还没升到位时，面板要留在剩余空间里让位，不能直接清零。
    if (focus && to > 1 && native < to - 1 && elapsed < 1500) {
      panelSlotH.value = Math.max(0, to - native)
      panelRaf = requestAnimationFrame(step)
      return
    }
    finishPanel(false)
  }
  panelRaf = requestAnimationFrame(step)
}

function onScrimTap(): void {
  if (quickOpen.value || panelSlotH.value > 0) closeQuick()
  lifeStatsOpen.value = false
  modelSheetOpen.value = false
}

/**
 * 输入区这些面板（指令托盘 / 思考强度 / 模型 / 生命体数据 / 全屏编辑 / 引擎提示）
 * 都属于「对话页里的一层浮层」：系统返回必须先收起它。
 * 旧行为是直接 exit，用户在展开面板时划一下就把整个会话关掉了。
 *
 * 注意：必须在所有 ref 声明**之后**再建这个 computed（engineDialogOpen 在下面），
 * 否则 setup 期读 TDZ 变量会整页白屏。
 */
function closeComposerOverlay(): void {
  if (fullscreenOpen.value) { fullscreenOpen.value = false; return }
  if (engineDialogOpen.value) { engineDialogOpen.value = false; return }
  if (effortOpen.value) { effortOpen.value = false; return }
  if (lifeStatsOpen.value) { lifeStatsOpen.value = false; return }
  if (modelSheetOpen.value) { modelSheetOpen.value = false; return }
  closeQuick()
}

function toggleQuick(): void {
  effortOpen.value = false
  if (panelBusy.value) return
  if (quickOpen.value) { closeQuick(); return }
  openQuick()
}

/** 功能托盘（☰）：展开时按钮从输入框后逐个浮出，运行状态行同步上推渐隐。 */
function toggleTray() { trayState.open = !trayState.open }
function toggleLifeStats() { lifeStatsOpen.value = !lifeStatsOpen.value }

const fileInput = ref<HTMLInputElement | null>(null)
function importFiles() {
  const bridge = window.CoomiAndroid
  if (bridge?.importFiles) { bridge.importFiles(); return }
  fileInput.value?.click()
}
/** 浏览器/云端：选文件 → 走加密 P2P 上传到电脑 incoming 目录 → 用电脑端路径做附件。 */
async function onLocalFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const files = Array.from(input.files ?? [])
  input.value = ''
  if (!files.length) return
  let done = 0
  for (const file of files) {
    try {
      transferText.value = '正在上传 ' + file.name
      transferProgress.value = 0
      const uploaded = await session.uploadAttachment(file, file.name, (percent) => {
        transferProgress.value = percent
        transferText.value = '正在上传 ' + file.name + ' · ' + Math.round(percent) + '%'
      })
      session.addAttachedFile(uploaded.path)
      done += 1
    } catch (error) {
      transferText.value = error instanceof Error ? error.message : '文件上传失败'
      transferProgress.value = 0
      window.setTimeout(() => { transferText.value = '' }, 3000)
      return
    }
  }
  transferText.value = '已上传 ' + done + ' 个文件'
  transferProgress.value = 100
  window.setTimeout(() => { transferText.value = ''; transferProgress.value = 0 }, 2600)
}
function authorizeFolder() { window.CoomiAndroid?.authorizeFolder?.() }

function onTransferProgress(event: Event) {
  const detail = (event as CustomEvent<{ message?: string; progress?: number }>).detail ?? {}
  transferText.value = detail.message ?? '正在传输文件'
  transferProgress.value = detail.progress ?? 0
}

function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[]; requestId?: string }>).detail ?? {}
  const paths = detail.paths ?? []
  transferText.value = paths.length ? `已导入 ${paths.length} 个文件` : '文件导入完成'
  transferProgress.value = 100
  if (detail.requestId) session.completeFileTransfer(detail.requestId, paths)
  else if (paths.length) {
    // 新增：添加文件 chip 而不是直接填入输入框文本
    paths.forEach(p => session.addAttachedFile(p))
  }
  setTimeout(() => { transferText.value = ''; transferProgress.value = 0 }, 2600)
}

function onFileExported(event: Event) {
  const detail = (event as CustomEvent<{ requestId?: string; path?: string }>).detail ?? {}
  if (detail.requestId) session.completeFileTransfer(detail.requestId, detail.path ? [detail.path] : [])
}

function onPrefillDraft(event: Event) {
  const detail = (event as CustomEvent<{ sessionId?: string; text?: string }>).detail ?? {}
  if ((detail.sessionId && detail.sessionId !== session.sessionId) || typeof detail.text !== 'string') return
  text.value = detail.text
  void nextTick(autoGrow)
}

// ── C 块语音输入：按住输入框中部 = 微信式说话 ─────────────────────────
// 空栏限定（有文字时交给系统复制/粘贴菜单）；开头 64px 也留给系统菜单。
// 首次使用弹引擎选择（离线中文 / 云模型 / 系统服务），之后设置页可改。
const voiceActive = ref(false)
/** 语音模式：输入框上方出现「按住说话」大按钮 */
const voiceArmed = ref(false)
let voiceFieldRect: DOMRect | null = null
const voicePartial = ref('')
const voiceCancelled = ref(false)
const engineDialogOpen = ref(false)
const voiceEngine = ref('unset')

/** 这里（所有 ref 都已声明）才安全地建立「输入区浮层」的追踪与返回栈登记。 */
const composerOverlayOpen = computed(() =>
  panelActive.value || effortOpen.value || modelSheetOpen.value || lifeStatsOpen.value
  || engineDialogOpen.value || fullscreenOpen.value,
)
watch(composerOverlayOpen, open => {
  if (open) registerOverlay('composer-overlay', closeComposerOverlay)
  else unregisterOverlay('composer-overlay')
})
onBeforeUnmount(() => unregisterOverlay('composer-overlay'))
let holdTimer: ReturnType<typeof setTimeout> | null = null
let holdStart = { x: 0, y: 0 }
let holdPointerId = -1
/** 手势累计位移（movementY 累加：不受软键盘/浮层导致的视口缩放影响，也不依赖 screenY）。 */
let voiceMoveY = 0
let voiceStartAt = 0
const voiceElapsed = ref(0)
let voiceTimer: number | undefined
/** 松开后等待识别结果（云端上传/系统识别）的中间态。 */
const voiceBusy = ref(false)
let voiceOverFrames = 0
const voiceProgress = ref(0)
let holdMoved = false
/** 上次手势是取消：在途的识别结果要丢弃（松手取消后不该再插入文字）。 */
let voiceResultSuppressed = false

// 麦克风常驻：不再因为输入框有文字就消失（用户会以为坏了）
const voiceUsable = computed(() => hasNative && !!window.CoomiAndroid?.startVoiceInput)

function loadVoiceConfig() {
  if (!hasNative || !window.CoomiAndroid?.getVoiceConfig) return
  try { voiceEngine.value = JSON.parse(window.CoomiAndroid.getVoiceConfig() ?? '{}').engine ?? 'unset' } catch { /* ignore */ }
}

function clearHoldTimer() { if (holdTimer) { clearTimeout(holdTimer); holdTimer = null } }

/** 语音结果清洗：折叠空白 + 去掉中文（含全角标点）之间的多余空格。 */
function normalizeVoiceText(raw: string): string {
  const cjk = '[\\u3000-\\u303f\\u4e00-\\u9fff\\uff00-\\uffef]'
  return raw
    .replace(/\s+/g, ' ')
    .replace(new RegExp('(' + cjk + ') +', 'g'), '$1')
    .replace(new RegExp(' +(' + cjk + ')', 'g'), '$1')
    .trim()
}

/** 按住说话大按钮：按下开始录音；输入区矩形用于判定"是否滑出输入区"。 */
function startVoiceClock() {
  voiceElapsed.value = 0
  if (voiceTimer) window.clearInterval(voiceTimer)
  voiceTimer = window.setInterval(() => { voiceElapsed.value = Math.floor((Date.now() - voiceStartAt) / 1000) }, 250)
}
function stopVoiceClock() {
  if (voiceTimer) window.clearInterval(voiceTimer)
  voiceTimer = undefined
}
function fmtVoiceTime(sec: number): string {
  const m = Math.floor(sec / 60), s = sec % 60
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}
function buzz(ms: number) { try { navigator.vibrate?.(ms) } catch { /* ignore */ } }

function onVoiceArmDown(e: PointerEvent) {
  const field = (e.currentTarget as HTMLElement).closest('.composer')?.querySelector('.input-clip') as HTMLElement | null
  voiceFieldRect = field ? field.getBoundingClientRect() : null
  voiceCancelled.value = false
  voiceProgress.value = 0
  voicePartial.value = ''
  voiceActive.value = true
  voiceStartAt = Date.now()
  voiceOverFrames = 0
  startVoiceClock()
  window.CoomiAndroid?.startVoiceInput?.()
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
}

/** 滑动：只切红/蓝视觉，**不停止识别**（松手才停）。 */
function onVoiceArmMove(e: PointerEvent) {
  if (!voiceActive.value) return
  const rect = voiceFieldRect
  const above = rect ? e.clientY < rect.top - 8 : false
  if (above !== voiceCancelled.value) buzz(above ? 18 : 10)
  voiceCancelled.value = above
  if (rect) {
    const h = Math.max(1, rect.height)
    voiceProgress.value = above ? 1 : Math.max(0, Math.min(1, (rect.top - e.clientY) / h))
  }
}

/** 松手：此刻才真正 stop；红色态 = 取消。 */
let voiceTimeout: number | undefined
function onVoiceArmUp() {
  if (!voiceActive.value) return
  stopVoiceClock()
  const cancel = voiceCancelled.value
  voiceArmed.value = false
  window.CoomiAndroid?.stopVoiceInput?.(cancel ? '1' : '0')
  if (cancel) { voiceActive.value = false; voiceBusy.value = false; return }
  // 不立刻收浮层：保持"正在识别…"，直到结果/错误回来（否则用户以为没发送）
  voiceBusy.value = true
  if (voiceTimeout) window.clearTimeout(voiceTimeout)
  voiceTimeout = window.setTimeout(() => {
    if (!voiceActive.value) return
    voiceActive.value = false
    voiceBusy.value = false
    noticeFlash?.('没有收到识别结果，请检查麦克风权限/语音引擎')
  }, 6000)
}

function onFieldPointerDown(e: PointerEvent) {
  // 加号面板展开时点输入框：先让面板收起，稍后再聚焦。两者同时进行时，
  // 键盘把输入栏顶高、面板塌陷又把它放下来 —— 用户看到的就是向上闪一下。
  if (quickOpen.value) {
    // 面板开着时点输入框：面板让位、键盘回来。交接由 rAF 驱动，
    // 输入栏只按「面板高 - 键盘高」的差值落位，不会先掉下去再弹回来。
    e.preventDefault()
    closeQuick({ focus: true })
    return
  }
  // 已经打了字：完全交还给原生 —— 不拦 pointerdown（否则光标移不到文字中间），
  // 也不启用长按语音。语音只在空输入框上生效。
  if (text.value.trim().length > 0) return
  if (!voiceUsable.value) return
  if (e.pointerType === 'mouse' && !isDemoMode()) return
  const el = e.currentTarget as HTMLElement
  const rect = el.getBoundingClientRect()
  if (e.clientX - rect.left < 64) return // 「开头」区域留给系统复制/粘贴长按菜单
  e.preventDefault()
  // 指针捕获：手指滑出输入区后 move/up 仍然送到这里 ——
  // 之前没捕获，滑到消息区就收不到事件，表现为「上滑取消无效」甚至卡住。
  try { el.setPointerCapture(e.pointerId) } catch { /* ignore */ }
  holdStart = { x: e.clientX, y: e.clientY }
  holdPointerId = e.pointerId
  voiceMoveY = 0
  voiceStartAt = Date.now()
  voiceOverFrames = 0
  voiceProgress.value = 0
  holdMoved = false
  holdTimer = setTimeout(() => {
    holdTimer = null
    if (!holdMoved) beginHoldVoice()
  }, 180)
}

/** 取消区阈值：越过 -70 进入「松开即取消」；滑回 -45 以内自动继续听（滞回，避免边界抖动）。 */
const CANCEL_DY = -56
const RESUME_DY = -34

function onFieldPointerMove(e: PointerEvent) {
  if (!holdTimer && !voiceActive.value) return
  if (e.pointerId !== holdPointerId) return // 多指/手掌误触：只认最初那根手指
  if (Math.abs(e.clientX - holdStart.x) > 12) holdMoved = true
  if (!voiceActive.value) return
  // 判定重写：clientY 位移（页面在录音期间被冻结，坐标可靠）+ 起步保护 + 双帧确认 + 滞回
  const dy = e.clientY - holdStart.y
  voiceMoveY = dy
  voiceProgress.value = Math.min(1, Math.max(0, -dy / Math.abs(CANCEL_DY)))
  if (Date.now() - voiceStartAt < 180) return            // 起步 180ms 内忽略抖动
  if (!voiceCancelled.value) {
    // 需要连续两帧都超过阈值才取消（过滤单帧毛刺/视口跳动）
    voiceOverFrames = dy <= CANCEL_DY ? voiceOverFrames + 1 : 0
    if (voiceOverFrames >= 2) {
      voiceCancelled.value = true
      try { navigator.vibrate?.(12) } catch { /* ignore */ }
    }
  } else if (dy >= RESUME_DY) {
    voiceCancelled.value = false
    voiceOverFrames = 0
  }
}

function onFieldPointerUp(e: PointerEvent) {
  if (e.pointerId !== holdPointerId && holdPointerId !== -1) return
  const el = e.currentTarget as HTMLElement | null
  try { if (el) el.releasePointerCapture(e.pointerId) } catch { /* ignore */ }
  const wasHolding = holdTimer != null
  clearHoldTimer()
  if (voiceActive.value) {
    // 取消后可能还有一段在途结果：记下来，让 onVoiceResult 丢弃。
    voiceResultSuppressed = voiceCancelled.value
    // 原生签名是 stopVoiceInput(String cancel)：传 boolean 会被桥直接忽略（会话停不掉、界面不消失）。
    voiceBusy.value = !voiceCancelled.value
    window.CoomiAndroid?.stopVoiceInput?.(voiceCancelled.value ? '1' : '0')
    if (voiceCancelled.value) { voiceActive.value = false; return }
    // 非取消：保留浮卡显示「正在识别…」，等结果/错误回来再关闭
    if (voiceTimeout) window.clearTimeout(voiceTimeout)
    voiceTimeout = window.setTimeout(() => {
      if (!voiceActive.value) return
      voiceActive.value = false; voiceBusy.value = false
      noticeFlash?.('没有收到识别结果，请检查麦克风权限/语音引擎')
    }, 6000)
    return
  }
  // 空栏快速点按：手动聚焦弹软键盘（pointerdown 的 preventDefault 挡掉了原生路径）。
  if (wasHolding && !holdMoved) textarea.value?.focus()
}

/** 语音按住期间屏蔽系统长按菜单/选择；平时放行（开头区域的复制粘贴要靠系统菜单）。 */
function onInputContextMenu(e: Event) {
  if (voiceActive.value) e.preventDefault()
}

function beginHoldVoice() {
  if (voiceEngine.value === 'unset') { engineDialogOpen.value = true; return }
  voiceResultSuppressed = false
  voiceActive.value = true
  voicePartial.value = ''
  voiceCancelled.value = false
  window.CoomiAndroid?.startVoiceInput?.()
}

/** 首用引擎选择（选过一次只在设置页调整）。 */
function pickVoiceEngine(engine: string) {
  window.CoomiAndroid?.setVoiceEngine?.(engine)
  voiceEngine.value = engine
  engineDialogOpen.value = false
  noticeFlash(engine === 'builtin' ? '已选内置流式识别，按住说话' : engine === 'cloud' ? '已选云模型（设置页配置接口），按住说话' : '已选系统服务，按住说话')
}

function onVoiceResult(event: Event) {
  const detail = (event as CustomEvent<{ text?: string }>).detail ?? {}
  if (voiceTimeout) { window.clearTimeout(voiceTimeout); voiceTimeout = undefined }
  voiceBusy.value = false
  voiceActive.value = false
  voicePartial.value = ''
  if (voiceResultSuppressed) { voiceResultSuppressed = false; return }
  const heard = normalizeVoiceText(detail.text ?? '')
  if (!heard) return
  text.value = text.value.trim() ? text.value.replace(/\s+$/, '') + ' ' + heard : heard
  void nextTick(() => {
    autoGrow()
    textarea.value?.focus()
    // 松手即发送：识别结果落框后直接提交（submit 内部自会处理未配置模型等情况）。
    void submit()
  })
}

function onVoicePartial(event: Event) {
  const detail = (event as CustomEvent<{ text?: string }>).detail ?? {}
  voicePartial.value = detail.text ?? ''
}

function onVoiceError(event: Event) {
  const detail = (event as CustomEvent<{ text?: string }>).detail ?? {}
  if (voiceTimeout) { window.clearTimeout(voiceTimeout); voiceTimeout = undefined }
  voiceBusy.value = false
  voiceActive.value = false
  voicePartial.value = ''
  noticeFlash(detail.text || '语音识别失败')
}

onMounted(() => {
  window.addEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:file-exported', onFileExported)
  window.addEventListener('coomi:prefill-draft', onPrefillDraft)
  window.addEventListener('coomi:voice-result', onVoiceResult)
  window.addEventListener('coomi:voice-partial', onVoicePartial)
  window.addEventListener('coomi:voice-error', onVoiceError)
  loadVoiceConfig()
  loadDraft()
})
onBeforeUnmount(() => {
  window.removeEventListener('coomi:file-transfer-progress', onTransferProgress)
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:file-exported', onFileExported)
  window.removeEventListener('coomi:prefill-draft', onPrefillDraft)
  window.removeEventListener('coomi:voice-result', onVoiceResult)
  window.removeEventListener('coomi:voice-partial', onVoicePartial)
  window.removeEventListener('coomi:voice-error', onVoiceError)
  saveDraft()
})

// ── 草稿按会话持久化：每个会话（含新对话）各自保留输入框内容 ──
const DRAFT_PREFIX = 'coomi.draft.'
let draftTimer: ReturnType<typeof setTimeout> | null = null

function draftKey(id: string) { return DRAFT_PREFIX + id }

function loadDraft() {
  let saved = ''
  try { saved = localStorage.getItem(draftKey(session.sessionId)) ?? '' } catch { /* ignore */ }
  text.value = saved
  void nextTick(autoGrow)
}

function saveDraft() {
  if (draftTimer) { clearTimeout(draftTimer); draftTimer = null }
  try { localStorage.setItem(draftKey(session.sessionId), text.value) } catch { /* ignore */ }
}

// 切会话（含新建会话）时：先把旧会话的草稿存回【旧】key，再加载新会话草稿。
// 注意：watch 回调里 session.sessionId 已经是新值，保存必须用回调的 prev 参数，
// 否则旧内容会被写进新会话的 key，导致所有会话显示同一个草稿。
watch(() => session.sessionId, (next, prev) => {
  if (prev && prev !== next) {
    try { localStorage.setItem(draftKey(prev), text.value) } catch { /* ignore */ }
  }
  loadDraft()
})
watch(text, () => {
  if (draftTimer) clearTimeout(draftTimer)
  draftTimer = setTimeout(saveDraft, 200)
})
</script>

<template>
  <div ref="composerEl" class="composer">
    <input ref="fileInput" type="file" multiple class="file-input" @change="onLocalFiles" />
    <div v-if="session.pendingEdit" class="edit-banner">
      <span>正在编辑上一条消息，发送将覆盖该轮执行</span>
      <button @click="session.cancelEditMessage()">取消编辑</button>
    </div>
    <!-- 计划进度胶囊：有 update_plan 出来的任务才显示；托盘展开时整条让位。 -->
    <PlanCapsule
      :steps="session.plan.steps"
      :completed="session.plan.completed"
      :total="session.plan.total"
      :mode-on="config.planMode"
      :hidden="trayState.open || effortOpen || modelSheetOpen || quickOpen"
      @exit="session.togglePlanMode()"
    />
    <!-- 编辑重发：旧版本已由引擎存成独立分支，这里给一个直达入口 -->
    <div v-if="session.branchSaving && !trayState.open" class="branch-banner">
      <span>正在保存旧版本…</span>
    </div>
    <div v-else-if="session.branchNotice && !trayState.open" class="branch-banner">
      <CoomiIcon name="git" :size="14" />
      <span>旧版本已保存为分支</span>
      <button class="go" @click="session.openBranch()">打开分支</button>
      <button class="ghost-btn" @click="session.dismissBranchNotice()">知道了</button>
    </div>
    <!-- 连接状态只由顶部 ConnectionBanner 报一次：这里再挂一条「未连接：消息没有发出」
         会和顶栏重复，而且在用户还没发送时就宣布「没发出」，因果是错的。 -->
    <!-- 缺模型配置：把话挂在输入框上方，按了才跳页——引擎说缺配置不等于允许我搬走用户的页面。 -->
    <div v-if="session.configPrompt" class="config-banner">
      <span>{{ session.configPrompt.text }}</span>
      <button v-if="session.configPrompt.action" class="go" @click="session.configureModel()">{{ session.configPrompt.action.label }}</button>
      <button class="ghost-btn" @click="session.dismissConfigPrompt()">知道了</button>
    </div>
    <div v-if="transferText" class="transfer" role="status">
      <span>{{ transferText }}</span>
      <progress v-if="transferProgress > 0 && transferProgress < 100" :value="transferProgress" max="100" />
      <button class="transfer-x" aria-label="关闭提示" @click="transferText = ''">×</button>
    </div>
    <!-- 首用语音引擎选择：选过一次后只在设置页调整 -->
    <Teleport to="body">
      <div v-if="engineDialogOpen" class="quick-scrim" @click="engineDialogOpen = false" />
    </Teleport>
    <div v-if="engineDialogOpen" class="engine-sheet">
      <p class="qhead">语音输入方式</p>
      <button class="engine-row" @click="pickVoiceEngine('builtin')">
        <span class="eicon"><CoomiIcon name="sparkle" :size="17" /></span>
        <span class="etext"><strong>内置流式识别</strong><small>sherpa-onnx zipformer · 离线实时转写</small></span>
      </button>
      <button class="engine-row" @click="pickVoiceEngine('cloud')">
        <span class="eicon"><CoomiIcon name="arrowUp" :size="17" /></span>
        <span class="etext"><strong>云语音模型</strong><small>Whisper 兼容接口 · 需在设置页配置后使用</small></span>
      </button>
      <button class="engine-row" @click="pickVoiceEngine('system')">
        <span class="eicon"><CoomiIcon name="shield" :size="17" /></span>
        <span class="etext"><strong>系统语音服务</strong><small>部分机型可用（无谷歌服务机型常缺）</small></span>
      </button>
    </div>
    <div v-if="session.collaboration.active" class="collaboration-status">
      <CoomiIcon name="subtask" :size="14" />
      <span>协作第 {{ session.collaboration.cycle }} 轮 · {{ session.collaboration.phase === 'reviewer' ? '审查模型' : '改码模型' }}{{ session.collaboration.status === 'running' ? '处理中' : session.collaboration.status }}</span>
    </div>
    <!-- 遮罩不能再 Teleport 到 body：那样它会被提到根层叠上下文（z 70），
         而面板留在 .shell（z 1）里，导致遮罩永远压在面板之上 ——
         点「选择文件/授权目录」时命中的是遮罩，面板被直接关掉（缺陷 8）。
         放在这里就与面板同一个层叠上下文，z 值才可比。 -->
    <div v-if="panelActive || lifeStatsOpen || modelSheetOpen" class="quick-scrim" @click="onScrimTap" />
    <Transition name="sheet-slide">
    <div v-if="modelSheetOpen" class="model-sheet">
      <!-- 搜索栏：按模型名 / 厂商名过滤（键盘由用户主动点搜索框时才弹） -->
      <div class="model-search">
        <CoomiIcon name="terminal" :size="15" class="ms-icon" />
        <input v-model="modelQuery" type="search" placeholder="搜索模型或厂商" aria-label="搜索模型" enterkeyhint="search" />
      </div>
      <div class="model-scroll">
        <template v-for="group in filteredModelGroups" :key="group.id">
          <button class="model-group-head" @click="toggleModelGroup(group.id)">
            <span>{{ group.label }}</span>
            <span class="mgh-count">{{ group.items.length }}</span>
            <CoomiIcon name="chevronRight" :size="13" class="mgh-chev" :class="{ open: !modelCollapsed[group.id] }" />
          </button>
          <div v-if="!modelCollapsed[group.id]" class="model-group-body">
            <button
              v-for="item in group.items"
              :key="item.providerId + ':' + item.model"
              class="model-row"
              :class="{ selected: item.providerId === config.currentProviderId && item.model === config.currentModel }"
              @click="pickModel(item.providerId, item.model)"
            >
              <span class="model-name">{{ item.model }}</span>
              <CoomiIcon v-if="item.providerId === config.currentProviderId && item.model === config.currentModel" name="check" :size="15" />
            </button>
          </div>
        </template>
        <p v-if="filteredModelGroups.length === 0" class="model-empty-hint">{{ modelGroups.length ? '没有匹配的模型' : (config.lastError ? `模型列表没拉到：${config.lastError}` : '暂无已配置供应商，去设置页添加') }}</p>
      </div>
    </div>
    </Transition>
    <div v-if="effortOpen" class="effort-scrim" @click="effortOpen = false" />
    <Transition name="sheet-slide">
    <div v-if="effortOpen" class="effort-sheet" role="dialog" aria-label="思考强度">
      <header class="effort-head">
        <CoomiIcon name="brain" :size="16" class="effort-ico" />
        <span>思考强度</span>
        <button class="effort-close" aria-label="关闭思考强度" @click="effortOpen = false">
          <CoomiIcon name="close" :size="14" />
        </button>
      </header>
      <p v-if="!reasoningSupported" class="effort-off">
        当前模型不支持思考强度，选择会被忽略。
      </p>
      <button
        v-for="item in REASONING_EFFORTS"
        :key="item.value"
        class="effort-row"
        :class="{ on: config.reasoningEffort === item.value, off: !reasoningSupported }"
        :disabled="!reasoningSupported"
        @click="pickEffort(item.value)"
      >
        <span class="ef-main"><b>{{ item.label }}</b><small>{{ REASONING_HINT[item.value] }}</small></span>
        <CoomiIcon v-if="config.reasoningEffort === item.value" name="check" :size="15" />
      </button>
    </div>
    </Transition>
    <!-- 功能托盘：☰ 展开后按钮从输入框后面一个个浮上来（错峰 + 过冲曲线）；
         高度恒 0 不推布局，收起时按钮沉回输入框背后（field 不透明背景盖住）。 -->
    <div class="tray" :class="{ open: trayState.open }">
      <div class="tray-row">
        <button class="tray-pill" style="--i: 0" :class="{ on: config.planMode }" aria-label="计划模式" title="计划模式" @click="session.togglePlanMode()">
          <CoomiIcon name="target" :size="14" /><span>计划</span>
        </button>
        <button class="tray-pill" style="--i: 1" :class="{ on: session.endToEndMode }" aria-label="端到端模式" title="端到端模式：遇到错误自动重试直到完成" @click="session.toggleEndToEndMode()">
          <CoomiIcon name="sparkle" :size="14" /><span>端到端</span>
        </button>
        <!--
          逆向模式（替换原「单模型/协作」pill）。
          协作模式改由设置 → 对话模式进入：托盘只有 4 个位置，
          加第 5 个在 360dp 上会溢出（4×~67px + gap 已占 ~268px）。
          单击开关 / 长按选厂商口味，手势逻辑见 script 里的 onReverse*。
        -->
        <button
          class="tray-pill rev-pill"
          style="--i: 2"
          :class="[reverseVerdict, { holding: reverseHolding }]"
          :aria-label="reverseHint"
          :aria-pressed="config.reverseModeTarget"
          :title="reverseHint"
          @pointerdown="onReversePointerDown"
          @pointermove="onReversePointerMove"
          @pointerup="onReversePointerUp"
          @pointercancel="onReversePointerCancel"
          @pointerleave="onReversePointerLeave"
          @click="onReverseClick"
          @contextmenu.prevent
        >
          <CoomiIcon :name="reverseVerdict === 'blocked' ? 'shieldAlert' : 'reverse'" :size="14" />
          <span>{{ reverseLabel }}</span>
        </button>
        <button class="tray-pill" style="--i: 3" :class="{ warn: config.permissionMode === 'full' }" :aria-label="'权限：' + modeLabel" :title="'权限：' + modeLabel" @click="cycleMode">
          <CoomiIcon name="shield" :size="14" /><span>{{ modeLabel }}</span>
        </button>
      </div>
    </div>

    <input ref="photoInput" class="file-input" type="file" accept="image/*" @change="onLocalFiles" />
    <div class="field" :class="{ busy: session.isBusy }">
      <div v-if="lifeStatsOpen" class="life-stats-card">
        <header><span>生命状态</span><button aria-label="关闭" @click="lifeStatsOpen = false"><CoomiIcon name="close" :size="14" /></button></header>
        <div class="life-waveform" aria-label="数字生命动态状态波形">
          <svg viewBox="0 0 320 100" preserveAspectRatio="none" aria-hidden="true">
            <path class="wave wave-upper upper-back" d="M0 50C20 47 26 28 46 29C65 30 66 45 84 39C102 33 101 15 117 12C133 9 136 38 153 39C169 40 177 29 191 34C207 40 210 48 225 48C243 48 247 30 264 32C282 34 285 45 301 43C310 42 316 48 320 50V50H0Z" />
            <path class="wave wave-upper upper-main" d="M0 50C17 46 27 17 47 20C68 23 68 43 87 34C104 26 103 5 119 4C137 3 137 35 153 36C169 37 177 21 192 29C207 37 209 48 225 47C242 46 248 20 264 24C281 28 283 45 300 40C309 38 316 47 320 50V50H0Z" />
            <path class="wave wave-upper upper-front" d="M0 50C22 48 33 35 49 36C65 37 72 46 87 42C104 37 105 23 119 20C135 17 139 43 155 44C171 45 179 35 193 39C208 43 214 49 228 49C245 49 250 37 265 38C282 39 291 48 304 46C312 45 317 49 320 50V50H0Z" />
            <path class="wave wave-lower lower-back" d="M0 50C19 53 26 73 46 71C65 69 66 55 84 61C102 67 101 85 117 88C133 91 136 62 153 61C169 60 177 71 191 66C207 60 210 52 225 52C243 52 247 70 264 68C282 66 285 55 301 57C310 58 316 52 320 50V50H0Z" />
            <path class="wave wave-lower lower-main" d="M0 50C17 54 27 83 47 80C68 77 68 57 87 66C104 74 103 95 119 96C137 97 137 65 153 64C169 63 177 79 192 71C207 63 209 52 225 53C242 54 248 80 264 76C281 72 283 55 300 60C309 62 316 53 320 50V50H0Z" />
            <path class="wave wave-lower lower-front" d="M0 50C22 52 33 65 49 64C65 63 72 54 87 58C104 63 105 77 119 80C135 83 139 57 155 56C171 55 179 65 193 61C208 57 214 51 228 51C245 51 250 63 265 62C282 61 291 52 304 54C312 55 317 51 320 50V50H0Z" />
            <path class="wave-baseline" d="M0 50H320" />
          </svg>
        </div>
        <div class="life-stats-grid"><span>当前模式<strong>数字生命</strong></span><span>推理档位<strong>{{ REASONING_EFFORTS.find(i => i.value === config.reasoningEffort)?.label }}</strong></span><span>会话状态<strong>{{ session.isBusy ? '运行中' : '待命' }}</strong></span><span>动态流<strong>已连接</strong></span></div>
      </div>

      <!-- ── 已添加文件 chip 容器 ── -->
      <AttachedFileChipContainer
        :files="session.attachedFiles"
        @remove="session.removeAttachedFile($event)"
      />

      <!-- 手势只挂这里（模式按钮上方那块真正的输入区）：
           点 ☰/型号芯片/⊕/发送 不再触发「空栏点按 → focus → 弹键盘」。 -->
      <div
        class="input-clip"
        :class="{ 'no-select': voiceActive }"
        @pointerdown="onFieldPointerDown"
        @pointermove="onFieldPointerMove"
        @pointerup="onFieldPointerUp"
        @pointercancel="onFieldPointerUp"
        @contextmenu="onInputContextMenu"
        @selectstart="onInputContextMenu"
      >
        <textarea
          ref="textarea"
          v-model="text"
          class="input"
          :class="{ scrollable: textareaScrollable }"
          rows="1"
          :placeholder="session.isBusy ? '插队补充指令…' : '给 CoomiPlus 下达任务…'"
          @input="onInput"
          @keydown="onKeydown"
          @focus="onInputFocus"
          @blur="onInputBlur"
        />
      </div>

      <!-- 语音浮卡（回归 rc80 效果：输入框上方紧凑卡片 + 7 根波形，取消时整卡变红） -->
      <Teleport to="body">
      <Transition name="voice-float">
        <div v-if="voiceActive" class="voice-float" :class="{ cancel: voiceCancelled }">
          <div class="vwave" aria-hidden="true">
            <span v-for="n in 7" :key="n" class="vbar" :style="{ '--i': n }" />
          </div>
          <p class="vstate">{{ voiceCancelled ? '松开手指取消 · 滑回来继续' : (voiceBusy ? '正在识别…' : '正在聆听 · 松开发送 · 上滑取消') }}</p>
          <p class="vpartial">{{ voicePartial || '…' }}</p>
        </div>
      </Transition>
      </Teleport>

      <div class="bar">
        <!-- rc33：功能收进左侧 ☰ 托盘；§六：模型芯片迁入输入栏（顶栏让位给会话标题） -->
        <button class="act menu" :class="{ on: trayState.open }" aria-label="功能" @click="toggleTray">
          <CoomiIcon name="menu" :size="21" />
        </button>
        <button
          class="model-chip"
          :class="{ locked: props.modelLocked }"
          :disabled="props.modelLocked"
          :title="props.modelLocked ? '子代理会话跟随主会话模型' : '选择模型'"
          @pointerdown.prevent
          @click="toggleModelSheet"
        >
          <CoomiIcon name="terminal" :size="14" />
          <span>{{ props.modelLocked ? '跟随主会话' : (config.currentModel || '选择模型') }}</span>
        </button>
        <button
          class="brain-chip"
          type="button"
          :class="{ tuned: config.reasoningEffort !== 'auto' }"
          :aria-label="'思考强度：' + effortLabel"
          :title="'思考强度：' + effortLabel"
          @pointerdown.prevent
          @click.stop="toggleEffort"
        >
          <CoomiIcon name="brain" :size="16" />
        </button>
        <div class="bar-gap" />

        <div class="actions">
          <Transition name="tool-fade">
            <button
              v-if="text.trim().length > 60 || textareaScrollable"
              class="act fs-btn"
              aria-label="全屏编辑"
              title="全屏编辑"
              @pointerdown.prevent
              @click="openFullscreen"
            >
              <CoomiIcon name="expand" :size="19" />
            </button>
          </Transition>
          <Transition name="tool-fade">
            <button v-if="!modelSheetOpen" class="act" aria-label="快捷指令" @pointerdown.prevent @click="toggleQuick">
              <CoomiIcon name="plusCircle" :size="21" />
            </button>
          </Transition>
          <button
            class="send"
            :class="{ jump: isJumpIn, stop: showStop }"
            :disabled="!hasDraft && !session.isBusy"
            :aria-label="showStop ? '停止' : isJumpIn ? '插队' : session.turnBlock || '发送'"
            :title="session.turnBlock || ''"
            @click="tapPrimary"
          >
            <CoomiIcon v-if="showStop" name="stop" :size="17" />
            <CoomiIcon v-else-if="isJumpIn" name="subtask" :size="18" />
            <CoomiIcon v-else name="arrowUp" :size="18" />
          </button>
        </div>
      </div>
    </div>


    <!-- dock 必须在 .field 外面：它是从输入栏底下伸出来的一小块，不能算进输入卡片。
         更多页打开时不摘 dock：面板只是从它下面长出来，输入栏不会被「先落再升」拽一下。 -->
    <!-- dock：键盘弹起 / 加号面板展开时收起（grid 0fr ↔ 1fr，不改外框高度），
         键盘关闭 / 面板关闭后回来。以前它完全不感知键盘，收起还做 240ms FLIP，
         和键盘动画叠加成「顶一下」。 -->
    <div class="dock-slot" :class="{ collapsed: dockCollapsed, gone: !showDockMeta }">
      <div class="dock-meta">
        <button class="dock-chip" @click="deviceSheetOpen = true">
          <CoomiIcon :name="device.mode === 'local' ? 'phone' : 'cpu'" :size="14" />
          <span>{{ deviceLabel }}</span>
          <CoomiIcon name="chevronDown" :size="12" />
        </button>
        <button class="dock-chip" @click="pickWorkspace">
          <CoomiIcon name="folder" :size="14" />
          <span>{{ cwdShort }}</span>
          <CoomiIcon name="chevronDown" :size="12" />
        </button>
      </div>
    </div>
    <!-- 加号面板：高度由底部交接（rAF + handoffFrame）驱动，内容固定满高、从底部揭出。
         与键盘互斥：展开时先 blur，键盘退多少面板就长多少，输入栏只按高度差平滑落位。
         不再用 grid 0fr→1fr 自己过渡 —— 那套和系统键盘动画各跑各的，就是闪回的来源。 -->
    <div
      class="quick-slot"
      :class="{ active: panelActive }"
      :style="{ height: panelSlotH + 'px' }"
      :aria-hidden="panelActive ? 'false' : 'true'"
    >
        <div
          class="quick"
          :style="{ height: panelFullH + 'px', transform: `translateY(${panelSlotH - panelFullH + panelLift}px)` }"
        >
          <div class="quick-actions">
            <button class="quick-tile" @click="importFiles">
              <span class="qt-ico"><CoomiIcon name="fileRead" :size="24" /></span>
              <span>添加文件</span>
            </button>
            <button class="quick-tile" @click="authorizeFolder">
              <span class="qt-ico"><CoomiIcon name="folder" :size="24" /></span>
              <span>授权目录</span>
            </button>
            <button class="quick-tile" @click="pickPhoto">
              <span class="qt-ico"><CoomiIcon name="eye" :size="24" /></span>
              <span>添加照片</span>
            </button>
          </div>
          <p class="qhead">指令</p>
          <div class="slash-list">
            <button v-for="c in SLASH_COMMANDS" :key="c.name" class="slash-item" @click="insertSlash(c.name)">
              <code>{{ c.name }}</code><span>{{ c.desc }}</span>
            </button>
          </div>
        </div>
    </div>
  </div>

  <Teleport to="body">
    <DeviceSwitcherSheet :open="deviceSheetOpen" @close="deviceSheetOpen = false" />
  </Teleport>

  <!-- 风险提示 / 口味选择面板：Teleport 到 body，不参与这里的布局。 -->
  <ReverseConsent />

  <!-- 超长文本全屏编辑：和输入框共用同一个 text，关闭即回填，不需要第二份草稿。 -->
  <Teleport to="body">
    <Transition name="fs-fade">
      <div v-if="fullscreenOpen" class="fs" role="dialog" aria-modal="true" aria-label="全屏编辑">
        <header class="fs-head">
          <button class="fs-close" aria-label="关闭全屏编辑" @click="closeFullscreen">
            <CoomiIcon name="close" :size="18" />
          </button>
          <span class="fs-title">编辑消息</span>
          <span class="fs-count">{{ text.trim().length }} 字</span>
          <button class="fs-send" :disabled="!hasDraft || Boolean(session.turnBlock)" @click="sendFromFullscreen">发送</button>
        </header>
        <textarea
          ref="fsTextarea"
          v-model="text"
          class="fs-input"
          placeholder="给 CoomiPlus 下达任务…"
          @keydown="onKeydown"
        />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
/* 左右内边距回到 12px（--sp-3），和上方消息版心的 12px 对齐；
   之前被换成一个「容器内边距」别名（16px），输入框比消息列窄一圈、左右各多 4px。 */
.file-input { display: none; }
.composer {
  position: relative; padding: var(--sp-2) var(--sp-3) calc(var(--sp-3) + var(--safe-bottom) + var(--kb-inset, 0px)); background: var(--bg);
  /* 键盘占位走 140ms 线性过渡：WebView 自带 insets 时这段是 0，不会和 IME 抢焦点；
     只有 visualViewport 兜底那条路生效时，把「一夜之间长出来」变成平滑上移。 */
  transition: padding-bottom 140ms linear;
  /* 输入区必须在消息区之上，且形成独立层叠环境。
     原因：消息区里的代码块（.md-code）和表格（.md-table）都带 overflow:hidden，
     那会创建层叠上下文；功能托盘的 pill 只有 z-index:0，比较时会被它们盖住，
     表现就是「特定情况下按钮被内容挡住、点不中」。
     isolation 让这里内部自成一个层叠环境，pill 的层级只跟输入区内部元素比较，
     不再受消息区任何组件（含未来新增的）干扰。 */
  z-index: 3;
  isolation: isolate;
  /* 输入栏是实色横带：消息向下滚时直接在它的上沿被裁掉，不再提前淡出，
     也没有一圈向外扩散的辉光（那层大模糊每帧都要重绘，是滚动的固定开销）。 */
}

.edit-banner {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  margin: 0 2px 6px; padding: 6px var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--blue) 40%, var(--border));
  border-radius: var(--r-pill);
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-label);
}
.edit-banner button { border: 0; background: none; color: var(--blue); font-weight: 600; }
/* 计划模式 / 编辑分支：都挂在输入框上沿，和缺配置提示同一档视觉。 */
.branch-banner {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: 0 2px 6px; padding: 6px var(--sp-3);
  border-radius: var(--r-pill); font-size: var(--fs-label);
  border: 1px solid var(--border); background: var(--fill); color: var(--text-2);
}
.branch-banner span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.branch-banner :deep(svg) { flex-shrink: 0; color: var(--text-3); }
.branch-banner button {
  flex-shrink: 0; min-height: 24px; padding: 0 10px;
  border: 1px solid currentColor; border-radius: var(--r-pill);
  background: var(--bg); color: inherit;
  font-size: var(--fs-caption); font-weight: 600;
}
.branch-banner button.ghost-btn { border-color: transparent; background: none; color: var(--text-3); }
/* 缺模型配置：橙色（可操作），不是红色（坏了）。文案长了要换行，不能把输入栏顶歪。 */
.config-banner {
  display: flex; flex-wrap: wrap; align-items: center; gap: var(--sp-2);
  margin: 0 2px 6px; padding: 6px var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--orange) 40%, var(--border));
  border-radius: var(--r-pill);
  background: var(--orange-soft); color: var(--orange);
  font-size: var(--fs-label);
}
.config-banner span { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
.config-banner button {
  flex-shrink: 0; min-height: 24px; padding: 0 10px;
  border: 1px solid color-mix(in srgb, var(--orange) 45%, var(--border));
  border-radius: var(--r-pill); background: var(--bg);
  color: var(--orange); font-size: var(--fs-caption); font-weight: 600;
}
.config-banner button.ghost-btn { border-color: transparent; background: none; color: var(--text-3); font-weight: 600; }
.transfer { display: flex; align-items: center; gap: var(--sp-2); margin: 0 2px 6px; font-size: var(--fs-caption); color: var(--text-2); }
.transfer span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.transfer-x { display: grid; place-items: center; flex-shrink: 0; width: 22px; aspect-ratio: 1; border: 0; border-radius: 50%; background: var(--fill); color: var(--text-3); font-size: var(--fs-sub); line-height: 1; }
.transfer progress { width: 76px; height: 4px; accent-color: var(--blue); }
.collaboration-status {
  display:flex; align-items:center; gap: 6px; margin: 0 2px 6px; padding: 6px 10px;
  border:1px solid color-mix(in srgb,var(--blue) 35%,var(--border)); border-radius:var(--r-pill);
  background:var(--blue-soft); color:var(--blue); font-size: var(--fs-caption);
}
/* §七 微信式语音浮层：半透明 + 模糊背景；波形错峰起伏；取消态整体变橙。 */
.voice-float {
  position: fixed !important;
  left: 12px; right: 12px; bottom: calc(env(safe-area-inset-bottom, 0px) + 96px);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  border-radius: var(--r-sheet);
  z-index: var(--z-popover-top);
  /* fixed + 层级令牌：不再被 composer 的裁剪/淡出层吃掉（否则上滑变红永远看不见） */
  position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 112px); transform: translateX(-50%);
  z-index: var(--z-toast); min-width: 220px; max-width: 86%;
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  padding: 14px var(--sp-5) var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
  border-radius: var(--r-card);
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  box-shadow: var(--shadow-2);
  color: var(--blue);
}
/* 上滑取消：整块变红（描边 + 浅红底 + 红波形），一眼看出「松手即取消」。 */
.voice-float.cancel {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 62%, var(--border));
  background: color-mix(in srgb, var(--danger) 16%, var(--bg));
}
.voice-float.cancel .vbar { background: var(--danger); }
.vwave { display: flex; align-items: center; gap: var(--sp-1); height: 28px; }
.vbar {
  width: 3px; height: 30%; border-radius: 2px; background: currentColor;
  animation: voiceWave .9s var(--ease-in-out) calc(var(--i) * .1s) infinite alternate;
}
@keyframes voiceWave { from { height: 22%; } to { height: 100%; } }
.vstate { margin: 0; font-size: var(--fs-label); font-weight: 600; }
.vpartial { margin: 0; max-width: 100%; font-size: var(--fs-sub); color: var(--text-2); text-align: center; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.voice-float-enter-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.voice-float-leave-active { transition: opacity var(--dur-fast) var(--ease-in), transform var(--dur-fast) var(--ease-in); }
.voice-float-enter-from, .voice-float-leave-to { opacity: 0; transform: translateX(-50%) translateY(10px) scale(.95); }
.engine-sheet {
  position: absolute; z-index: var(--z-composer-panel); left: 10px; right: 10px; bottom: calc(100% + 4px);
  padding: 10px var(--sp-3) var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  animation: coomi-expand-slide var(--expand-open-dur) var(--ease-out) backwards;
}
.engine-row {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  padding: 10px var(--sp-2); border: 0; border-radius: var(--r-md);
  background: none; text-align: left;
}
.engine-row + .engine-row { margin-top: 2px; }
.engine-row:active { background: var(--blue-soft); }
.engine-row .eicon { display: grid; place-items: center; width: 30px; height: 30px; border-radius: var(--r-pill); background: var(--fill); color: var(--blue); }
.engine-row .etext { display: flex; flex-direction: column; gap: 1px; min-width: 0; }
.engine-row .etext strong { font-size: var(--fs-strong); color: var(--text); }
.engine-row .etext small { font-size: var(--fs-caption); color: var(--text-3); }

.field {
  position: relative;
  z-index: 1;
  padding: var(--sp-1) 6px 6px var(--sp-2);
  border: 1px solid var(--border);
  border-radius: var(--r-sheet);
  background: var(--fill);
  isolation: isolate;
  transition: background var(--dur-fast) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), border-color var(--dur-fast) var(--ease-out), padding-bottom var(--dur-base) var(--ease-out);
}
/* 层次感靠“面 + 边 + 影”，不靠彩色描边。
   光从上方来：顶沿一条极细高光，底部一层柔和投影，卡片就浮起来了。
   渐变取 --bg 而不是写死白色：深色主题（ink / abyss / ember）里 --bg 是深色，
   用白色混出来的顶光会变成一块灰白的脏斑。 */
.field {
  background-image: linear-gradient(180deg,
    color-mix(in srgb, var(--bg) 58%, var(--fill)) 0%,
    var(--fill) 62%);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, #ffffff 90%, transparent),
    0 1px 2px rgba(16, 24, 40, .05),
    0 10px 24px -16px rgba(16, 24, 40, .35);
}
.field:focus-within {
  /* 聚焦不加彩色描边：只把卡片抬高一档（阴影更深一点），边框保持原来的细线。 */
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .95),
    0 2px 5px rgba(16, 24, 40, .07),
    0 16px 30px -20px rgba(16, 24, 40, .42);
}
.field.busy { border-color: var(--border-strong); }
:root[data-theme='dark'] .field,
:root[data-theme='ink'] .field,
:root[data-theme='abyss'] .field,
:root[data-theme='ember'] .field {
  background-image: linear-gradient(180deg,
    color-mix(in srgb, var(--bg) 82%, var(--fill)) 0%,
    var(--fill) 62%);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .055),
    0 1px 2px rgba(0, 0, 0, .45),
    0 12px 28px -18px rgba(0, 0, 0, .8);
}
:root[data-theme='dark'] .field:focus-within,
:root[data-theme='ink'] .field:focus-within,
:root[data-theme='abyss'] .field:focus-within,
:root[data-theme='ember'] .field:focus-within {
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, .08),
    0 2px 5px rgba(0, 0, 0, .55),
    0 18px 34px -22px rgba(0, 0, 0, .95);
}
:root[data-theme='dark'] .input,
:root[data-theme='ink'] .input,
:root[data-theme='abyss'] .input,
:root[data-theme='ember'] .input { color: var(--text); font-weight: 600; }
:root[data-theme='dark'] .input::placeholder,
:root[data-theme='ink'] .input::placeholder,
:root[data-theme='abyss'] .input::placeholder,
:root[data-theme='ember'] .input::placeholder { color: var(--text-3); font-weight: 500; }
@media (prefers-reduced-motion: reduce) {
  .field { transition: none; }
}

.input-clip { position: relative; overflow: hidden; border-radius: var(--r-sheet) var(--r-sheet) var(--r-sm) var(--r-sm); }
/* 首页输入栏下方的设备/工作目录板：比输入栏窄，上半截藏在输入栏后面，
   看起来是从输入栏底下伸出来的一小块。隐藏时 composer 变矮，输入栏自然落下来把它盖住。 */
.dock-meta {
  position: relative;
  z-index: var(--z-base);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: calc(100% - 28px);
  min-height: 30px;
  margin: -10px auto 0;
  padding: var(--sp-4) var(--sp-2) var(--sp-1);
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--fill);
  box-shadow: 0 12px 24px -20px rgba(0, 0, 0, .5);
}
.dock-chip {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  max-width: 48%;
  min-height: 22px;
  padding: 0 var(--sp-1);
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text-2);
  font-size: var(--fs-caption);
  font-weight: 600;
}
.dock-chip:active { background: var(--fill-press); }
.dock-chip span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
/* dock 的开合用 grid 行高过渡：不改外框 padding/margin，输入栏不会被顶一下。 */
.dock-slot {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 180ms var(--ease-out), opacity 140ms var(--ease-out);
}
.dock-slot.collapsed,
.dock-slot.gone { grid-template-rows: 0fr; opacity: 0; }
.dock-slot > .dock-meta { min-height: 0; overflow: hidden; }
@media (prefers-reduced-motion: reduce) {
  .dock-slot { transition: none; }
}
/* 语音按住期间禁掉选择/长按菜单：否则系统复制粘贴栏会跟着浮出来。 */
.input-clip.no-select .input {
  -webkit-user-select: none; user-select: none;
  -webkit-touch-callout: none;
}
/* 面板开合（quick / model-sheet 共用）：进 = expand-slide，出 = expand-slide-out。 */
.sheet-slide-enter-active { animation: coomi-expand-slide var(--expand-open-dur) var(--ease-out) forwards; }
.sheet-slide-leave-active { animation: coomi-expand-slide-out var(--expand-close-dur) var(--ease-emphasized) forwards; }
/* ⊕ 按钮在模型列表打开时收起/隐藏的过渡。 */
.tool-fade-enter-active, .tool-fade-leave-active { transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out); }
.tool-fade-enter-from, .tool-fade-leave-to { opacity: 0; transform: scale(.82); }
.input {
  /* 5 行档：行高 ~24 + 内边距，留到 172px；超过 5 行由 JS 挂 .scrollable 内部滚动。 */
  display: block; width: 100%; max-height: 172px; overflow-y: hidden;
  padding: 9px 10px 5px 6px; border: 0; background: none; outline: none; resize: none;
  font: inherit; font-size: var(--fs-strong); line-height: var(--lh-strong); color: var(--text);
  scrollbar-width: thin; scrollbar-color: var(--border-strong) transparent;
}
.input.scrollable { overflow-y: auto; }
.input::placeholder { color: var(--text-3); }
.input:not(.scrollable)::-webkit-scrollbar { display: none; width: 0; }
.input.scrollable::-webkit-scrollbar { width: 3px; }
.input.scrollable::-webkit-scrollbar-track { margin-block: var(--sp-3) 7px; background: transparent; }
.input.scrollable::-webkit-scrollbar-thumb { border-radius: 3px; background: var(--border-strong); }

.bar { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; padding: var(--sp-1) 0 0 var(--sp-1); }
/* 输入区状态点阵：flex:none 让它不参与 .modes 的横向滚动，窄屏也始终可见 */
/* 输入框底部有 4 个药丸 + 指令 + 发送，端到端加入后容易被挤出：
   药丸单独成组，空间不够时这组自己横向滚动，动作按钮（≥44×44）始终留在屏幕内。
   药丸本身仍按原有压缩尺寸，字号密度不变。 */
.modes {
  display: flex; align-items: center; gap: var(--sp-2);
  flex: 0 1 auto; min-width: 0; overflow-x: auto;
  scrollbar-width: none; -webkit-overflow-scrolling: touch;
}
.modes::-webkit-scrollbar { display: none; width: 0; }
.actions { display: flex; align-items: center; gap: var(--sp-2); flex: none; flex-shrink: 0; margin-left: auto; }
.bar :deep(.pill) {  min-height: 28px; padding: 0 9px; font-size: var(--fs-caption); gap: var(--sp-1); }
.bar :deep(.pill) svg { width: 13px; height: 13px; }

.act {
  display: grid; place-items: center; width: 44px; height: 44px; flex: 0 0 44px;
  aspect-ratio: 1;
  border: 0; border-radius: 50%; background: none; color: var(--text-2);
}
.act:active { background: var(--fill-press); }
.bar-gap { flex: 1; min-width: 0; }
/* §六：模型芯片（输入栏左端、☰ 旁）：当前模型名，点开平铺分组面板。 */
.brain-chip {
  display: grid; place-items: center;
  width: 32px; height: 32px; margin-left: 6px; flex-shrink: 0;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-2);
}
.brain-chip.tuned { color: var(--blue); border-color: var(--blue-border); background: var(--blue-soft); }
.brain-chip:active { background: var(--fill-press); }
/* 思考强度面板：和模型面板同层，锚在输入栏上方。 */
.effort-scrim { position: fixed; inset: 0; z-index: calc(var(--z-composer-panel) - 1); }
.effort-sheet {
  position: absolute; z-index: var(--z-composer-panel); left: 10px; right: 10px; bottom: calc(100% + 4px);
  padding: var(--sp-2) var(--sp-2) var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
}
/* 头部：脑子图标 + 标题 + 关闭。开合动画完全交给 .sheet-slide（挂在外层 Transition 上），
   面板自身不再写 animation —— 两套动画同时存在时关闭会直接消失，看不见收起过程。 */
.effort-head { display: flex; align-items: center; gap: var(--sp-2); margin: 0 0 var(--sp-1); padding: 0 6px; }
.effort-off {
  margin: 0 6px var(--sp-1); padding: var(--sp-2) var(--sp-2);
  border-radius: var(--r-sm); background: var(--fill);
  font-size: var(--fs-label); line-height: 1.5; color: var(--text-3);
}
.effort-row.off { opacity: .45; }
.effort-row.off:active { background: transparent; }
.effort-head .effort-ico { flex-shrink: 0; color: var(--blue); }
.effort-head span { flex: 1; font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.effort-close {
  display: grid; place-items: center; flex-shrink: 0;
  width: var(--sp-6); height: var(--sp-6); border: 0; border-radius: 50%;
  background: var(--fill); color: var(--text-2);
}
.effort-row {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  min-height: 40px; padding: var(--sp-1) var(--sp-2);
  border: 0; border-radius: var(--r-md); background: none; text-align: left;
}
.effort-row.on { background: var(--blue-soft); }
.effort-row .ef-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.effort-row b { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.effort-row.on b { color: var(--blue); }
.effort-row small { font-size: var(--fs-caption); color: var(--text-3); }
.model-chip {
  display: inline-flex; align-items: center; gap: 5px;
  max-width: min(34vw, 132px); min-width: 0; flex: 0 1 auto; overflow: hidden; min-height: 32px; padding: 0 var(--sp-2);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-label); font-weight: 600; white-space: nowrap;
}
.model-chip span { min-width: 0; overflow: hidden; text-overflow: ellipsis; }
.model-chip:active { background: var(--fill-press); color: var(--blue); }
.model-chip.locked { opacity: .62; }
.model-chip.locked span { font-style: italic; }
.model-sheet {
  position: absolute; z-index: var(--z-composer-panel); left: 10px; right: 10px; bottom: calc(100% + 4px);
  max-height: min(56vh, 380px); display: flex; flex-direction: column;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
}
.model-search { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-2) var(--sp-2) 0; padding: 0 var(--sp-2); height: 38px; border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--fill); }
.model-search .ms-icon { flex: none; color: var(--text-3); }
.model-search input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font: inherit; font-size: var(--fs-sub); color: var(--text); }
.model-search input::placeholder { color: var(--text-3); }
.model-scroll { overflow-y: auto; padding: var(--sp-1) var(--sp-2) var(--sp-2); }
.model-group-head { display: flex; align-items: center; gap: var(--sp-2); width: 100%; padding: 9px var(--sp-2); border: 0; border-radius: var(--r-md); background: none; text-align: left; font-size: var(--fs-label); font-weight: 600; color: var(--text-2); }
.model-group-head:active { background: var(--fill-press); }
.mgh-count { margin-left: auto; font-size: var(--fs-caption); color: var(--text-3); font-weight: 500; }
.mgh-chev { flex: none; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.mgh-chev.open { transform: rotate(90deg); }
.model-group-body { display: flex; flex-direction: column; }
.model-group-label { margin: var(--sp-2) var(--sp-1) 3px; font-size: var(--fs-caption); color: var(--text-3); font-weight: 600; }
.model-row {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  width: 100%; padding: 10px var(--sp-2); border: 0; border-radius: var(--r-md);
  background: none; text-align: left;
}
.model-row:active { background: var(--blue-soft); }
/* 守卫令牌修正：vwave 的 gap 4px → --sp-1 */
.model-row.selected { color: var(--blue); background: var(--blue-soft); }
.model-row .model-name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.model-row.selected .model-name { color: var(--blue); }
.model-empty-hint { margin: var(--sp-3) var(--sp-2); font-size: var(--fs-sub); color: var(--text-3); }
.act.menu.on { background: var(--fill-press); color: var(--blue); }
/* ── 功能托盘：高度恒 0 不推布局；收起时按钮沉到输入框背后（field 不透明背景盖住），
      展开时错峰上浮 + 过冲曲线（cubic-bezier 带一点回弹 = 灵动）。

   层级契约（改这里要想清楚）：
   · 收起态 z-index: 0 —— pill 必须沉在 .field（z-index: 1）背后，这是「从背后浮出」的观感来源；
   · 展开态 z-index: 2 —— 必须高过 .field，否则看得见点不中（`.field` 有不透明背景且接收指针事件）。
   只提展开态是刻意的：收起时提层会让 pill 提前露在输入框上面，动画就没了。 */
.tray { position: relative; height: 0; z-index: var(--z-base); pointer-events: none; }
.tray.open { z-index: 2; pointer-events: auto; }
/* rc34：resting 位置全露出（bottom:4px，不再被输入框裁边）；升起起点沉到输入框背后。 */
.tray-row { position: absolute; bottom: 4px; left: 2px; display: flex; gap: var(--sp-2); }
.tray-pill {
  display: inline-flex; align-items: center; gap: var(--sp-1); min-height: 32px; padding: 0 var(--sp-2) 0 9px;
  border: 1px solid var(--border-strong); border-radius: var(--r-pill);
  /* 底色用「抬升面」而不是 --bg：输入框本身是 --fill（浅灰），聚焦后还会变 --bg（纯白）。
     以前 pill 也是 --bg，聚焦时两者同色，只剩一条细边框 —— 看起来就像透明按钮。 */
  background: var(--bg-elevated); color: var(--text-2);
  box-shadow: var(--shadow-2);
  font-size: var(--fs-label); font-weight: 600; white-space: nowrap;
  opacity: 0; transform: translateY(52px) scale(.9);
  transition: opacity .26s var(--ease-out), transform .42s cubic-bezier(.2, 1.1, .3, 1);
  transition-delay: calc(var(--i) * 45ms);
  pointer-events: none;
}
.tray.open .tray-pill {
  opacity: 1; transform: translateY(0) scale(1);
  pointer-events: auto;
  transition-delay: calc(var(--i) * 55ms);
}
.tray-pill:active { background: var(--fill-press); }
.tray-pill.on { color: var(--blue); border-color: var(--blue-border); background: var(--blue-soft); }
.tray-pill.warn { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 40%, var(--border)); }

/* ── 逆向模式 pill 的四种状态 ──
   注意：holding 只改背景，不改 transform。tray-pill:active 已经有 scale，
   再加一个缩放会和托盘浮起的动画打架（按钮会抖一下）。 */
.rev-pill.on { color: var(--blue); border-color: var(--blue-border); background: var(--blue-soft); }
/* 待生效：意图已改但本轮还在跑。用虚线边框暗示「还没真正生效」。 */
.rev-pill.pending { color: var(--blue); border-color: var(--blue-border); border-style: dashed; background: var(--blue-soft-2); }
/* 未同意免责声明：不能让人以为已经在跑，用橙色。 */
.rev-pill.arming { color: var(--orange); border-color: color-mix(in srgb, var(--orange) 40%, var(--border)); }
/* 开着但环境受限（只读 / 无模型）：契约不会被注入。 */
.rev-pill.blocked { color: var(--danger); border-color: color-mix(in srgb, var(--danger) 40%, var(--border)); }
.rev-pill.holding { background: var(--fill-press); }
@media (prefers-reduced-motion: reduce) { .tray-pill { transition: none; } }

.send {
  display: grid; place-items: center; flex-shrink: 0;
  width: 44px; height: 44px;
  border: 0; border-radius: 50%;
  background: var(--blue); color: #fff;
  /* 发送态 / 禁用态只用颜色与不透明度变化，不做缩放弹跳 */
  transition:
    background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
}
.send.jump { background: var(--orange); }
.send.stop { background: var(--text); }
.send:disabled { background: var(--border-strong); color: var(--text-3); opacity: .9; pointer-events: none; }
.send:active { transform: none; opacity: .82; }

/* 指令面板：外层高度由底部交接驱动（inline style），这里只负责裁切与卡片外观。 */
.quick-scrim { position: fixed; inset: 0; z-index: 1; }  /* 必须低于面板（2/3/4），见模板注释 */
.quick-slot {
  position: relative;
  width: 100%;
  height: 0;
  overflow: hidden;
  /* 高度每帧由 rAF 写入，挂 CSS 过渡会和补偿打架（这也是旧版闪回的根源）。 */
  transition: none;
}
.quick {
  /* 满高卡片，从槽位底部揭出：槽高 = 本次交接允许占用的像素。 */
  position: relative;
  z-index: var(--z-composer-panel);
  width: 100%;
  overflow-y: auto;
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  will-change: transform;
}
.quick-actions {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.quick-tile {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  gap: 6px; aspect-ratio: 1;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600;
}
.quick-tile:active { background: var(--fill-press); color: var(--blue); }
.quick-tile .qt-ico { color: var(--text); }
.reasoning-head { margin-top: 3px; }
.reasoning-options { display:grid; grid-template-columns:repeat(5,minmax(0,1fr)); gap: var(--sp-1); margin-bottom: var(--sp-2); }
.reasoning-options button { position:relative; min-width:0; min-height: 32px; overflow:visible; isolation:isolate; border-radius: var(--r-sm); background:var(--fill); color:var(--text-2); font-size: var(--fs-label); }
.reasoning-options button::after { content:''; position:absolute; z-index: -1; inset:-3px; border-radius: var(--r-sm); opacity:0; background:radial-gradient(circle, color-mix(in srgb,var(--blue) 34%,transparent), transparent 68%); pointer-events:none; }
.reasoning-options button.selected { background:var(--blue-soft); color:var(--blue); font-weight: 600; }
.reasoning-options button.selected::after { opacity:.55; }
.life-stats-card { position:absolute; z-index: var(--z-composer-panel); left:12px; right:12px; bottom:calc(100% + 10px); overflow:hidden; padding: 11px var(--sp-3) var(--sp-3); border:1px solid color-mix(in srgb,var(--blue) 35%,var(--border)); border-radius: var(--r-md); background:color-mix(in srgb,var(--bg) 94%,var(--blue-soft)); box-shadow:0 8px 28px color-mix(in srgb,var(--blue) 20%,transparent); animation: life-card-in var(--dur-base) var(--ease-out) backwards; }
.life-stats-card header { display:flex; align-items:center; justify-content:space-between; color:var(--text); font-size: var(--fs-label); font-weight: 600; }
.life-stats-card header button { display:grid; place-items:center; width:24px; height:24px; border-radius:50%; background:var(--fill); color:var(--text-2); }
.life-waveform { position:relative; height:64px; margin: 9px 1px 10px; overflow:hidden; border-radius: var(--r-sm); background:linear-gradient(to bottom, color-mix(in srgb,var(--blue-soft) 28%,transparent), transparent 50%, color-mix(in srgb,var(--blue-soft) 20%,transparent)); }
.life-waveform svg { display:block; width:100%; height:100%; overflow:visible; }
.wave { transform-origin:160px 50px; vector-effect:non-scaling-stroke; }
.wave-upper { fill:color-mix(in srgb,var(--orange) 48%,var(--bg)); stroke:color-mix(in srgb,var(--orange) 72%,var(--bg)); stroke-width:1.2; }
.wave-lower { fill:color-mix(in srgb,var(--blue) 52%,var(--bg)); stroke:color-mix(in srgb,var(--blue) 76%,var(--bg)); stroke-width:1.2; }
.upper-back,.lower-back { opacity:.55; animation-duration: var(--dur-loop-sweep); animation-delay:-1.1s; }
.upper-front,.lower-front { opacity:.7; animation-duration: var(--dur-loop-sweep); animation-delay:-.55s; }
.wave-baseline { fill:none; stroke:var(--border-strong); stroke-width:1.4; vector-effect:non-scaling-stroke; opacity:.9; }
.life-stats-grid { display:grid; grid-template-columns:repeat(2,1fr); gap: 7px var(--sp-3); }.life-stats-grid span { display:flex; justify-content:space-between; gap: var(--sp-2); color:var(--text-3); font-size: var(--fs-caption); }.life-stats-grid strong { color:var(--text-2); font-weight:600; }
@keyframes life-card-in { from { opacity:0; transform:translateY(5px) scale(.98); } to { opacity:1; transform:none; } }
@media (prefers-reduced-motion: reduce) {
  .quick, .life-stats-card, .engine-sheet { animation: none; }
  .sheet-slide-enter-active, .sheet-slide-leave-active { animation: none; }
  .tool-fade-enter-active, .tool-fade-leave-active { transition: none; }
  .vbar { animation: none; height: 60%; }
  .voice-float-enter-active, .voice-float-leave-active { transition: none; }
}
.qhead { margin-bottom: var(--sp-2); font-size: var(--fs-label); font-weight: 600; color: var(--text-3); }
.file-actions { display: flex; gap: 7px; margin-bottom: var(--sp-2); }
.qchip.file { display: inline-flex; align-items: center; gap: 5px; color: var(--blue); }
.qchip {
  min-height: 32px; padding: 0 13px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); font-size: var(--fs-sub); color: var(--text-2);
}
.qchip:active { background: var(--blue-soft); border-color: var(--blue-border); color: var(--blue); }

/* 斜杠指令逐行列表 */
.slash-list { display: flex; flex-direction: column; gap: 2px; }
.slash-item {
  display: flex; align-items: center; gap: 10px; width: 100%;
  padding: 10px var(--sp-2); border: 0; border-radius: var(--r-md);
  background: none; text-align: left; cursor: pointer;
}
.slash-item code { font-family: inherit; font-size: var(--fs-sub); font-weight: 700; color: var(--blue); }
.slash-item span { font-size: var(--fs-label); color: var(--text-2); }
.slash-item:active { background: var(--blue-soft); }

/* 语音取消区：随上滑进度填充的红色带（这才是你看到的"上滑动效"） */
.voice-cancel-zone {
  position: absolute; left: 10px; right: 10px; top: 6px; height: 34px;
  transform-origin: top center;
  border-radius: var(--r-md);
  background: linear-gradient(180deg, var(--danger), color-mix(in srgb, var(--danger) 45%, transparent));
  display: flex; align-items: center; justify-content: center;
  transition: transform 90ms linear, opacity 90ms linear;
  pointer-events: none;
}
.voice-cancel-zone .vcz-text { font-size: var(--fs-caption); font-weight: 700; color: #fff; letter-spacing: 0.04em; }

/* 语音波形：7 根竖条错峰起伏（聆听时的“活着”感） */
.vwave { display: flex; align-items: center; justify-content: center; gap: var(--sp-1); height: 26px; margin-top: calc(var(--sp-1) + 2px); }
.vwave i {
  width: 3px; border-radius: 3px; background: var(--blue);
  height: 8px; opacity: .55;
  animation: vwave 900ms ease-in-out infinite;
  animation-delay: calc(var(--i) * -120ms);
}
@keyframes vwave { 0%, 100% { height: 7px; opacity: .45; } 50% { height: 22px; opacity: .95; } }
@media (prefers-reduced-motion: reduce) { .vwave i { animation: none; height: 12px; } }

/* 语音全屏浮层：沉浸式、轻模糊、状态三态（聆听/识别中/完成） */
.voice-float {
  position: fixed; left: 50%; bottom: calc(env(safe-area-inset-bottom, 0px) + 112px);
  transform: translateX(-50%); z-index: var(--z-toast);
  min-width: 220px; max-width: 86%; padding: 14px var(--sp-5) var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--blue) 25%, var(--border));
  background: color-mix(in srgb, var(--bg) 72%, transparent);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  box-shadow: var(--shadow-2); color: var(--blue); border-radius: var(--r-card);
  display: flex; flex-direction: column; align-items: center; gap: 6px;
}
.voice-float.cancel {
  color: var(--danger);
  border-color: color-mix(in srgb, var(--danger) 62%, var(--border));
  background: color-mix(in srgb, var(--danger) 16%, var(--bg));
}
.voice-float.cancel .vbar { background: var(--danger); }
.vwave { display: flex; align-items: center; gap: var(--sp-1); height: 28px; }
.vbar {
  width: 3px; height: 30%; border-radius: 2px; background: currentColor;
  animation: voiceWave .9s var(--ease-in-out) calc(var(--i) * .1s) infinite alternate;
}
@keyframes voiceWave { 0% { height: 22%; } 100% { height: 100%; } }
.vstate { margin: 0; font-size: var(--fs-label); font-weight: 600; }
.vpartial {
  margin: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis;
  white-space: nowrap; font-size: var(--fs-caption); color: var(--text-3);
}
.voice-arm-btn {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-2);
  width: calc(100% - var(--sp-4)); margin: 0 var(--sp-3) var(--sp-2); min-height: 64px;
  border: 1px solid color-mix(in srgb, var(--blue) 45%, var(--border));
  border-radius: var(--r-card);
  background: color-mix(in srgb, var(--blue) 16%, var(--bg-card));
  color: var(--blue); font-size: var(--fs-strong); font-weight: 700;
}
.voice-arm-btn:active { transform: scale(.99); }
.voice-arm-enter-active, .voice-arm-leave-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.voice-arm-enter-from, .voice-arm-leave-to { opacity: 0; transform: translateY(8px); }

/* 覆盖层配色：默认蓝（聆听）/ cancel 红（松开取消） */
.voice-overlay { background: color-mix(in srgb, var(--blue) 26%, transparent) !important; }
.voice-overlay.cancel { background: color-mix(in srgb, var(--danger) 34%, transparent) !important; }
.voice-overlay .vo-state { color: #fff; }
.voice-overlay .vo-hint { color: rgba(255,255,255,.85); }
.voice-overlay .vo-bar { background: #fff; }

/* ── 超长文本全屏编辑 ── */
.fs {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; flex-direction: column;
  padding: calc(var(--safe-top, 0px) + var(--sp-2)) var(--sp-3) calc(var(--sp-3) + var(--safe-bottom, 0px) + var(--kb-inset, 0px));
  background: var(--bg);
}
.fs-head { display: flex; align-items: center; gap: var(--sp-2); padding-bottom: var(--sp-2); flex-shrink: 0; }
.fs-close {
  display: grid; place-items: center; flex-shrink: 0;
  width: var(--sp-8); height: var(--sp-8); border: 0; border-radius: 50%;
  background: var(--fill); color: var(--text-2);
}
.fs-title { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.fs-count { flex: 1; text-align: right; font-size: var(--fs-caption); color: var(--text-3); }
.fs-send {
  flex-shrink: 0; min-height: 32px; padding: 0 var(--sp-3);
  border: 0; border-radius: var(--r-pill);
  background: var(--blue); color: #fff;
  font-size: var(--fs-label); font-weight: 600;
}
.fs-send:disabled { background: var(--border-strong); color: var(--text-3); }
.fs-input {
  flex: 1; min-height: 0; margin-top: var(--sp-2); padding: var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--fill); color: var(--text);
  font: inherit; font-size: var(--fs-strong); line-height: 1.7;
  resize: none; outline: none;
}
.fs-fade-enter-active, .fs-fade-leave-active { transition: opacity 180ms var(--ease-out); }
.fs-fade-enter-from, .fs-fade-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .fs-fade-enter-active, .fs-fade-leave-active,
  .quick { transition: none; }
  .composer { transition: none; }
}
</style>