import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { PermissionMode, ReasoningEffort } from '@/protocol/commands'
import { apiGet, apiSend } from '@/bridge/http'
import type { CollabRole } from '@/features/collab/types/collab'
import {
  REVERSE_ENABLED_KEY,
  REVERSE_FLAVOR_KEY,
  normalizeFlavor,
  readReverseSampling,
  writeReverseSampling,
  readReverseExperiments,
  writeReverseExperiments,
  REVERSE_EXPERIMENTS_DEFAULTS,
  REVERSE_SAMPLING_DEFAULTS,
  type ReverseFlavor,
  type ReverseSampling,
  type ReverseExperiments,
} from '@/utils/reverseMode'

export interface ProviderConfig {
  id: string; name: string; apiKeyMasked: string; hasKey?: boolean
  models: string[]; baseUrl?: string
  type?: string; model?: string; fastModel?: string | null; toolProtocol?: string
  contextWindow?: number
  modelContextWindows?: Record<string, number>
  supportsWebSearch?: boolean
  supportsVision?: boolean
  active?: boolean
  builtin?: boolean
  status?: ProviderStatus
  modelDescriptions?: Record<string, string>
  modelParameters?: Record<string, ModelParameters>
  capabilityOverrides?: Record<string, CapabilityOverride>
}

export interface ModelParameters {
  temperature?: number
  topK?: number
  topP?: number
  maxOutputTokens?: number
  reasoningEffort?: string
  reasoningField?: string
  reasoningMapping?: Partial<Record<'low' | 'medium' | 'high' | 'xhigh' | 'ultra', string>>
}
export interface CapabilityOverride { text?: boolean; vision?: boolean; image_generation?: boolean; reasoning?: boolean }
/** 子代理的提供商/模型：引擎已自动选择模型，设置页不再让用户填写。字段保留（可选）以向后兼容引擎旧配置。 */
export interface SubAgentConfig { id: string; providerId?: string; model?: string; description?: string }
export interface SubAgentSettings { agents: SubAgentConfig[]; fallbackId?: string; maxAgents: number; maxConcurrentAgents?: number }
/** 端到端接力模型：单一模型连续失败超过阈值后按序切换。 */
export interface EndToEndFallback { id: string; providerId: string; model: string }
export interface CollaborationSettings {
  coderSelector: string
  reviewerSelector: string
  coderPrompt: string
  reviewerPrompt: string
  maxCycles: number
  reviewTests: boolean
}

  export interface CollabSettings {
    roles: CollabRole[]
    coderSelector: string
    reviewerSelector: string
    coderPrompt: string
    reviewerPrompt: string
    maxCycles: number
    reviewTests: boolean
  }

  /** 内置角色预设 */
  export interface CollabRolePreset {
    id: string
    name: string
    roles: Omit<CollabRole, 'id'>[]
  }
  export type { CollabRole }

export type ProviderProtocol = 'openai_compatible' | 'openai_responses' | 'anthropic_messages' | 'gemini_native'
export type ProviderStatus = 'unconfigured' | 'configured' | 'current'

export interface ConnectionSettings {
  providerRetryCount: number
  wsRetryCount: number
  reconnectInitialDelayMs: number
  reconnectMaxDelayMs: number
  maxConcurrentTasks: number
}

export const DEFAULT_CONNECTION_SETTINGS: ConnectionSettings = {
  providerRetryCount: 2,
  wsRetryCount: 10,
  reconnectInitialDelayMs: 500,
  reconnectMaxDelayMs: 10_000,
  maxConcurrentTasks: 5,
}

/**
 * 端上留痕（引擎 settings.json 的 capabilities 块，驼峰键）。
 * 引擎侧默认 localTraceEnabled = true、localTraceMaxMb = 0（不限），这里保持同口径。
 */
export interface LocalTraceSettings {
  /** 留痕总开关：关闭后引擎不再写 trajectory.jsonl。 */
  localTraceEnabled: boolean
  /** 体积上限（MB）；0 = 不限。> 0 时引擎夹在 1~4096。 */
  localTraceMaxMb: number
}

export interface ProviderPreset {
  id: string
  name: string
  baseUrl: string
  protocol: ProviderProtocol
}

