/**
 * 加号面板 ↔ 键盘的底部交接（纯函数，便于单测）。
 *
 * 模型：输入栏的屏幕位置 = 视口底 - reserve - 输入栏高度，
 * 其中 reserve = 原生键盘垫高(nativeReserve) + 面板在流内的高度(panelH)。
 *
 * 交接分两段：
 *  1. hold：reserve 恒定 = from（通常就是键盘高度）。键盘退多少，
 *     panelH 就长多少 —— 输入栏完全不动，面板像“接住”了键盘让出的空间。
 *  2. adjust：reserve 从 from 过渡到 to（面板最终高度）。两个高度通常只差
 *     几十像素，这一步只是一次很轻的落位。
 *
 * 纯 CSS 过渡 + 系统 IME 动画各跑各的，就是「面板与键盘同屏 / 输入栏猛跳」的根源；
 * 这里把 sum 收敛到一条曲线上，系统动画多快都不影响输入栏的位置。
 */

export interface HandoffSample {
  /** 起始 reserve（CSS px）：展开=键盘高度，收起=面板高度。 */
  from: number
  /** 目标 reserve（CSS px）：展开=面板高度，收起=键盘高度或 0。 */
  to: number
  /** 当前原生键盘垫高（CSS px）。 */
  nativeReserve: number
  /** 从交接开始起的毫秒数。 */
  elapsed: number
  /** hold 段时长；0 表示跳过（键盘本来就没开）。 */
  holdMs: number
  /** adjust 段时长（必须 > 0）。 */
  adjustMs: number
  /** 键盘已经就位（退到 0 / 升到目标），可以提前结束 hold。 */
  holdDone?: boolean
  /** hold 实际结束的时刻（毫秒，绝对 elapsed）。不传则按 holdMs 结束。
   *  键盘比预期快时，adjust 必须从“真正结束的那一刻”起算，否则会凭空多等一段。 */
  holdElapsed?: number
}

export interface HandoffFrame {
  phase: 'hold' | 'adjust' | 'done'
  /** nativeReserve + panelH，输入栏位置由它决定。 */
  reserve: number
  /** 面板在流内应占的高度（不会为负）。 */
  panelH: number
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value
}

function easeOutCubic(t: number): number {
  const inverted = 1 - t
  return 1 - inverted * inverted * inverted
}

export function handoffFrame(sample: HandoffSample): HandoffFrame {
  const from = Math.max(0, sample.from)
  const to = Math.max(0, sample.to)
  const native = Math.max(0, sample.nativeReserve)
  const holdMs = Math.max(0, sample.holdMs)
  const adjustMs = Math.max(1, sample.adjustMs)
  const elapsed = Math.max(0, sample.elapsed)

  const holdEnd = Math.max(0, Math.min(holdMs, sample.holdElapsed ?? holdMs))
  const holding = holdMs > 0 && elapsed < holdEnd && !sample.holdDone
  if (holding) {
    return { phase: 'hold', reserve: from, panelH: Math.max(0, from - native) }
  }

  const adjustStart = sample.holdDone ? holdEnd : holdMs
  const progress = clamp01((elapsed - adjustStart) / adjustMs)
  const reserve = from + (to - from) * easeOutCubic(progress)
  return {
    phase: progress >= 1 ? 'done' : 'adjust',
    reserve,
    panelH: Math.max(0, reserve - native),
  }
}
