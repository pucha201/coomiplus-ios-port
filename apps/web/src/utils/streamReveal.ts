/**
 * 流式正文的「不闪现」口径 + 逐字揭示器。
 *
 * 两份电脑端源头文件给了同一条结论（apps/desktop-ui-react/src/components/chat/streamText.ts、
 * apps/desktop-ui-react/src/lib/streamCommit.ts）：
 *   · 流式期间正文只画纯文本 —— **不解析 markdown、不高亮、不做正则扫描/分块/哈希**，
 *     每帧成本 O(1)，与「消息多长、来了多少 chunk」无关；
 *   · 流结束（turn_end）才整段解析一次。
 *
 * 手机端（Web）在这里多一件事：**逐字揭示**。因为正文是成批到达的 ——
 * 引擎的 text_chunk 没有节流，store 的平滑泵每拍也只放几字，turn_end 更会把积压
 * 一次放完。把 content 直接塞进 DOM 就是「正文整段闪现」，所以渲染层按
 * 「内容长度差」用 rAF 推进已揭示长度：差得少就逐字，积压越多越快，
 * 但**永远有速度上限**（一帧只出几字）—— 任何输入方式都不整段蹦出来。
 *
 * 兜底（验收标准）：rAF 异常 / 页面隐藏 / 超时未推进 → 立即全量显示，
 * 绝不出现「没有字」。
 *
 * 这个文件**不碰 DOM、不 import vue**，逻辑全是纯函数：node --test 直接断言。
 */

/* ── 口径一：流式中一律纯文本 ─────────────────────────────────────── */

/** 纯文本硬上限（字符）：超过它就永远不再解析 markdown（与桌面端同一口径）。 */
export const PLAIN_STREAM_MAX_CHARS = 100_000

/**
 * 「这一拍要不要走纯文本」：只由流式状态决定。
 *
 * 以前还按长度兜底（>100000 字符就永远纯文本），结果是：一段带 `![](...)` 的
 * 长回答落定后也只会显示原始 Markdown，图片永远出不来。超长正文的解析成本
 * 交给块级缓存（markdown.ts 的 CACHE_MAX），不再牺牲渲染。
 */
export function shouldUsePlainText(_text: string, streaming: boolean, _max: number = PLAIN_STREAM_MAX_CHARS): boolean {
  return streaming
}

/* ── 口径二：WorkBuddy 式「逐字符渐出」精确公式（逆向所得）──────────── */
/**
 * 渐出窗口宽度（字符）：逆向常量 -8.0(尾随) + 2.0(前导) → 带宽 ≈ 10。
 * 只有落在 [head-8, head+2] 的字符才需要计算 alpha，其余走共享常量。
 */
export const REVEAL_WINDOW = 10
/** 透明度下界 0.125（1/8）：尾部字符永不透明，避免流式边缘突兀。 */
export const REVEAL_ALPHA_MIN = 0.125
/** 前导 2.0 / 尾随 8.0（与逆向的汇编常量一致）。 */
export const REVEAL_LEAD = 2
export const REVEAL_TAIL = 8

/** 单字符透明度：alpha = clamp((head - i) / window, 0.125, 1.0)。纯函数，可单测。 */
export function revealAlpha(head: number, index: number, window: number = REVEAL_WINDOW): number {
  const raw = (head - index) / window
  return Math.max(REVEAL_ALPHA_MIN, Math.min(raw, 1))
}

/** 三段门控：已定型段 / 渐出窗口 / 尚未揭示。 */
export function revealZones(head: number, total: number): { settledEnd: number; fadeEnd: number } {
  const h = Number.isFinite(head) ? head : 0
  const settledEnd = Math.max(0, Math.min(total, Math.floor(h - REVEAL_TAIL)))
  const fadeEnd = Math.max(settledEnd, Math.min(total, Math.floor(h + REVEAL_LEAD) + 1))
  return { settledEnd, fadeEnd }
}

/* ── 口径二补：逐字揭示的速度模型 ───────────────────────────────────── */

/** 基础速度（字/秒）：几乎没有积压时的阅读节奏。 */
export const REVEAL_BASE_CPS = 45
/** 每积压 1 字额外提速（字/秒）：积压越多越快，永远追得上成批到达。 */
export const REVEAL_BACKLOG_ACCEL = 1.5
/** 速度硬上限（字/秒）：再大的积压也一帧只出几字 —— 这就是「不整段闪现」那条线。 */
export const REVEAL_MAX_CPS = 780
/** 兜底：超过这么久没有推进（rAF 被节流 / 抛异常）就全量落定。 */
export const REVEAL_STALL_MS = 1000
/** 看门狗轮询间隔（ms）：管「rAF 不跑」与「页面隐藏」两件事。 */
export const REVEAL_TICK_MS = 200

/**
 * 挂载时的起始揭示位置。
 * 只有「新消息且正文还是空的」才从 0 开始逐字；重挂时正文已经存在，
 * 就必须从已有进度（或全文）接着显示 —— 否则就是用户看到的“快结束时突然重播”。
 */
export function initialRevealShown(stored: number | undefined, contentLength: number): number {
  if (stored !== undefined && stored > 0) return stored
  return Math.max(0, contentLength)
}

/** 当前积压下的揭示速度（字/秒）。纯函数，测试直接断言。 */
export function revealSpeed(backlog: number): number {
  if (!Number.isFinite(backlog) || backlog <= 0) return 0
  const raw = REVEAL_BASE_CPS + backlog * REVEAL_BACKLOG_ACCEL
  return Math.min(REVEAL_MAX_CPS, Math.max(REVEAL_BASE_CPS, raw))
}

