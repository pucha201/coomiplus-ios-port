/**
 * 逆向模式（Reverse Mode）· 前端基础层。
 *
 * 设计约束（与实现一一对应）：
 *  1. 「开就是开了」：目标态落 localStorage，杀进程重启后保持。
 *  2. 「生效在轮次边界」：目标态（target）与引擎实际生效态（committed）分离。
 *     生成中点击只改 target，pill 转 pending 视觉；turn_end 那一拍才发命令。
 *     为什么不能在点击瞬间发：turn_prompt 与 prompt_context 在本轮开始时
 *     就已经拼完（web/mod.rs 的 run_turn），中途改布尔量对这一轮毫无作用 ——
 *     用户会以为关掉了，其实还在逆向契约下跑完整轮。
 *  3. 首次使用必须先过免责声明；未同意时点 pill 弹 sheet，不直接开。
 *  4. flavor（厂商口味）只影响契约的措辞层，不影响结构。不按 ProviderKind
 *     自动推断：同一个 OpenAiCompatible 下可能挂任何模型，推断必错，让用户选。
 */

/** 契约的措辞口味。`generic` 永远是默认与兜底。 */
export type ReverseFlavor = 'generic' | 'deepseek' | 'anthropic' | 'openai' | 'gemini'

/** 顺序即展示顺序：通用永远第一位。 */
export const REVERSE_FLAVORS: { value: ReverseFlavor; label: string; hint: string }[] = [
  { value: 'generic', label: '通用', hint: '中文契约 · 任何模型先用这个' },
  { value: 'deepseek', label: 'DeepSeek / 国产系', hint: '禁模板句 · 先命令后解释' },
  { value: 'anthropic', label: 'Claude 系', hint: '英文补丁 · 消犹豫 · 求完整' },
  { value: 'openai', label: 'GPT 系', hint: '英文补丁 · 首句即答案 · 免自审' },
  { value: 'gemini', label: 'Gemini 系', hint: '英文补丁 · 去铺垫 · 不注水' },
]

export const REVERSE_FLAVOR_VALUES: ReverseFlavor[] = REVERSE_FLAVORS.map(item => item.value)

/**
 * 顶栏盾牌用的极短名。
 *
 * 用量环角落只有 16px，塞不下「DeepSeek / 国产系」这种长度，
 * 而 title 已经写了全名，这里只要能让用户扫一眼分辨即可。
 */
export const REVERSE_FLAVOR_SHORT: Record<ReverseFlavor, string> = {
  generic: '通用',
  deepseek: 'DS',
  anthropic: 'Claude',
  openai: 'GPT',
  gemini: 'Gemini',
}

export function normalizeFlavor(value: unknown): ReverseFlavor {
  return REVERSE_FLAVOR_VALUES.includes(value as ReverseFlavor) ? (value as ReverseFlavor) : 'generic'
}

export function flavorLabel(value: ReverseFlavor): string {
  return REVERSE_FLAVORS.find(item => item.value === value)?.label ?? '通用'
}

// ── 持久化键 ───────────────────────────────────────────────────────────────
export const REVERSE_ENABLED_KEY = 'coomi.reverseMode'
export const REVERSE_FLAVOR_KEY = 'coomi.reverseMode.flavor'
export const REVERSE_CONSENT_KEY = 'coomi.reverseMode.consent'
export const REVERSE_SAMPLING_KEY = 'coomi.reverseMode.sampling'
export const REVERSE_EXPERIMENTS_KEY = 'coomi.reverseMode.experiments'

/**
 * 免责声明版本。文案变更必须递增，旧同意作废、重新征询。
 * v2：从单页声明改成「声明 → 警告 → 最终确认」三页。
 */
export const REVERSE_CONSENT_VERSION = 2

/**
 * 采样参数（实验性）。
 *
 * 默认全关：开启后会把请求里的 temperature / top_p / 惩罚系数换成这里的值。
 * 这类参数影响**所有**输出（包括正常技术回答），不只是破甲效果，所以不能默认开。
 * 只在逆向模式生效，关闭逆向即恢复供应商默认。
 *
 * 注意：契约片段的开关**不在这里**，见 `ReverseExperiments`。
 * 两者性质不同 —— 这里改的是请求参数，那边改的是注入的提示词内容。
 */