export const BUILTIN_PROVIDER_PRESETS: ProviderPreset[] = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', protocol: 'openai_compatible' },
  { id: 'zhipu', name: '智谱', baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4', protocol: 'openai_compatible' },
  { id: 'minimax', name: 'MiniMax', baseUrl: 'https://api.minimaxi.com/v1', protocol: 'openai_compatible' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', protocol: 'openai_responses' },
  { id: 'anthropic', name: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', protocol: 'anthropic_messages' },
  { id: 'google', name: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', protocol: 'gemini_native' },
  { id: 'opencode', name: 'OpenCode', baseUrl: 'https://opencode.ai/zen/go/v1', protocol: 'openai_compatible' },
]

export interface ProviderInput {
  id: string; name: string; apiKey: string; models: string[]
  baseUrl?: string; type?: string; toolProtocol?: string; contextWindow?: number
  modelContextWindows?: Record<string, number>
  fastModel?: string | null; activate?: boolean; supportsWebSearch?: boolean; supportsVision?: boolean
  modelDescriptions?: Record<string, string>; modelParameters?: Record<string, ModelParameters>
  capabilityOverrides?: Record<string, CapabilityOverride>
}

export function providerStatus(provider: ProviderConfig, activeId: string): ProviderStatus {
  // A manually entered model is valid even when the provider catalog could
  // not be fetched (for example Volcengine Ark's intermittent `/models`).
  const configured = Boolean(provider.hasKey && (provider.models.length > 0 || provider.model?.trim()))
  if (configured && provider.id === activeId) return 'current'
  return configured ? 'configured' : 'unconfigured'
}

export function mergeProviderList(configured: ProviderConfig[], activeId: string): ProviderConfig[] {
  const configuredById = new Map(configured.map(provider => [provider.id, provider]))
  const builtInIds = new Set(BUILTIN_PROVIDER_PRESETS.map(preset => preset.id))
  const builtIns = BUILTIN_PROVIDER_PRESETS.map(preset => {
    const saved = configuredById.get(preset.id)
    const provider: ProviderConfig = {
      id: preset.id,
      name: saved?.name || preset.name,
      apiKeyMasked: saved?.apiKeyMasked || '',
      hasKey: Boolean(saved?.hasKey),
      models: saved?.models ?? [],
      baseUrl: saved?.baseUrl || preset.baseUrl,
      type: saved?.type || preset.protocol,
      model: saved?.model,
      fastModel: saved?.fastModel,
      toolProtocol: saved?.toolProtocol || preset.protocol,
      contextWindow: saved?.contextWindow ?? 256000,
      modelContextWindows: { ...(saved?.modelContextWindows ?? {}) },
      supportsWebSearch: saved?.supportsWebSearch ?? false,
      supportsVision: saved?.supportsVision ?? false,
      modelDescriptions: { ...(saved?.modelDescriptions ?? {}) },
      modelParameters: { ...(saved?.modelParameters ?? {}) },
      capabilityOverrides: { ...(saved?.capabilityOverrides ?? {}) },
      active: activeId === preset.id,
      builtin: true,
    }
    provider.status = providerStatus(provider, activeId)
    return provider
  })
  const custom = configured
    .filter(provider => !builtInIds.has(provider.id))
    .map(provider => ({ ...provider, builtin: false, status: providerStatus(provider, activeId) }))
  return [...builtIns, ...custom]
}

export const PERMISSION_MODES: { mode: PermissionMode; label: string; desc: string }[] = [
  { mode: 'ask', label: '询问', desc: '每个写入/破坏性操作前都确认' },
  { mode: 'auto', label: '自动', desc: '读写自动放行，仅破坏性需确认' },
  { mode: 'full', label: '放行', desc: '全部自动执行（仅信任场景）' },
]

export type ThemeMode = 'system' | 'light' | 'dark' | 'book' | 'orange' | 'ink' | 'abyss' | 'ember' | 'celadon' | 'linen'
const THEME_VALUES: ThemeMode[] = ['system', 'light', 'dark', 'book', 'orange', 'ink', 'abyss', 'ember', 'celadon', 'linen']
export const THEME_MODES: { mode: ThemeMode; label: string; desc: string }[] = [
  { mode: 'system', label: '跟随系统', desc: '与手机系统深浅色保持一致' },
  { mode: 'light', label: '明亮模式', desc: '始终使用浅色界面' },
  { mode: 'dark', label: '夜间模式', desc: '始终使用深色界面' },
  { mode: 'book', label: '书卷纸', desc: '柔和纸张底色与墨绿色点缀' },
  { mode: 'orange', label: '橙白', desc: '明快白色底面与暖橙色点缀' },
  { mode: 'ink', label: '墨玉', desc: '墨黑底面与温润玉绿色点缀' },
  { mode: 'abyss', label: '深海', desc: '深海蓝黑底面与清冷青蓝点缀' },
  { mode: 'ember', label: '炭褐', desc: '炭黑褐底面与余烬铜色点缀' },
  { mode: 'celadon', label: '青瓷', desc: '青瓷浅灰底面与釉绿色点缀' },
  { mode: 'linen', label: '亚麻', desc: '自然亚麻白底面与沉静靛色点缀' },
]

export const REASONING_EFFORTS: { value: ReasoningEffort; label: string }[] = [
  { value: 'auto', label: '自动' },
  { value: 'low', label: '最小' },
  { value: 'medium', label: '中' },
  { value: 'high', label: '大' },
  { value: 'xhigh', label: '最大' },
]
/** 模型档位映射：最小/中/大/最大 → 引擎的 low/medium/high/xhigh，引擎再按模型能力夹取。 */
export const REASONING_HINT: Record<string, string> = {
  auto: '按上下文长度自动选择',
  low: '最快，适合闲聊与短问',
  medium: '日常默认，速度与质量平衡',
  high: '复杂推理，略慢',
  xhigh: '最强推理，最慢（部分模型不支持会降档）',
}

/** 取当前主题档位：优先 Android 原生偏好（JS 桥），其次 localStorage，默认跟随系统。 */
export function readThemeMode(): ThemeMode {
  const bridge = (window as any).CoomiAndroid
  if (bridge && typeof bridge.getThemeMode === 'function') {
    try {
      const v = String(bridge.getThemeMode() ?? '')
      if (THEME_VALUES.includes(v as ThemeMode)) return v as ThemeMode
    } catch { /* 桥未就绪时走 localStorage */ }
  }
  const saved = localStorage.getItem('coomi.themeMode')
  return THEME_VALUES.includes(saved as ThemeMode) ? saved as ThemeMode : 'system'
}

/** 写入 <html data-theme>，前端 global.css 据此切换暗色主题。 */
export function applyTheme(mode: ThemeMode) {
  const dark = mode === 'dark'
    || (mode === 'system' && window.matchMedia?.('(prefers-color-scheme: dark)').matches)
  document.documentElement.setAttribute('data-theme', dark ? 'dark' : mode === 'system' ? 'light' : mode)
}

/* ── 界面字号 / 列表密度 ─────────────────────────────────────────────
   手机端此前没有任何字号入口。这里加两项外观偏好：
     · 界面字号：标准 1 / 较大 1.08（默认）/ 最大 1.18；
     · 列表密度：宽松（现状）/ 紧凑。
   落盘方式照抄同页的「主题」：写 localStorage + 写 <html>，不另起一套。

   为什么要在运行时注入一份 <style>：styles/global.css 里没有 --ui-font-scale，
   而本轮不允许改 styles/，现有组件又大多把 font-size 写死成 px。于是把缩放接到
   设计令牌 --fs-* / --lh-* 与 body 字号上（选择器用 html:root / html body 抬高一级
   特异性，不依赖 <style> 的先后顺序），字号即有真实效果；仍然写死 px 的组件，要等
   各自改用 var(--fs-*) / var(--ui-font-scale) 之后才会跟随。
   谁该用这些变量：设置 / 外观类页面的白卡列表行（.group 里的 .row / .number-row）。
     --ui-row-min-h / --ui-row-pad-y        普通设置行的行高与上下内边距
     --ui-numrow-min-h / --ui-numrow-pad-y  带输入框的设置行
     data-density="compact"                 需要额外分支时的选择器钩子
   新组件请直接用变量，不要再写死 56px / 11px。 */
export type UiFontScale = 1 | 1.08 | 1.18
export type ListDensity = 'cozy' | 'compact'
export const DEFAULT_UI_FONT_SCALE: UiFontScale = 1.08
export const DEFAULT_LIST_DENSITY: ListDensity = 'cozy'
export const UI_FONT_SCALES: { value: UiFontScale; label: string; desc: string }[] = [
  { value: 1, label: '标准', desc: '更紧凑的字号，适合小屏或习惯小字' },
  { value: 1.08, label: '较大', desc: '默认档：比标准略大，日常更好读' },
  { value: 1.18, label: '最大', desc: '字最大，一屏能放下的内容更少' },
]
export const LIST_DENSITIES: { value: ListDensity; label: string; desc: string }[] = [
  { value: 'cozy', label: '宽松', desc: '行更高、留白更多（现状）' },
  { value: 'compact', label: '紧凑', desc: '行更矮，一屏看到更多条目' },
]
export function normalizeUiFontScale(value: unknown): UiFontScale {
  return value === 1 || value === 1.08 || value === 1.18 ? value as UiFontScale : DEFAULT_UI_FONT_SCALE
}
export function normalizeListDensity(value: unknown): ListDensity {
  return value === 'compact' ? 'compact' : DEFAULT_LIST_DENSITY
}
export function readUiFontScale(): UiFontScale {
  return normalizeUiFontScale(Number(localStorage.getItem('coomi.uiFontScale')))
}
export function readListDensity(): ListDensity {
  return normalizeListDensity(localStorage.getItem('coomi.listDensity'))
}

const UI_APPEARANCE_STYLE_ID = 'coomi-ui-scale'
const UI_APPEARANCE_CSS = `
/* 下面各基数的 px 值与 global.css :root 的 --fs-*/--lh-* 一一对应；
   那边改基数时这里要同步（不能在 :root 里用自身变量做基数）。 */
html:root {
  --fs-caption: calc(11px * var(--ui-font-scale, 1));
  --lh-caption: calc(16px * var(--ui-font-scale, 1));
  --fs-label: calc(12px * var(--ui-font-scale, 1));
  --lh-label: calc(18px * var(--ui-font-scale, 1));
  --fs-sub: calc(13px * var(--ui-font-scale, 1));
  --lh-sub: calc(20px * var(--ui-font-scale, 1));
  --fs-body: calc(14px * var(--ui-font-scale, 1));
  --lh-body: calc(22px * var(--ui-font-scale, 1));
  --fs-strong: calc(16px * var(--ui-font-scale, 1));
  --lh-strong: calc(24px * var(--ui-font-scale, 1));
  --fs-title: calc(20px * var(--ui-font-scale, 1));
  --lh-title: calc(28px * var(--ui-font-scale, 1));
}
html body { font-size: calc(15px * var(--ui-font-scale, 1)); }
/* 只有「紧凑」才覆盖行样式：宽松完全不动现有行样式，
   保证默认观感与改前一致；紧凑时统一压设置/外观类白卡里的行。 */
html[data-density='compact'] .group > .row {
  min-height: var(--ui-row-min-h, 46px);
  padding-top: var(--ui-row-pad-y, 7px);
  padding-bottom: var(--ui-row-pad-y, 7px);
}
html[data-density='compact'] .group > .number-row {
  min-height: var(--ui-numrow-min-h, 52px);
  padding-top: var(--ui-numrow-pad-y, 7px);
  padding-bottom: var(--ui-numrow-pad-y, 7px);
}
`
function ensureUiAppearanceStyle(): void {
  if (typeof document === 'undefined') return
  let style = document.getElementById(UI_APPEARANCE_STYLE_ID) as HTMLStyleElement | null
  if (!style) {
    style = document.createElement('style')
    style.id = UI_APPEARANCE_STYLE_ID
    document.head.appendChild(style)
  }
  if (style.textContent !== UI_APPEARANCE_CSS) style.textContent = UI_APPEARANCE_CSS
}
/** 把字号/密度写到 <html> 的 CSS 变量与 data-density，并保证运行时样式已注入。 */
export function applyUiAppearance(
  scale: UiFontScale = readUiFontScale(),
  density: ListDensity = readListDensity(),
): void {
  if (typeof document === 'undefined') return
  const root = document.documentElement
  root.style.setProperty('--ui-font-scale', String(scale))
  root.style.setProperty('--ui-row-min-h', density === 'compact' ? '46px' : '56px')
  root.style.setProperty('--ui-row-pad-y', density === 'compact' ? '7px' : '11px')
  root.style.setProperty('--ui-numrow-min-h', density === 'compact' ? '52px' : '64px')
  root.style.setProperty('--ui-numrow-pad-y', density === 'compact' ? '7px' : '10px')
  root.dataset.density = density
  ensureUiAppearanceStyle()
}
// config.ts 被 main.ts 静态 import，所以这一行在应用挂载前就执行：
// 首帧就是用户选定的字号与密度，不会先按默认渲染再跳一下。
applyUiAppearance()

// 浏览器独立开发时的兜底数据（后端不可达时使用）
const MOCK_PROVIDERS: ProviderConfig[] = [
  { id: 'openai', name: 'OpenAI', apiKeyMasked: '****a1b2', hasKey: true, models: ['gpt-4o', 'gpt-4o-mini'], baseUrl: 'https://api.openai.com/v1' },
  { id: 'anthropic', name: 'Anthropic', apiKeyMasked: '****9f3c', hasKey: true, models: ['claude-sonnet-4', 'claude-opus-4'] },
]

/** 按模型匹配「支持的推理档位」字典：不支持的档位自动降级，避免引擎报错。 */
const EFFORT_BY_MODEL: Array<[RegExp, string[]]> = [
  [/^gpt-5/i, ['minimal', 'low', 'medium', 'high']],
  [/^o[134]/i, ['low', 'medium', 'high']],
  [/claude|anthropic/i, ['low', 'medium', 'high', 'xhigh']],
  [/gemini|google/i, ['low', 'medium', 'high']],
  [/deepseek|deepseek-r1/i, ['low', 'medium', 'high']],
  [/qwen|qwen3|qwq/i, ['low', 'medium', 'high']],
]
const EFFORT_FALLBACK = ['low', 'medium', 'high']

/** 某模型支持的档位列表（未知模型给通用三档）。 */
export function effortsForModel(model: string | undefined | null): string[] {
  const name = (model ?? '').trim()
  if (!name) return EFFORT_FALLBACK
  for (const [pattern, efforts] of EFFORT_BY_MODEL) if (pattern.test(name)) return efforts
  return EFFORT_FALLBACK
}

/** 把用户选择的档位映射到该模型支持的档位（不支持则取最接近的）。 */
export function normalizeEffortForModel(model: string | undefined | null, effort: string): string {
  const supported = effortsForModel(model)
  if (supported.includes(effort)) return effort
  if (effort === 'ultra' || effort === 'xhigh') return supported[supported.length - 1]
  if (effort === 'minimal') return supported[0]
  if (effort === 'auto') return supported[Math.floor(supported.length / 2)]
  return supported[Math.floor(supported.length / 2)]
}

export const useConfigStore = defineStore('config', () => {
  const savedPermission = localStorage.getItem('coomi.permissionMode') as PermissionMode | null
  const permissionMode = ref<PermissionMode>(['ask', 'auto', 'full'].includes(savedPermission ?? '') ? savedPermission! : 'ask')
  const planMode = ref(false)
  /**
   * 逆向模式的「用户意图」，与引擎实际生效值是两回事。
   *
   * 这里只存意图（并落 localStorage，重启后保持）。引擎侧的真实状态由
   * session store 的 reverseHealth / reverseModeCommitted 表达 —— 生成中翻开关
   * 不会影响本轮（system prompt 已拼好），要等 turn_end 才落地，所以势必要分开。
   */
  const reverseModeTarget = ref(localStorage.getItem(REVERSE_ENABLED_KEY) === '1')
  const reverseFlavor = ref<ReverseFlavor>(normalizeFlavor(localStorage.getItem(REVERSE_FLAVOR_KEY)))
  /**
   * 采样参数（实验性，默认关闭）。
   * 读的时候自带签名校验：被手改过的记录直接回默认（关），不会把请求参数带崩。
   */
  const reverseSampling = ref<ReverseSampling>(readReverseSampling(localStorage))
  /** 契约片段开关（实验性）。与采样参数分开：那边改请求，这边改注入的提示词。 */
  const reverseExperiments = ref<ReverseExperiments>(readReverseExperiments(localStorage))
  const themeMode = ref<ThemeMode>(readThemeMode())
  // 界面字号 / 列表密度：与主题一样落在 localStorage + <html>，values 由 applyUiAppearance 写入。
  // 不通知 Android 原生：原生外观桥只覆盖主题与自定义配色，字号由这里自己接管。
  const uiFontScale = ref<UiFontScale>(readUiFontScale())
  const listDensity = ref<ListDensity>(readListDensity())
  // 旧版五档里的 ultra 已合并进「最大」（xhigh），读回时做一次迁移。
  const rawSavedEffort = localStorage.getItem('coomi.reasoningEffort')
  const savedEffort = (rawSavedEffort === 'ultra' ? 'xhigh' : rawSavedEffort) as ReasoningEffort | null
  const defaultPage = ref<'chat' | 'dashboard' | 'home'>(
    (localStorage.getItem('coomi.defaultPage') as 'chat' | 'dashboard' | 'home' | null) ?? 'chat',
  )
  function setDefaultPage(page: 'chat' | 'dashboard' | 'home') {
    defaultPage.value = page
    localStorage.setItem('coomi.defaultPage', page)
  }
  const reasoningEffort = ref<ReasoningEffort>(REASONING_EFFORTS.some(item => item.value === savedEffort) ? savedEffort! : 'auto')
  const endToEndFallbacks = ref<EndToEndFallback[]>(readEndToEndFallbacks())
  const endToEndFailThreshold = ref(readStoredInt('coomi.endToEndFailThreshold', 1, 20, 3))
  const subAgentSettings = ref<SubAgentSettings>({ agents: [], maxAgents: 20, maxConcurrentAgents: 3 })
  const collaborationSettings = ref<CollaborationSettings>({
    coderSelector: '', reviewerSelector: '', coderPrompt: '', reviewerPrompt: '', maxCycles: 2, reviewTests: true,
  })
  const connectionSettings = ref<ConnectionSettings>({
    providerRetryCount: readStoredInt('coomi.providerRetryCount', 0, 10, DEFAULT_CONNECTION_SETTINGS.providerRetryCount),
    wsRetryCount: readStoredInt('coomi.wsRetryCount', 0, 30, DEFAULT_CONNECTION_SETTINGS.wsRetryCount),
    reconnectInitialDelayMs: readStoredInt('coomi.reconnectInitialDelayMs', 500, 60_000, DEFAULT_CONNECTION_SETTINGS.reconnectInitialDelayMs),
    reconnectMaxDelayMs: readStoredInt('coomi.reconnectMaxDelayMs', 1_000, 120_000, DEFAULT_CONNECTION_SETTINGS.reconnectMaxDelayMs),
    maxConcurrentTasks: readStoredInt('coomi.maxConcurrentTasks', 1, 20, DEFAULT_CONNECTION_SETTINGS.maxConcurrentTasks),
  })

  const providers = ref<ProviderConfig[]>([])
  /**
   * 这台引擎的模型列表「读到过没有」——和「有没有模型」是两件事。
   * 切引擎 / 首次进云端时会清空列表，那一刻是「还不知道」，不是「没配模型」；
   * 只有这里为 true（引擎真的应答过）才允许把用户推去添加模型控制台。
   */
  const providersKnown = ref(false)
  const activeId = ref('')
  const loading = ref(false)
  const usingMock = ref(false)
  const lastError = ref<string | null>(null)
  let providersRequest = 0

  /**
   * 厂商配置版本号：增 / 删 / 改 / 激活成功后自增。
   * 设置页改完后回到对话页时，订阅者（ChatView / Composer）据此重新拉 /api/providers；
   * 以前只有设置页刷新自己那份，回到对话页还是旧列表，于是刚配好却被提示
   * 「还没有配置模型」。纯前端广播，不改引擎。
   */
  const providerRevision = ref(0)
  function bumpProviders() { providerRevision.value += 1 }

  /** 模型选择按引擎上下文隔离：local 与 cloud:<deviceId> 各自记住上次选择。 */
  const CONTEXT_KEY = 'coomi.model.contexts'
  let engineContext = 'local'
  function readContexts(): Record<string, { providerId: string; model: string }> {
    try { return JSON.parse(localStorage.getItem(CONTEXT_KEY) ?? '{}') as Record<string, { providerId: string; model: string }> } catch { return {} }
  }
  function saveContext(): void {
    if (!currentProviderId.value) return
    const all = readContexts()
    all[engineContext] = { providerId: currentProviderId.value, model: currentModel.value }
    try { localStorage.setItem(CONTEXT_KEY, JSON.stringify(all)) } catch { /* ignore */ }
  }

  const currentProviderId = ref('')
  const currentModel = ref('')
  const currentProvider = computed(() => providers.value.find(p => p.id === currentProviderId.value) ?? null)
  const mergedProviders = computed(() => mergeProviderList(providers.value, activeId.value))
    const collabRoles = ref<CollabRole[]>([])
    const collabPresets = ref<CollabRolePreset[]>([
      { id: 'web-dev', name: '网页开发小队', roles: [
        { name: 'UI 设计师', modelSelector: "", prompt: '你负责界面视觉设计。输出 HTML/CSS/组件结构，注重可访问性与响应式。不要写业务逻辑代码。', color: '#ec4899', icon: 'sparkle', visibility: 'full' },
        { name: '前端工程师', modelSelector: "", prompt: '你负责把设计稿实现为可用的 Vue/TS 代码。遵循项目约定，注重类型安全与可维护性。', color: '#3b82f6', icon: 'terminal', visibility: 'full' },
        { name: '测试工程师', modelSelector: "", prompt: '你负责编写与运行测试。只读仓库，不要修改源码。报告覆盖缺口与失败用例。', color: '#22c55e', icon: 'check', visibility: 'summary' },
      ]},
      { id: 'full-stack', name: '全栈小队', roles: [
        { name: '后端工程师', modelSelector: "", prompt: '你负责后端 API、数据模型与服务端逻辑。', color: '#f97316', icon: 'terminal', visibility: 'full' },
        { name: '前端工程师', modelSelector: "", prompt: '你负责前端界面与交互实现。', color: '#3b82f6', icon: 'terminal', visibility: 'full' },
        { name: 'DevOps', modelSelector: "", prompt: '你负责构建流程、CI/CD 与部署配置。', color: '#a855f7', icon: 'settings', visibility: 'summary' },
      ]},
      { id: 'code-review', name: '改码审查小队', roles: [
        { name: 'Coder', modelSelector: "", prompt: '你是实现工程师。检查仓库，只做请求的代码改动，运行最小相关测试。', color: '#3b82f6', icon: 'agent', visibility: 'full' },
        { name: 'Reviewer', modelSelector: "", prompt: '你是只读代码审查员。绝不修改文件。报告严重度、文件、行号、证据与具体修复建议。', color: '#ef4444', icon: 'shield', visibility: 'full' },
      ]},
    ])

    function applyList(list: ProviderConfig[], active: string) {
      providers.value = list
      activeId.value = active
      // 同步当前选择：优先 active，其次第一个
      const sel = list.find(p => p.id === active) ?? list[0]
      if (sel) {
        const fromContext = readContexts()[engineContext]
        const ctx = fromContext
          ? list.find(p => p.id === fromContext.providerId && p.models.includes(fromContext.model))
          : undefined
        const savedProvider = localStorage.getItem('coomi.providerId')
        const savedModel = localStorage.getItem('coomi.model')
        const legacy = engineContext === 'local'
          ? list.find(p => p.id === savedProvider && p.models.includes(savedModel ?? ''))
          : undefined
        const picked = ctx ?? legacy
        currentProviderId.value = picked?.id ?? sel.id
        currentModel.value = picked ? picked.models.find(m => m === (fromContext?.model ?? savedModel)) ?? picked.model ?? picked.models[0] ?? '' : (sel.model || sel.models[0] || '')
        saveContext()
      } else {
        currentProviderId.value = ''
        currentModel.value = ''
      }
    }

  /**
   * 从后端拉取 Provider 列表；失败则用 mock 兜底（浏览器独立开发）。
   *
   * 返回是否真的拿到了列表：调用方（尤其是「通道 open 后补加载」队列）要据此决定
   * 是出队还是等下一次连接。以前这里永远 resolve，失败的模型列表被当成成功出队，
   * 于是界面一直空着、也不再重试。
   */
  async function fetchProviders(): Promise<boolean> {
    const request = ++providersRequest
    const hadRealConfig = providers.value.length > 0 && !usingMock.value
    loading.value = true
    lastError.value = null
    try {
      const data = await apiGet<{ providers: ProviderConfig[]; active: string }>('/api/providers')
      if (request !== providersRequest) return true
      usingMock.value = false
      providersKnown.value = true
      applyList(data.providers ?? [], data.active ?? '')
      return true
    } catch (e) {
      if (request !== providersRequest) return true
      lastError.value = String(e)
      usingMock.value = !hadRealConfig && import.meta.env.DEV
      // Never replace a previously loaded real provider list with mock values: that
      // makes the chat look ready and silently sends against a model that doesn't exist.
      // 生产包更不能用 mock 顶替：那会把「电脑端模型没同步过来」伪装成「可用模型」。
      if (!hadRealConfig && !providers.value.length && import.meta.env.DEV) {
        usingMock.value = true
        applyList(MOCK_PROVIDERS, 'openai')
      }
      return false
    } finally {
      if (request === providersRequest) loading.value = false
    }
  }

  function selectModel(providerId: string, model: string) {
    currentProviderId.value = providerId; currentModel.value = model
    localStorage.setItem('coomi.providerId', providerId)
    localStorage.setItem('coomi.model', model)
    // 切模型时带出它自己的档位；没存过就沿用当前档位。
    const saved = effortForModel(providerId, model)
    if (saved) reasoningEffort.value = saved
    saveContext()
  }

  /** 切换引擎（本地/某台电脑）时换用对应的模型选择，并让 UI 重新拉列表。 */
  function switchEngineContext(key: string): void {
    if (key === engineContext) return
    saveContext()
    engineContext = key
    // 上一台引擎的模型列表对新引擎没有意义：清空并作废在途请求，
    // 否则界面会短暂（甚至一直）显示另一台机器/本地的模型。
    providersRequest += 1
    providers.value = []
    activeId.value = ''
    currentProviderId.value = ''
    currentModel.value = ''
    usingMock.value = false
    providersKnown.value = false
    const next = readContexts()[key]
    if (next) {
      currentProviderId.value = next.providerId
      currentModel.value = next.model
    }
    bumpProviders()
  }
  /** 当前上下文键（local / cloud:<deviceId>），供调用方判断是否需要重新拉模型。 */
  function engineContextKey(): string { return engineContext }
  function setPermissionMode(mode: PermissionMode) {
    permissionMode.value = mode
    localStorage.setItem('coomi.permissionMode', mode)
  }
  /**
   * 每模型记住档位：切到某个模型时自动带出它上次的档位。
   * 存储键 coomi.modelReasoning = { "providerId::model": "high" }。
   */
  const MODEL_EFFORT_KEY = 'coomi.modelReasoning'
  function readModelEfforts(): Record<string, ReasoningEffort> {
    try {
      const raw = JSON.parse(localStorage.getItem(MODEL_EFFORT_KEY) || '{}') as Record<string, ReasoningEffort>
      return raw && typeof raw === 'object' ? raw : {}
    } catch { return {} }
  }
  function modelEffortKey(providerId = currentProviderId.value, model = currentModel.value): string {
    return providerId && model ? `${providerId}::${model}` : ''
  }
  function effortForModel(providerId = currentProviderId.value, model = currentModel.value): ReasoningEffort | null {
    const key = modelEffortKey(providerId, model)
    if (!key) return null
    const value = readModelEfforts()[key]
    return REASONING_EFFORTS.some(item => item.value === value) ? value : null
  }
  function setReasoningEffort(effort: ReasoningEffort) {
    reasoningEffort.value = effort
    localStorage.setItem('coomi.reasoningEffort', effort)
    const key = modelEffortKey()
    if (!key) return
    try {
      const map = readModelEfforts()
      map[key] = effort
      localStorage.setItem(MODEL_EFFORT_KEY, JSON.stringify(map))
    } catch { /* localStorage 满了就算了，档位不是关键数据 */ }
  }
  // ── §1 平滑输出（rc35）：流式正文分批渐出（多字一起出现，肉眼更顺）；
  //    新内容稀疏时自动放慢节奏。纯 UI 开关，不进引擎。 ──
  const smoothOutput = ref(localStorage.getItem('coomi.smoothOutput') !== '0')
  function setSmoothOutput(enabled: boolean) {
    smoothOutput.value = enabled
    localStorage.setItem('coomi.smoothOutput', enabled ? '1' : '0')
  }

  function persistEndToEndFallbacks() {
    try { localStorage.setItem('coomi.endToEndFallbacks', JSON.stringify(endToEndFallbacks.value)) } catch { /* ignore */ }
  }
  function addEndToEndFallback(providerId: string, model: string) {
    if (!providerId || !model) return
    if (endToEndFallbacks.value.some(item => item.providerId === providerId && item.model === model)) return
    endToEndFallbacks.value.push({ id: `${providerId}::${model}`, providerId, model })
    persistEndToEndFallbacks()
  }
  function removeEndToEndFallback(id: string) {
    endToEndFallbacks.value = endToEndFallbacks.value.filter(item => item.id !== id)
    persistEndToEndFallbacks()
  }
  function moveEndToEndFallback(id: string, direction: -1 | 1) {
    const index = endToEndFallbacks.value.findIndex(item => item.id === id)
    const target = index + direction
    if (index < 0 || target < 0 || target >= endToEndFallbacks.value.length) return
    const list = endToEndFallbacks.value.slice()
    ;[list[index], list[target]] = [list[target], list[index]]
    endToEndFallbacks.value = list
    persistEndToEndFallbacks()
  }
  function setEndToEndFailThreshold(threshold: number) {
    const value = Number.isInteger(threshold) && threshold >= 1 && threshold <= 20 ? threshold : 3
    endToEndFailThreshold.value = value
    localStorage.setItem('coomi.endToEndFailThreshold', String(value))
  }

  function cacheConnectionSettings(value: ConnectionSettings) {
    connectionSettings.value = { ...value }
    localStorage.setItem('coomi.providerRetryCount', String(value.providerRetryCount))
    localStorage.setItem('coomi.wsRetryCount', String(value.wsRetryCount))
    localStorage.setItem('coomi.reconnectInitialDelayMs', String(value.reconnectInitialDelayMs))
    localStorage.setItem('coomi.reconnectMaxDelayMs', String(value.reconnectMaxDelayMs))
    localStorage.setItem('coomi.maxConcurrentTasks', String(value.maxConcurrentTasks))
  }

  async function fetchConnectionSettings(): Promise<boolean> {
    try {
      const value = await apiGet<ConnectionSettings>('/api/settings/connection')
      cacheConnectionSettings(value)
      return true
    } catch {
      return false
    }
  }

  async function saveConnectionSettings(value: ConnectionSettings): Promise<boolean> {
    const normalized: ConnectionSettings = {
      providerRetryCount: Math.trunc(value.providerRetryCount),
      wsRetryCount: Math.trunc(value.wsRetryCount),
      reconnectInitialDelayMs: Math.trunc(value.reconnectInitialDelayMs),
      reconnectMaxDelayMs: Math.trunc(value.reconnectMaxDelayMs),
      maxConcurrentTasks: Math.trunc(value.maxConcurrentTasks),
    }
    if (normalized.providerRetryCount < 0 || normalized.providerRetryCount > 10
      || normalized.wsRetryCount < 0 || normalized.wsRetryCount > 30
      || normalized.reconnectInitialDelayMs < 500 || normalized.reconnectInitialDelayMs > 60_000
      || normalized.reconnectMaxDelayMs < 1_000 || normalized.reconnectMaxDelayMs > 120_000
      || normalized.maxConcurrentTasks < 1 || normalized.maxConcurrentTasks > 20
      || normalized.reconnectMaxDelayMs < normalized.reconnectInitialDelayMs) return false
    try {
      const saved = await apiSend<ConnectionSettings>('/api/settings/connection', 'PUT', normalized)
      cacheConnectionSettings(saved)
      return true
    } catch {
      return false
    }
  }

  /**
   * 三档主题。应用后：
   * - 写入 <html data-theme>（前端样式即时切换）；
   * - Android WebView 内通知原生（CoomiAndroid.setThemeMode），原生据此改状态栏
   *   颜色并重新注入 data-theme；桌面浏览器直接由 applyTheme 生效。
   */
  function setThemeMode(mode: ThemeMode) {
    if (document.documentElement.dataset.customAppearance === 'true') return
    themeMode.value = mode
    localStorage.setItem('coomi.themeMode', mode)
    applyTheme(mode)
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.setThemeMode === 'function') {
      try { bridge.setThemeMode(mode) } catch { /* 忽略桥异常 */ }
    }
  }
  /** 选界面字号：写 localStorage + 立即写到 <html>，不需要重进页面。 */
  function setUiFontScale(value: UiFontScale) {
    uiFontScale.value = normalizeUiFontScale(value)
    localStorage.setItem('coomi.uiFontScale', String(uiFontScale.value))
    applyUiAppearance(uiFontScale.value, listDensity.value)
  }
  /** 选列表密度：宽松=现状，紧凑把行高与上下内边距压低。 */
  function setListDensity(value: ListDensity) {
    listDensity.value = normalizeListDensity(value)
    localStorage.setItem('coomi.listDensity', listDensity.value)
    applyUiAppearance(uiFontScale.value, listDensity.value)
  }
  function cyclePermissionMode(): PermissionMode {
    const order: PermissionMode[] = ['ask', 'auto', 'full']
    const idx = order.indexOf(permissionMode.value)
    permissionMode.value = order[(idx + 1) % order.length]
    return permissionMode.value
  }
  function togglePlanMode() {
    planMode.value = !planMode.value
  }

  /** 只写意图，不发命令 —— 实际下发由 session.toggleReverseMode 统一负责。 */
  function setReverseModeTarget(enabled: boolean) {
    reverseModeTarget.value = enabled
    try { localStorage.setItem(REVERSE_ENABLED_KEY, enabled ? '1' : '0') } catch { /* 隐私模式无 localStorage：忽略 */ }
  }
  function setReverseFlavor(flavor: ReverseFlavor) {
    const next = normalizeFlavor(flavor)
    reverseFlavor.value = next
    try { localStorage.setItem(REVERSE_FLAVOR_KEY, next) } catch { /* 同上 */ }
  }
  /** 写采样设置（实验性）：写之前 clamps + 重算签名，读的时候签名不符会回默认。 */
  function setReverseSampling(patch: Partial<ReverseSampling>) {
    const next: ReverseSampling = { ...reverseSampling.value, ...patch }
    reverseSampling.value = next
    writeReverseSampling(localStorage, next)
  }
  function resetReverseSampling() {
    reverseSampling.value = { ...REVERSE_SAMPLING_DEFAULTS }
    writeReverseSampling(localStorage, reverseSampling.value)
  }
  /** 写片段开关（实验性）：写盘时重算签名，读回来签名不符会整份丢弃。 */
  function setReverseExperiment(patch: Partial<ReverseExperiments>) {
    const next: ReverseExperiments = { ...reverseExperiments.value, ...patch }
    reverseExperiments.value = next
    writeReverseExperiments(localStorage, next)
  }
  function resetReverseExperiments() {
    reverseExperiments.value = { ...REVERSE_EXPERIMENTS_DEFAULTS }
    writeReverseExperiments(localStorage, reverseExperiments.value)
  }

  /**
   * 全局会话记忆：关闭（默认）时 Coomi 无法读取任何历史会话文件；
   * 开启后它才能读取所有历史会话记录。历史会话列表始终可见，与本开关无关。
   * 引擎 settings.json 是权威值；localStorage 只是 UI 缓存，启动时以引擎为准。
   */
  const globalMemory = ref(localStorage.getItem('coomi.globalMemory') === '1')
  const digitalLifeEnabled = ref(localStorage.getItem('coomi.digitalLifeEnabled') === '1')
  /** 数字生命体「用于全局会话」：开启后所有对话都带生命体人格（引擎侧 settings.globalMode 为权威）。 */
  const lifeGlobalMode = ref(localStorage.getItem('coomi.lifeGlobalMode') === '1')

  function setLifeGlobalMode(enabled: boolean) {
    lifeGlobalMode.value = enabled
    localStorage.setItem('coomi.lifeGlobalMode', enabled ? '1' : '0')
  }

  function syncDigitalLifeEnabled() {
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.getDigitalLifeEnabled === 'function') {
      try { digitalLifeEnabled.value = !!bridge.getDigitalLifeEnabled() } catch { /* 使用本地缓存 */ }
    }
    localStorage.setItem('coomi.digitalLifeEnabled', digitalLifeEnabled.value ? '1' : '0')
  }

  async function fetchSubAgentSettings(): Promise<boolean> {
    if (usingMock.value) return true
    try {
      const data = await apiGet<SubAgentSettings>('/api/settings/subagents')
      subAgentSettings.value = {
        agents: (data.agents ?? []).map(agent => ({ ...agent })),
        fallbackId: data.fallbackId,
        maxAgents: Math.max(1, Math.min(30, data.maxAgents || 20)),
        maxConcurrentAgents: Math.max(1, Math.min(20, data.maxConcurrentAgents || 3)),
      }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function saveSubAgentSettings(value: SubAgentSettings): Promise<boolean> {
    if (usingMock.value) {
      subAgentSettings.value = {
        agents: value.agents.map(agent => ({ ...agent })),
        fallbackId: value.fallbackId,
        maxAgents: value.maxAgents,
        maxConcurrentAgents: value.maxConcurrentAgents ?? 3,
      }
      return true
    }
    try {
      const saved = await apiSend<SubAgentSettings>('/api/settings/subagents', 'PUT', value)
      subAgentSettings.value = {
        agents: (saved.agents ?? []).map(agent => ({ ...agent })),
        fallbackId: saved.fallbackId,
        maxAgents: Math.max(1, Math.min(30, saved.maxAgents || value.maxAgents)),
        maxConcurrentAgents: Math.max(1, Math.min(20, saved.maxConcurrentAgents || value.maxConcurrentAgents || 3)),
      }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function fetchCollaborationSettings(): Promise<boolean> {
    if (usingMock.value) return true
    try {
      const data = await apiGet<CollaborationSettings>('/api/settings/collaboration')
      collaborationSettings.value = { ...collaborationSettings.value, ...data }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function saveCollaborationSettings(value: CollaborationSettings): Promise<boolean> {
    const normalized = {
      ...value,
      coderSelector: value.coderSelector.trim(),
      reviewerSelector: value.reviewerSelector.trim(),
      maxCycles: Math.max(1, Math.min(3, Math.trunc(value.maxCycles))),
    }
    if (usingMock.value) {
      collaborationSettings.value = normalized
      return true
    }
    try {
      const saved = await apiSend<CollaborationSettings>('/api/settings/collaboration', 'PUT', normalized)
      collaborationSettings.value = { ...collaborationSettings.value, ...saved }
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

    async function fetchCollabRoles(): Promise<boolean> {
    if (usingMock.value) {
    collabRoles.value = collabPresets.value.flatMap(p => p.roles.map(r => ({ ...r, id: p.id + '-' + r.name })))
    return true
    }
    try {
    const data = await apiGet<CollabSettings>('/api/settings/collab')
    collabRoles.value = (data.roles ?? []).map((r, i) => ({ ...r, id: r.id || 'role_' + i }))
    return true
    } catch (e) {
    lastError.value = String(e)
    return false
    }
    }

    async function saveCollabRoles(value: CollabRole[]): Promise<boolean> {
    if (usingMock.value) {
    collabRoles.value = value.map((r, i) => ({ ...r, id: r.id || 'role_' + i }))
    return true
    }
    try {
    // 只提交 roles；其余字段走 serde 默认值，避免把占位垃圾写进引擎设置。
    const saved = await apiSend<CollabSettings>('/api/settings/collab', 'PUT', { roles: value })
    collabRoles.value = (saved.roles ?? []).map((r, i) => ({ ...r, id: r.id || 'role_' + i }))
    return true
    } catch (e) {
    lastError.value = String(e)
    return false
    }
    }

    function applyCollabPreset(id: string) {
    const preset = collabPresets.value.find(p => p.id === id)
    if (!preset) return
    collabRoles.value = preset.roles.map((r, i) => ({ ...r, id: id + '-' + i }))
    }
  async function validateAndSelectModel(providerId: string, model: string): Promise<boolean> {
    try {
      await apiSend(`/api/providers/${encodeURIComponent(providerId)}/select-model`, 'POST', { model })
      selectModel(providerId, model)
      activeId.value = providerId
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  function setDigitalLifeEnabled(enabled: boolean) {
    digitalLifeEnabled.value = enabled
    localStorage.setItem('coomi.digitalLifeEnabled', enabled ? '1' : '0')
    const bridge = (window as any).CoomiAndroid
    if (bridge && typeof bridge.setDigitalLifeEnabled === 'function') {
      try { bridge.setDigitalLifeEnabled(enabled) } catch { /* 本地状态仍可用 */ }
    }
  }
  /** 从引擎拉取权威值（应用启动时调用），覆盖本地缓存与开关显示。 */
  async function syncGlobalMemoryFromEngine() {
    try {
      const data = await apiGet<{ enabled: boolean }>('/api/runtime/global-memory')
      const enabled = !!data?.enabled
      globalMemory.value = enabled
      localStorage.setItem('coomi.globalMemory', enabled ? '1' : '0')
    } catch {
      /* 引擎未就绪：保持本地缓存，稍后用户操作开关时会再次同步 */
    }
  }
  async function toggleGlobalMemory() {
    const previous = globalMemory.value
    const next = !previous
    globalMemory.value = next
    localStorage.setItem('coomi.globalMemory', next ? '1' : '0')
    // 同步引擎侧：关闭时引擎屏蔽会话/配置目录的工具访问 + 系统提示加隐私禁令。
    // 失败必须回滚并提示，否则会出现「开关显示关、引擎实际开着」的脱节。
    try {
      await apiSend('/api/runtime/global-memory', 'POST', { enabled: next })
    } catch {
      globalMemory.value = previous
      localStorage.setItem('coomi.globalMemory', previous ? '1' : '0')
      throw new Error('同步引擎失败，开关已还原')
    }
  }

  /**
   * 本地留痕：引擎 capabilities 块（settings.json，驼峰键 localTraceEnabled / localTraceMaxMb）。
   * 走既有的能力开关读写口 GET/PUT /api/agent/preferences，且只提交 capabilities 补丁，
   * 与 memory / subagents 等能力开关同一套模式：引擎侧是权威值，localStorage 只做 UI 缓存。
   */
  const localTraceEnabled = ref(localStorage.getItem('coomi.localTraceEnabled') !== '0')
  const localTraceMaxMb = ref(normalizeLocalTraceMb(localStorage.getItem('coomi.localTraceMaxMb')))
  function persistLocalTrace() {
    localStorage.setItem('coomi.localTraceEnabled', localTraceEnabled.value ? '1' : '0')
    localStorage.setItem('coomi.localTraceMaxMb', String(localTraceMaxMb.value))
  }
  /** 从引擎拉权威值；失败保持本地缓存（引擎未就绪时用户仍能看到上次的选择）。 */
  async function fetchLocalTraceSettings(): Promise<boolean> {
    if (usingMock.value) return true
    try {
      const data = await apiGet<{ capabilities?: Partial<LocalTraceSettings> }>('/api/agent/preferences')
      const cap = data?.capabilities ?? {}
      localTraceEnabled.value = cap.localTraceEnabled ?? true
      localTraceMaxMb.value = normalizeLocalTraceMb(cap.localTraceMaxMb)
      persistLocalTrace()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }
  /**
   * 保存留痕开关 / 体积上限：乐观更新 + 失败回滚（与全局记忆开关同一套语义），
   * 避免出现「开关显示关、引擎实际还开着」的脱节。成功返回 true。
   */
  async function saveLocalTraceSettings(patch: Partial<LocalTraceSettings>): Promise<boolean> {
    const previous: LocalTraceSettings = {
      localTraceEnabled: localTraceEnabled.value,
      localTraceMaxMb: localTraceMaxMb.value,
    }
    const next: LocalTraceSettings = {
      localTraceEnabled: patch.localTraceEnabled ?? previous.localTraceEnabled,
      localTraceMaxMb: patch.localTraceMaxMb === undefined
        ? previous.localTraceMaxMb
        : normalizeLocalTraceMb(patch.localTraceMaxMb),
    }
    localTraceEnabled.value = next.localTraceEnabled
    localTraceMaxMb.value = next.localTraceMaxMb
    persistLocalTrace()
    if (usingMock.value) return true
    try {
      const saved = await apiSend<{ capabilities?: Partial<LocalTraceSettings> }>(
        '/api/agent/preferences',
        'PUT',
        { capabilities: { localTraceEnabled: next.localTraceEnabled, localTraceMaxMb: next.localTraceMaxMb } },
      )
      const cap = saved?.capabilities
      if (cap) {
        // 引擎会把 >0 的上限夹在 1~4096，回写夹紧后的值，别让 UI 显示越界数字。
        localTraceEnabled.value = cap.localTraceEnabled ?? next.localTraceEnabled
        localTraceMaxMb.value = normalizeLocalTraceMb(cap.localTraceMaxMb ?? next.localTraceMaxMb)
        persistLocalTrace()
      }
      return true
    } catch (e) {
      lastError.value = String(e)
      localTraceEnabled.value = previous.localTraceEnabled
      localTraceMaxMb.value = previous.localTraceMaxMb
      persistLocalTrace()
      return false
    }
  }

  /**
   * 定制身份提示词：用户设置的专属身份/定位指令，保存后注入系统提示词，
   * 让 AI 认知自己的身份与定位。引擎 settings.json 是权威值；
   * localStorage 只做 UI 缓存。
   */
  const customPrompt = ref(localStorage.getItem('coomi.customPrompt') ?? '')
  /** 从引擎拉取权威值（应用启动 / 进入设置页时调用）。 */
  async function fetchCustomPrompt() {
    try {
      const data = await apiGet<{ text: string }>('/api/runtime/custom-prompt')
      customPrompt.value = data?.text ?? ''
      localStorage.setItem('coomi.customPrompt', customPrompt.value)
      return true
    } catch {
      return false
    }
  }
  /** 保存定制提示词；空文本表示清除。成功返回 true。 */
  async function saveCustomPrompt(text: string): Promise<boolean> {
    try {
      const data = await apiSend<{ text: string }>('/api/runtime/custom-prompt', 'POST', { text })
      customPrompt.value = data?.text ?? text
      localStorage.setItem('coomi.customPrompt', customPrompt.value)
      return true
    } catch {
      return false
    }
  }

  /** 新增/更新 Provider。空 apiKey 表示沿用旧 key（后端语义）。 */
  /**
   * 引擎只接受 32000..1048576 的上下文窗口（ui/src/web/mod.rs 硬校验）。
   * 自动探测到的 1049k 这类值会超上限，保存前先夹紧，别把整次保存打成 400。
   */
  const CONTEXT_MIN = 32_000
  const CONTEXT_MAX = 1_048_576
  function clampContextWindow(value: number | undefined): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return value
    return Math.min(CONTEXT_MAX, Math.max(CONTEXT_MIN, Math.round(value)))
  }
  function clampContextMap(map: Record<string, number> | undefined): Record<string, number> | undefined {
    if (!map) return map
    const out: Record<string, number> = {}
    for (const [model, value] of Object.entries(map)) out[model] = clampContextWindow(value) ?? value
    return out
  }

  async function upsertProvider(input: ProviderInput): Promise<boolean> {
    if (usingMock.value) {
      // 浏览器兜底：仅本地更新，不落盘
      const existing = providers.value.find(p => p.id === input.id)
      const apiKeyMasked = input.apiKey ? '****' + input.apiKey.slice(-4) : (existing?.apiKeyMasked ?? '')
      const hasKey = input.apiKey ? true : (existing?.hasKey ?? false)
      if (existing) {
        Object.assign(existing, {
          name: input.name, apiKeyMasked, hasKey, models: input.models,
          baseUrl: input.baseUrl, type: input.type, toolProtocol: input.toolProtocol,
          contextWindow: input.contextWindow, fastModel: input.fastModel,
          modelContextWindows: { ...(input.modelContextWindows ?? {}) },
          supportsWebSearch: input.supportsWebSearch, supportsVision: input.supportsVision,
          modelDescriptions: { ...(input.modelDescriptions ?? {}) }, modelParameters: { ...(input.modelParameters ?? {}) },
          capabilityOverrides: { ...(input.capabilityOverrides ?? {}) },
          model: input.models[0],
        })
      } else {
        providers.value.push({
          id: input.id, name: input.name, apiKeyMasked, hasKey, models: input.models,
          baseUrl: input.baseUrl, type: input.type, toolProtocol: input.toolProtocol,
          contextWindow: input.contextWindow, fastModel: input.fastModel,
          modelContextWindows: { ...(input.modelContextWindows ?? {}) },
          supportsWebSearch: input.supportsWebSearch, supportsVision: input.supportsVision,
          modelDescriptions: { ...(input.modelDescriptions ?? {}) }, modelParameters: { ...(input.modelParameters ?? {}) },
          capabilityOverrides: { ...(input.capabilityOverrides ?? {}) },
          model: input.models[0],
        })
      }
      if (input.activate) activeId.value = input.id
      bumpProviders()
      return true
    }
    try {
      await apiSend('/api/providers', 'POST', {
        id: input.id,
        name: input.name,
        apiKey: input.apiKey,
        models: input.models,
        model: input.models[0],
        baseUrl: input.baseUrl,
        type: input.type,
        toolProtocol: input.toolProtocol,
        contextWindow: clampContextWindow(input.contextWindow),
        modelContextWindows: clampContextMap(input.modelContextWindows),
        fastModel: input.fastModel,
        supportsWebSearch: input.supportsWebSearch,
        supportsVision: input.supportsVision,
        modelDescriptions: input.modelDescriptions,
        modelParameters: input.modelParameters,
        capabilityOverrides: input.capabilityOverrides,
        activate: input.activate,
      })
      await fetchProviders()
      bumpProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function deleteProvider(id: string): Promise<boolean> {
    if (!id.trim()) return true
    if (usingMock.value) {
      const remaining = providers.value.filter(p => p.id !== id)
      applyList(remaining, activeId.value === id ? (remaining[0]?.id ?? '') : activeId.value)
      bumpProviders()
      return true
    }
    try {
      await apiSend(`/api/providers/${encodeURIComponent(id)}`, 'DELETE')
      await fetchProviders()
      bumpProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function activateProvider(id: string): Promise<boolean> {
    if (usingMock.value) {
      const provider = providers.value.find(item => item.id === id)
      if (!provider) return false
      activeId.value = id
      selectModel(id, provider.model || provider.models[0] || '')
      bumpProviders()
      return true
    }
    try {
      await apiSend(`/api/providers/${encodeURIComponent(id)}/activate`, 'POST')
      await fetchProviders()
      const provider = providers.value.find(item => item.id === id)
      if (!provider) throw new Error('已激活的提供商未出现在配置列表中')
      const savedProvider = localStorage.getItem('coomi.providerId')
      const savedModel = localStorage.getItem('coomi.model')
      const model = savedProvider === id && provider.models.includes(savedModel ?? '')
        ? savedModel!
        : (provider.model || provider.models[0] || '')
      selectModel(id, model)
      bumpProviders()
      return true
    } catch (e) {
      lastError.value = String(e)
      return false
    }
  }

  async function copyProvider(id: string): Promise<string | null> {
    try {
      const result = await apiSend<{ id: string }>(`/api/providers/${encodeURIComponent(id)}/copy`, 'POST')
      await fetchProviders()
      bumpProviders()
      return result.id
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  async function revealProviderKey(id: string): Promise<string | null> {
    if (usingMock.value) return null
    try {
      const result = await apiSend<{ apiKey: string }>(`/api/providers/${encodeURIComponent(id)}/reveal`, 'POST')
      return result.apiKey
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  async function discoverModels(id: string, persist = false): Promise<string[] | null> {
    if (usingMock.value) return providers.value.find(provider => provider.id === id)?.models ?? []
    try {
      const result = await apiSend<{ models: string[] }>(
        `/api/providers/${encodeURIComponent(id)}/discover-models`,
        'POST',
        { persist },
      )
      if (persist) {
        await fetchProviders()
        bumpProviders()
      }
      return result.models
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  /** 自动获取模型上下文长度：探测上游 /models 的 context 字段并持久化。 */
  async function discoverContext(id: string): Promise<{ contextWindows: Record<string, number>; contextWindow?: number } | null> {
    if (usingMock.value) return null
    try {
      const path = '/api/providers/' + encodeURIComponent(id) + '/discover-context'
      const result = await apiSend<{ contextWindows: Record<string, number>; contextWindow?: number; stale: boolean }>(
        path,
        'POST',
        { persist: false },
      )
      await fetchProviders()
      bumpProviders()
      return { contextWindows: result.contextWindows ?? {}, contextWindow: result.contextWindow }
    } catch (e) {
      lastError.value = String(e)
      return null
    }
  }

  return {
    permissionMode, planMode, themeMode, uiFontScale, listDensity, reasoningEffort, defaultPage, setDefaultPage, endToEndFallbacks, endToEndFailThreshold, connectionSettings, globalMemory, digitalLifeEnabled, lifeGlobalMode, setLifeGlobalMode, localTraceEnabled, localTraceMaxMb, customPrompt, providers, activeId, loading, usingMock, providersKnown, lastError, subAgentSettings, collaborationSettings, collabRoles, collabPresets,
    reverseModeTarget, reverseFlavor, setReverseModeTarget, setReverseFlavor,
    reverseSampling, setReverseSampling, resetReverseSampling,
    reverseExperiments, setReverseExperiment, resetReverseExperiments,
    currentProviderId, currentModel, switchEngineContext, engineContextKey, currentProvider, mergedProviders, providerRevision, bumpProviders,
    fetchProviders, selectModel, validateAndSelectModel, setPermissionMode, setThemeMode, setUiFontScale, setListDensity, setReasoningEffort, addEndToEndFallback, removeEndToEndFallback, moveEndToEndFallback, setEndToEndFailThreshold, fetchConnectionSettings, saveConnectionSettings, cyclePermissionMode, togglePlanMode,
    toggleGlobalMemory, syncGlobalMemoryFromEngine, setDigitalLifeEnabled, syncDigitalLifeEnabled, fetchLocalTraceSettings, saveLocalTraceSettings, fetchCustomPrompt, saveCustomPrompt, smoothOutput, setSmoothOutput,
    upsertProvider, deleteProvider, activateProvider, copyProvider, revealProviderKey, discoverModels, discoverContext, fetchSubAgentSettings, saveSubAgentSettings, fetchCollaborationSettings, saveCollaborationSettings, fetchCollabRoles, saveCollabRoles, applyCollabPreset,
  }
})

function readStoredInt(key: string, min: number, max: number, fallback: number): number {
  const value = Number(localStorage.getItem(key))
  return Number.isInteger(value) && value >= min && value <= max ? value : fallback
}

/** 留痕上限归一：0 = 不限，其余夹到 1~4096 MB（与引擎 CapabilitySettings::sanitized 同口径）。 */
function normalizeLocalTraceMb(value: unknown): number {
  const n = Math.trunc(Number(value))
  if (!Number.isFinite(n) || n <= 0) return 0
  return Math.min(4096, Math.max(1, n))
}

function readEndToEndFallbacks(): EndToEndFallback[] {
  try {
    const raw = localStorage.getItem('coomi.endToEndFallbacks')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(item =>
      item && typeof item.id === 'string' && typeof item.providerId === 'string' && typeof item.model === 'string',
    )
  } catch { return [] }
}