/**
 * 推进一拍：按速度把 owed（字）攒够再放，零头留给下一拍。
 * 低速时不会「好几分之一字」，高速时也不会一帧蹦出几百字（上限在 revealSpeed 里）。
 * @param shown  已揭示长度
 * @param owed   上一步攒下没放完的字
 * @param target 正文当前长度
 * @param dtMs  距上一拍过了多少毫秒
 */
export function advanceReveal(
  shown: number,
  owed: number,
  target: number,
  dtMs: number,
): { shown: number; owed: number } {
  const goal = Math.max(0, Math.floor(Number.isFinite(target) ? target : 0))
  if (goal <= shown) return { shown: goal, owed: 0 }
  if (!Number.isFinite(dtMs) || dtMs <= 0) return { shown, owed }
  const backlog = goal - shown
  const pool = (Number.isFinite(owed) && owed > 0 ? owed : 0) + (revealSpeed(backlog) * dtMs) / 1000
  let step = Math.floor(pool)
  if (step > backlog) step = backlog
  return { shown: shown + step, owed: Math.max(0, pool - step) }
}

/* ── 逐字进度按消息 id 记住（模块级表） ───────────────────────────────
 * vue-virtual-scroller 滚出视口会销毁行组件，组件本地 ref 会连带丢失；
 * 按 id 记住「揭示到哪儿了、这条是不是活的」，重新挂载时接着走，不从头重播。
 * 表只留「正在生成 / 刚落定」的那几条：落定即删，长度有界（超出丢最旧的）。 */

export interface RevealRecord {
  /** 已揭示长度。 */
  shown: number
  /** 还没放完的字（零头）。 */
  owed: number
  /** 这条消息确实在生成（引擎正在往它身上追加）。 */
  armed: boolean
}

const RECORD_MAX = 64
const records = new Map<string, RevealRecord>()

export function revealRecordFor(id: string): RevealRecord {
  const hit = records.get(id)
  if (hit) return hit
  const created: RevealRecord = { shown: 0, owed: 0, armed: false }
  records.set(id, created)
  while (records.size > RECORD_MAX) {
    const oldest = records.keys().next().value
    if (oldest === undefined) break
    records.delete(oldest)
  }
  return created
}

/** 只读 peek：不创建（渲染层给用户消息/历史消息也要问一句，不能白留一条记录）。 */
export function peekRevealRecord(id: string): RevealRecord | undefined {
  return records.get(id)
}

export function forgetRevealRecord(id: string): void {
  records.delete(id)
}

/** 测试用：表里还留几条。 */
export function revealRecordCount(): number {
  return records.size
}

/* ── rAF 驱动 ─────────────────────────────────────────────────────── */

export interface RevealDriverOptions {
  /** 正文当前长度（揭示目标）。 */
  target: () => number
  /** 推进一拍；返回 true = 已落定（shown >= target）。 */
  step: (dtMs: number) => boolean
  /** 落定：全量显示 + 清理。 */
  settle: () => void
}

export interface RevealDriver {
  /** 停掉驱动但**不**落定（卸载 / 切会话时用，进度留在记录里）。 */
  stop: () => void
  /** 立即全量落定。 */
  settle: () => void
}

/**
 * 逐字揭示的唯一驱动：一条 rAF 循环 + 一个看门狗定时器。
 * 三条兜底都落在这里，调用方不需要各自判断：
 *   · rAF 不存在 / 抛异常 → 直接 settle；
 *   · document.visibilityState === 'hidden'（用户没在看）→ 直接 settle；
 *   · 超过 REVEAL_STALL_MS 没有推进（rAF 被浏览器节流吞掉）→ 直接 settle。
 */
export function startRevealDriver(options: RevealDriverOptions): RevealDriver {
  const { step, settle } = options
  let frame = 0
  let watchdog: ReturnType<typeof setInterval> | null = null
  let stopped = false
  let lastTs = 0
  let lastTickAt = 0

  const clearFrame = () => {
    if (!frame) return
    try { cancelAnimationFrame(frame) } catch { /* 环境没有就算了 */ }
    frame = 0
  }
  const clearWatchdog = () => {
    if (watchdog === null) return
    try { clearInterval(watchdog) } catch { /* 同上 */ }
    watchdog = null
  }
  const stop = () => { stopped = true; clearFrame(); clearWatchdog() }
  const settleNow = () => {
    if (stopped) return
    stop()
    settle()
  }
  const clock = () =>
    typeof performance !== 'undefined' && typeof performance.now === 'function' ? performance.now() : Date.now()
  const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

  const onFrame = (ts: number) => {
    if (stopped) return
    frame = 0
    if (hidden()) { settleNow(); return }
    const dt = lastTs > 0 ? Math.max(0, ts - lastTs) : 0
    lastTs = ts
    lastTickAt = clock()
    let done = false
    try { done = step(dt) } catch { done = true } // 逻辑异常 → 全量落定，绝不出「没有字」
    if (done) { settleNow(); return }
    request()
  }

  const request = () => {
    if (stopped) return
    if (typeof requestAnimationFrame !== 'function') { settleNow(); return }
    try { frame = requestAnimationFrame(onFrame) } catch { settleNow() }
  }

  lastTickAt = clock()
  request()
  watchdog = setInterval(() => {
    if (stopped) return
    if (hidden()) { settleNow(); return }
    if (clock() - lastTickAt > REVEAL_STALL_MS) settleNow()
  }, REVEAL_TICK_MS)

  return { stop, settle: settleNow }
}