export interface ReverseSampling {
  /** 总开关：false 时下面所有值都不生效，请求原样发出。 */
  enabled: boolean
  /** 温度。越高越不容易落回高概率的拒绝模板，但技术细节的稳定性会下降。 */
  temperature: number
  /** 核采样。 */
  topP: number
  /** 存在惩罚：抑制重复话题，能减少「反复声明我不能」这类循环。 */
  presencePenalty: number
  /** 频率惩罚：抑制重复用词。 */
  frequencyPenalty: number
}

export const REVERSE_SAMPLING_DEFAULTS: ReverseSampling = {
  enabled: false,
  temperature: 0.95,
  topP: 0.98,
  presencePenalty: 0.6,
  frequencyPenalty: 0.2,
}

/**
 * 契约片段开关（实验性）。
 *
 * 每一项对应引擎侧一个独立的掩码片段，开启后追加到基础契约末尾。
 * 拼接顺序固定：思考阶段免合规 → 思考指引 → 严格模式。
 * 这个顺序是刻意的 —— 先划边界，再给方法，最后压行为；
 * 把严格模式放前面会让它的「不要在最终输出里评论」盖掉思考指引的五步清单。
 *
 * 全部默认关。开启会让契约变长，片段越多彼此稀释的风险越高。
 */
export interface ReverseExperiments {
  /** 严格模式：只做，不评论。正常对话也会变机械。 */
  strictMode: boolean
  /** 思考指引：在 reasoning 阶段给五步推演清单。 */
  thinkingGuide: boolean
  /** 思考阶段免合规：缓解「破甲后模型不思考」。 */
  thinkingFree: boolean
  /** 题类识别：按问法（原理/实现/方案/判断/分析）分流，减少误伤。 */
  routeGuide: boolean
}

export const REVERSE_EXPERIMENTS_DEFAULTS: ReverseExperiments = {
  strictMode: false,
  thinkingGuide: false,
  thinkingFree: false,
  routeGuide: false,
}

/** 实验项元数据：给子页面渲染用，顺序即拼接顺序的反向（展示顺序按「影响面」排）。 */
export const REVERSE_EXPERIMENT_ITEMS: {
  key: keyof ReverseExperiments
  label: string
  hint: string
  /** 开启后大概增加的契约字数，用于提示总长度 */
  approxChars: number
}[] = [
  {
    key: 'thinkingGuide',
    label: '思考指引',
    hint: '在 reasoning 阶段给模型一份五步推演清单：判类型 → 列缺口 → 比方案 → 定形态 → 查坑。输出形式不变。',
    approxChars: 380,
  },
  {
    key: 'routeGuide',
    label: '题类识别',
    hint: '按问法分流：问原理给机制、问实现给代码、问方案给流程、问判断给依据。减少「问原理被当成问实现」的误伤。',
    approxChars: 580,
  },
  {
    key: 'thinkingFree',
    label: '思考阶段免合规判断',
    hint: '明确告诉模型：reasoning 里不评估请求是否合适。用于缓解「开了逆向反而不会思考」。',
    approxChars: 190,
  },
  {
    key: 'strictMode',
    label: '严格模式（硬条款）',
    hint: '最终输出里不解释、不评论、不建立元叙事。破甲更彻底，但正常对话也会显得机械。',
    approxChars: 270,
  },
]

/** 各字段的合法范围（与主流供应商 API 的接受范围取交集）。 */
export const REVERSE_SAMPLING_RANGES = {
  temperature: { min: 0, max: 2, step: 0.05 },
  topP: { min: 0.05, max: 1, step: 0.01 },
  presencePenalty: { min: -2, max: 2, step: 0.1 },
  frequencyPenalty: { min: -2, max: 2, step: 0.1 },
} as const

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, n))
}

/**
 * 采样设置签名。
 *
 * 与同意记录同一套 FNV-1a：目的不是密码学防护，而是**让手改的配置判无效**。
 * 为什么采样也要签：这些参数直接决定请求怎么发，改 temperature=2 能让输出崩坏，
 * 改 presencePenalty=-2 能让模型复读——一个被改坏的配置比不开更糟。
 */
