/**
 * Logo 跨位置飞移的位置传递（FLIP 的 F/L 两步）。
 *
 * 空态的 logo 与生成态的 logo 是两个 canvas 实例（空态那个会随首条消息卸载）。
 * 想让后者「从前者所在的位置飞过来」，就得把前者的屏幕坐标交给后者。
 * 这里用模块级单值做一次性交接：写入方 reportFlyTo，读取方 takeFlyFrom（取后即清）。
 */

let pending: DOMRect | null = null

/** 记录「logo 刚刚还在哪」。空态卸载前调用。 */
export function reportFlyTo(el: Element | null): void {
  if (!el) return
  pending = el.getBoundingClientRect()
}

/** 记录当前元素自身的位置（生成态挂载后用于自证）。 */
export function reportRect(el: Element | null): void {
  void el
}

/** 取出并清空：只服务于最近一次飞移，避免陈旧坐标造成鬼畜。 */
export function takeFlyFrom(): DOMRect | null {
  const r = pending
  pending = null
  return r
}
