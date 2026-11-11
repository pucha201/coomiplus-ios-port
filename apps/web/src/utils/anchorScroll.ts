import { detachAutoFollow } from '@/composables/useAutoScroll'

/**
 * 折叠/展开期间的滚动策略 —— 把「不跳」交给布局本身，而不是事后补 scrollTop。
 *
 * 旧实现用 anchorToggle 在 360ms 内每帧读折叠头的 rect 并补 scrollTop，
 * 去追一场 0fr→1fr 的高度动画。问题是同一时间至少还有两条通道在写同一个
 * scrollTop：ChatView 的贴底 rAF、vue-virtual-scroller 的 itemsWithSize 补偿。
 * 三套权威方向各不相同，观感就是「先闪一下、再错位」。
 *
 * 现在的做法：
 * - 折叠高度瞬时生效（三个折叠组件都不再动画 height），布局一次就位；
 * - 展开/收起前调用 detachAutoFollow()，自动贴底当场让位，之后不再写 scrollTop；
 * - 视口里「切换块上方」的那部分位移由 vue-virtual-scroller 自己补偿
 *   （itemsWithSize watcher 会对 scrollTop 之上的条目做 scrollTop += Δ），
 *   切换块本身在视口里时它不动，用户点的那个头自然留在原地。
 *
 * 结论：这里不需要再算 rect / 补 delta —— 多算一次反而会和插件的补偿叠加成反向跳动。
 */
export function keepAnchor(mutate: () => void): void {
  detachAutoFollow()
  mutate()
}