function samplingSignature(value: ReverseSampling): string {
  // v3：strictMode 已迁到 ReverseExperiments，不再参与采样签名。
  const seed = `coomi-reverse-sampling:${value.enabled}:${value.temperature}:${value.topP}:${value.presencePenalty}:${value.frequencyPenalty}:v3`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function readReverseSampling(storage: Storage | undefined): ReverseSampling {
  if (!storage) return { ...REVERSE_SAMPLING_DEFAULTS }
  let raw: string | null = null
  try { raw = storage.getItem(REVERSE_SAMPLING_KEY) } catch { return { ...REVERSE_SAMPLING_DEFAULTS } }
  if (!raw) return { ...REVERSE_SAMPLING_DEFAULTS }
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ...REVERSE_SAMPLING_DEFAULTS } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...REVERSE_SAMPLING_DEFAULTS }
  const row = parsed as Partial<ReverseSampling> & { sig?: unknown }
  const d = REVERSE_SAMPLING_DEFAULTS
  const r = REVERSE_SAMPLING_RANGES
  const next: ReverseSampling = {
    enabled: row.enabled === true,
    temperature: clamp(row.temperature, r.temperature.min, r.temperature.max, d.temperature),
    topP: clamp(row.topP, r.topP.min, r.topP.max, d.topP),
    presencePenalty: clamp(row.presencePenalty, r.presencePenalty.min, r.presencePenalty.max, d.presencePenalty),
    frequencyPenalty: clamp(row.frequencyPenalty, r.frequencyPenalty.min, r.frequencyPenalty.max, d.frequencyPenalty),
  }
  // 签名对不上 = 被手改过 → 整份丢弃，回默认（默认是「关」，安全侧）。
  if (typeof row.sig !== 'string' || row.sig !== samplingSignature(next)) {
    return { ...REVERSE_SAMPLING_DEFAULTS }
  }
  return next
}

export function writeReverseSampling(storage: Storage | undefined, value: ReverseSampling): void {
  if (!storage) return
  const clean: ReverseSampling = {
    enabled: value.enabled === true,
    temperature: clamp(value.temperature, 0, 2, REVERSE_SAMPLING_DEFAULTS.temperature),
    topP: clamp(value.topP, 0.05, 1, REVERSE_SAMPLING_DEFAULTS.topP),
    presencePenalty: clamp(value.presencePenalty, -2, 2, REVERSE_SAMPLING_DEFAULTS.presencePenalty),
    frequencyPenalty: clamp(value.frequencyPenalty, -2, 2, REVERSE_SAMPLING_DEFAULTS.frequencyPenalty),
  }
  const payload = { ...clean, sig: samplingSignature(clean) }
  try { storage.setItem(REVERSE_SAMPLING_KEY, JSON.stringify(payload)) } catch { /* 隐私模式：忽略 */ }
}

/**
 * 契约片段设置签名。
 *
 * 与采样同一套 FNV-1a：目的不是密码学防护，而是让手改的配置判无效。
 * 为什么片段也要签：这三个开关直接决定注入给模型的提示词内容，
 * 手改成「全开」会让契约长度翻倍、片段互相稀释，比不开更糟。
 */
function experimentsSignature(value: ReverseExperiments): string {
  const seed = `coomi-reverse-experiments:${value.strictMode}:${value.thinkingGuide}:${value.thinkingFree}:${value.routeGuide}:v2`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

/**
 * 读片段设置。
 *
 * 迁移：早期版本把 strictMode 塞在 ReverseSampling 里。这里在「新键不存在」时
 * 回头读旧键的 strictMode，避免升级后用户的严格模式开关悄悄丢掉。
 * 迁移只在读路径做一次，写路径永远只写新键。
 */
export function readReverseExperiments(storage: Storage | undefined): ReverseExperiments {
  if (!storage) return { ...REVERSE_EXPERIMENTS_DEFAULTS }
  let raw: string | null = null
  try { raw = storage.getItem(REVERSE_EXPERIMENTS_KEY) } catch { return { ...REVERSE_EXPERIMENTS_DEFAULTS } }

  if (!raw) {
    // 老版本迁移：从 sampling 里捞 strictMode
    let legacy: boolean | undefined
    try {
      const oldRaw = storage.getItem(REVERSE_SAMPLING_KEY)
      if (oldRaw) {
        const parsed: unknown = JSON.parse(oldRaw)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          const row = parsed as { strictMode?: unknown }
          if (row.strictMode === true) legacy = true
        }
      }
    } catch { /* 旧数据坏了就当没有 */ }
    return { ...REVERSE_EXPERIMENTS_DEFAULTS, strictMode: legacy === true }
  }

  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return { ...REVERSE_EXPERIMENTS_DEFAULTS } }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ...REVERSE_EXPERIMENTS_DEFAULTS }
  }
  const row = parsed as Partial<ReverseExperiments> & { sig?: unknown }
  const next: ReverseExperiments = {
    strictMode: row.strictMode === true,
    thinkingGuide: row.thinkingGuide === true,
    thinkingFree: row.thinkingFree === true,
    routeGuide: row.routeGuide === true,
  }
  // 签名对不上 = 被手改过 → 整份丢弃，回默认（默认全关）。
  if (typeof row.sig !== 'string' || row.sig !== experimentsSignature(next)) {
    return { ...REVERSE_EXPERIMENTS_DEFAULTS }
  }
  return next
}

