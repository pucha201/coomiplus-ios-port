/**
 * 长按 pill 的手势判定 —— 纯函数，可测。
 *
 * 为什么要把这段逻辑抽出来：它是整个功能里最容易写错、又最难靠手点验出来的
 * 地方。真实世界里浏览器的事件顺序是
 *
 *   pointerdown → (450ms) → pointerup → click
 *
 * 而 click **总会**在 pointerup 之后补发。只要漏挡一次，用户就会看到
 * 「长按选完口味，开关被顺手翻了一次」或「短按点了没反应（翻两次抵消）」。
 * 这两种错法在真机上都不报错、只是行为诡异，所以必须在这里穷举钉死。
 */

/** 一次指针交互的原始事实。 */
export interface HoldFacts {
  /** 长按计时器是否走到了点。 */
  heldToCompletion: boolean
  /** 手指位移是否超过阈值（超了就说明是滑动，不是按下）。 */
  movedBeyondSlop: boolean
  /** 是否在计时器到点前就抬起了手指。 */
  releasedBeforeTimer: boolean
  /** 是否为鼠标主键 / 触摸。非主键不该触发任何动作。 */
  primaryButton: boolean
}

export type HoldOutcome =
  /** 开 sheet（长按成立）。 */
  | 'open-sheet'
  /** 当作短按：切开关。 */
  | 'toggle'
  /** 什么都不做，并让随后的 click 也被吞掉。 */
  | 'swallow'
  /** 什么都不做，但**不**影响随后的 click（根本没开始过手势）。 */
  | 'ignore'

/**
 * 判定一次「按下 → 抬起」的结果。
 *
 * 顺序很重要：先排除非主键，再判长按，最后才轮到短按。反过来写会让
 * 右键拖拽被当成短按。
 */
export function decideHold(facts: HoldFacts): HoldOutcome {
  if (!facts.primaryButton) return 'ignore'
  // 划走了：不是按下，也不是长按。后续 click 也可能不该被吞，
  // 但既然用户是从这个按钮上滑出去的，吞掉更安全（避免误触开关）。
  if (facts.movedBeyondSlop) return 'swallow'
  // 长按成立 —— 此时无论有没有到点抬起，都算长按。
  if (facts.heldToCompletion) return 'open-sheet'
  // 到点前抬起 = 短按。
  if (facts.releasedBeforeTimer) return 'toggle'
  // 没开始过（比如 pointercancel 之后补的 up）。
  return 'ignore'
}

/**
 * click 处理器该怎么反应。
 *
 * @param suppress 上一步 decideHold 是否留下了「吞掉下一个 click」的标记
 * @param pointerHandled 这一次点击是否已经被 pointer 事件处理过
 */
export function decideClick(suppress: boolean, pointerHandled: boolean): 'swallow' | 'toggle' | 'ignore' {
  // 标记优先：长按与短按都要在 pointer 阶段自己消费掉 click，
  // 否则浏览器补发的那一次会把状态再翻一遍。
  if (suppress) return 'swallow'
  // pointer 事件完整走过 → click 是重复的，忽略。
  if (pointerHandled) return 'ignore'
  // 只来了 click（键盘回车 / 辅助技术）：当成短按。
  return 'toggle'
}

/** 判定指针是否已滑出容差。8px 与 FileManagerView / HistoryDial 的既有手势一致。 */
export function movedBeyondSlop(dx: number, dy: number, slop = 8): boolean {
  return Math.abs(dx) > slop || Math.abs(dy) > slop
}