export function writeReverseExperiments(storage: Storage | undefined, value: ReverseExperiments): void {
  if (!storage) return
  const clean: ReverseExperiments = {
    strictMode: value.strictMode === true,
    thinkingGuide: value.thinkingGuide === true,
    thinkingFree: value.thinkingFree === true,
    routeGuide: value.routeGuide === true,
  }
  const payload = { ...clean, sig: experimentsSignature(clean) }
  try { storage.setItem(REVERSE_EXPERIMENTS_KEY, JSON.stringify(payload)) } catch { /* 忽略 */ }
}

/** 转成引擎侧的 segments 字段（协议里用 camelCase）。 */
export function experimentsToSegments(value: ReverseExperiments): {
  strict: boolean
  thinkingGuide: boolean
  thinkingFree: boolean
  routeGuide: boolean
} {
  return {
    strict: value.strictMode === true,
    thinkingGuide: value.thinkingGuide === true,
    thinkingFree: value.thinkingFree === true,
    routeGuide: value.routeGuide === true,
  }
}

/** 已开启的片段数，给入口行显示「N 项已开启」。 */
export function countEnabledExperiments(value: ReverseExperiments): number {
  return [value.strictMode, value.thinkingGuide, value.thinkingFree, value.routeGuide].filter(Boolean).length
}

export interface ReverseConsentRecord {
  version: number
  /** 同意时的 unix 秒。仅用于展示与审计，不参与判定。 */
  at: number
  /** 记录指纹：防止手改 localStorage 里的 version 字段绕过。 */
  sig: string
}

/**
 * 同意记录指纹。
 *
 * 这不是密码学意义上的防伪 —— 源码可见，任何人都能算出同样的值。
 * 它的作用是**挡住「手改 localStorage 把 version 拨高一次就永久绕过」**
 * 这类低成本绕过：改坏 version 但没同步改 sig，记录直接判无效，重新征询。
 * 真正的门在引擎侧（见 Rust 的 reverse.rs），前端这层只是体验护栏。
 */
export function consentSignature(version: number, at: number): string {
  // FNV-1a 32 位：纯整数运算，无依赖，够用。
  const seed = `coomi-reverse-consent:${version}:${at}:v1`
  let hash = 0x811c9dc5
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

export function hasValidConsent(storage: Storage | undefined): boolean {
  if (!storage) return false
  let raw: string | null = null
  try { raw = storage.getItem(REVERSE_CONSENT_KEY) } catch { return false }
  if (!raw) return false
  let parsed: unknown
  try { parsed = JSON.parse(raw) } catch { return false }
  // `JSON.parse('null')` 是合法调用但返回 null；`'[]'` 返回数组。
  // 不显式排除的话，下面读 `.version` 会抛 —— 而这行代码在 store 初始化路径上，
  // 一条脏 localStorage 就能让整个应用白屏。必须先判是对象。
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return false
  const record = parsed as Partial<ReverseConsentRecord>
  if (typeof record.version !== 'number' || typeof record.at !== 'number' || typeof record.sig !== 'string') return false
  // 版本必须**恰好等于**当前版本：高版本也拒绝，防「手动拨高」。
  if (record.version !== REVERSE_CONSENT_VERSION) return false
  if (record.sig !== consentSignature(record.version, record.at)) return false
  return true
}

export function writeConsent(storage: Storage | undefined, now = Math.floor(Date.now() / 1000)): ReverseConsentRecord | null {
  if (!storage) return null
  const record: ReverseConsentRecord = {
    version: REVERSE_CONSENT_VERSION,
    at: now,
    sig: consentSignature(REVERSE_CONSENT_VERSION, now),
  }
  try { storage.setItem(REVERSE_CONSENT_KEY, JSON.stringify(record)) } catch { return null }
  return record
}

export function readConsent(storage: Storage | undefined): ReverseConsentRecord | null {
  if (!storage || !hasValidConsent(storage)) return null
  try {
    const raw = storage.getItem(REVERSE_CONSENT_KEY)
    return raw ? (JSON.parse(raw) as ReverseConsentRecord) : null
  } catch { return null }
}

// ── 生效状态 ───────────────────────────────────────────────────────────────
/**
 * pill 的五种视觉态。
 *
 * - `off`      关着
 * - `on`       开着，且引擎已按这个状态跑过至少一次（committed 一致）
 * - `pending`  目标态与已生效态不一致，等轮次结束才切换
 * - `arming`   首次同意流程进行中（点了但还没确认免责）
 * - `blocked`  开着，但当前权限或模型不满足必要条件
 */
export type ReversePillState = 'off' | 'on' | 'pending' | 'arming' | 'blocked'

export interface ReversePillInput {
  target: boolean
  committed: boolean
  /** 免责声明是否已同意。 */
  consented: boolean
  /**
   * 逆向当前能否真正执行。
   *
   * 直接取引擎上报的健康度（`health !== 'restricted'`），不要在前端重判权限：
   * 权限 → AccessMode 的映射在引擎里还叠了 TrustTier，前端算一遍必然算错。
   */
  permitted: boolean
  /** 当前口味，只用于 title 文案。 */
  flavor?: ReverseFlavor
}

export function reversePillState(input: ReversePillInput): ReversePillState {
  if (!input.consented) return input.target ? 'arming' : 'off'
  if (!input.target) return input.committed ? 'pending' : 'off'
  // 目标是开：还没提交（生成中翻的）= pending
  if (!input.committed) return 'pending'
  return input.permitted ? 'on' : 'blocked'
}

/** pill 上显示的短文案。pending 必须说出口，不能靠用户猜。 */
export function reversePillLabel(input: ReversePillInput): string {
  const state = reversePillState(input)
  switch (state) {
    case 'on': return '逆向'
    case 'pending': return input.target ? '逆向·待生效' : '关闭·待生效'
    case 'blocked': return '逆向·受限'
    case 'arming': return '逆向·未确认'
    default: return '逆向'
  }
}

export function reversePillTitle(input: ReversePillInput): string {
  const state = reversePillState(input)
  switch (state) {
    case 'on':
      return `逆向模式已开启（${flavorLabel(input.flavor ?? 'generic')}）· 长按切换厂商口味`
    case 'pending':
      return input.target
        ? '本轮生成结束后开启逆向模式 · 长按切换厂商口味'
        : '本轮生成结束后关闭逆向模式 · 长按切换厂商口味'
    case 'blocked':
      return '逆向模式已开启，但当前权限模式下工具会被拦截：把权限设为「自动」或「放行」'
    case 'arming':
      return '逆向模式需要先阅读并同意风险提示'
    default:
      return '逆向模式 · 单击开关 · 长按选择厂商口味'
  }
}

function readRawFlavor(): string | null {
  try { return localStorage.getItem(REVERSE_FLAVOR_KEY) } catch { return null }
}


/**
 * 逆向模式的三个必要条件（满足也不代表模型一定会配合）。
 *
 * 配置文件里没有任何字段能表达「这个模型容不容易被说服」——
 * ModelCapabilities 全是功能性能力（窗口、视觉、工具、并行调用）。
 * 所以这里只判「能不能跑起来」，服从度靠实测。
 */
export interface ReversePreconditions {
  /** 至少配了一个模型。 */
  hasModel: boolean
  /** 权限不是只读：ReadOnly 下非只读命令会 Decision::Deny。 */
  writableAccess: boolean
  /** 当前模型是否声明支持原生工具（逆向要跑 xxd / strings / readelf）。 */
  nativeTools: boolean
}

export function preconditionsMet(input: ReversePreconditions): boolean {
  return input.hasModel && input.writableAccess
}

/** 缺哪些条件，用于黄色提示条。空数组 = 都满足。 */
export function missingPreconditions(input: ReversePreconditions): string[] {
  const missing: string[] = []
  if (!input.hasModel) missing.push('尚未配置可用模型')
  if (!input.writableAccess) missing.push('权限为只读：逆向命令会被拦截，请改「自动」或「放行」')
  if (!input.nativeTools) missing.push('当前模型未声明原生工具调用：读二进制可能失败，建议改走 local_shell')
  return missing
}
