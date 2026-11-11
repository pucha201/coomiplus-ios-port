/**
 * 键盘占位高度（前端侧兜底）。
 *
 * 原生侧（CoomiActivity）已经按 IME insets 垫高 WebView；但个别 WebView/输入法组合下
 * 那条路不生效，输入栏仍被键盘盖住。这里用 visualViewport 的真实视口差值再补一道：
 * 布局视口没变、可视视口变矮的那一段就是键盘高度。
 * 原生垫高生效时两个视口高度相同，差值自然是 0 —— 两条路不会叠加。
 */

import { ref } from 'vue'

/** 兜底值的上限：视口高度的 45%。超过这个比例的“键盘”几乎一定是 WebView 报错了。 */
const MAX_INSET_RATIO = 0.45

/**
 * 键盘是否真的占着视口（inset > 0）。
 * 供 composer 的 dock 之类「键盘弹起就收起」的布局联动使用：
 * 直接读 --kb-inset 拿不到响应式更新，这里给一个权威布尔。
 */
export const keyboardVisible = ref(false)

/**
 * 原生侧推送的 IME 垫高（CSS px）。
 * 安卓壳把键盘高度垫在 content view 上（WebView 因此变矮），visualViewport 差值
 * 恒为 0 —— 只靠差值会让 dock 永远不收起。原生每次 inset 变化都推一次这里。
 */
export const nativeImeInset = ref(0)

/**
 * 是否走「原生不缩 WebView、前端用 transform 跟随键盘」这条路径。
 * 只有新壳（提供 usesImeTransform()）才为 true；老壳保持原来的 resize 行为，
 * 否则两份偏移会叠加（原生垫高 + 前端再抬一次）。
 */
export const imeTransformActive = ref(false)

declare global {
  interface Window {
    __coomiImeInset?: (px: number) => void
  }
}

/** 当前键盘占用的高度（CSS px）。原生优先，其次 visualViewport 差值。 */
export function currentKeyboardInsetPx(): number {
  if (nativeImeInset.value > 0) return nativeImeInset.value
  if (typeof window === 'undefined') return 0
  const vv = window.visualViewport
  if (!vv) return 0
  return keyboardInsetPx(window.innerHeight, vv.height, measureSafeBottom())
}

/** 视口变矮的兜底判据（原生垫高时 visualViewport 差值是 0，但 innerHeight 会变）。 */
let baseViewportHeight = 0
function viewportKeyboardPx(): number {
  if (typeof window === 'undefined') return 0
  if (!baseViewportHeight || window.innerHeight >= baseViewportHeight) {
    baseViewportHeight = window.innerHeight
    return 0
  }
  return Math.max(0, baseViewportHeight - window.innerHeight)
}

function recomputeKeyboardVisible(): void {
  const visual = typeof window === 'undefined' || !window.visualViewport
    ? 0
    : keyboardInsetPx(window.innerHeight, window.visualViewport.height, measureSafeBottom())
  const focused = editableFocused()
  keyboardVisible.value = nativeImeInset.value > 0
    || (focused && (visual > 0 || viewportKeyboardPx() > 80))
}

/**
 * transform 模式下 --kb-inset 由原生推送的值直接决定（不缩 WebView 时，
 * visualViewport 差值不再可靠）。写变量时顺手挂一个短命的 will-change，
 * 动画结束后摘掉，避免常驻合成层。
 */
let imeAnimTimer: ReturnType<typeof setTimeout> | null = null
function writeTransformInset(px: number): void {
  if (!imeTransformActive.value) return
  const root = document.documentElement
  root.style.setProperty('--kb-inset', `${px}px`)
  root.dataset.imeAnim = '1'
  if (imeAnimTimer) clearTimeout(imeAnimTimer)
  imeAnimTimer = setTimeout(() => { delete root.dataset.imeAnim }, 320)
}

/** 原生壳启动时装一次：接收 __coomiImeInset(px) 推送，并主动取一次当前值。 */
export function installNativeImeBridge(): void {
  if (typeof window === 'undefined') return
  try {
    const bridge = (window as unknown as { CoomiAndroid?: { usesImeTransform?: () => boolean } }).CoomiAndroid
    imeTransformActive.value = bridge?.usesImeTransform?.() === true
  } catch { imeTransformActive.value = false }
  if (imeTransformActive.value) document.documentElement.dataset.ime = 'transform'
  window.__coomiImeInset = (px: number) => {
    const value = Number(px)
    nativeImeInset.value = Number.isFinite(value) ? Math.max(0, Math.round(value * 100) / 100) : 0
    writeTransformInset(nativeImeInset.value)
    recomputeKeyboardVisible()
  }
  try {
    const bridge = (window as unknown as { CoomiAndroid?: { getImeInsetCss?: () => number } }).CoomiAndroid
    const value = Number(bridge?.getImeInsetCss?.())
    if (Number.isFinite(value) && value > 0) {
      nativeImeInset.value = Math.round(value * 100) / 100
      writeTransformInset(nativeImeInset.value)
      recomputeKeyboardVisible()
    }
  } catch { /* 非原生壳忽略 */ }
}

export function keyboardInsetPx(innerHeight: number, viewportHeight: number, safeBottom: number): number {
  const raw = Math.max(0, Math.round(innerHeight - viewportHeight - Math.max(0, safeBottom)))
  const ceiling = Math.max(0, Math.round(innerHeight * MAX_INSET_RATIO))
  return Math.min(raw, ceiling)
}

function editableFocused(): boolean {
  const el = typeof document === 'undefined' ? null : (document.activeElement as HTMLElement | null)
  if (!el) return false
  return el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable
}

/** 把键盘占位写进 CSS 变量 --kb-inset（底部组件用 calc 加进自己的 padding）。 */
export function applyKeyboardInset(): void {
  const vv = window.visualViewport
  if (!vv) return
  const safeBottom = measureSafeBottom()
  // 没有输入焦点就不该垫高：WebView 在旋转/分屏/系统栏变化后偶尔会长时间报一个
  // 偏小的 vv.height，不设这道门就会让输入栏永久停在屏幕中间。
  const inset = editableFocused() ? keyboardInsetPx(window.innerHeight, vv.height, safeBottom) : 0
  // transform 模式下 --kb-inset 归原生推送管：这里再写一次会把原生值覆盖成 0。
  if (!imeTransformActive.value) {
    document.documentElement.style.setProperty('--kb-inset', `${inset}px`)
  }
  recomputeKeyboardVisible()
  // iOS 的 visualViewport 在键盘弹起时不一定缩 layout viewport：offsetTop 表示
  // 可视区域相对布局视口的上移量。需要精确贴底的浮层可以用它做二次校正。
  const offset = Math.max(0, Math.round(vv.offsetTop))
  document.documentElement.style.setProperty('--kb-offset', `${offset}px`)
  paintDebug(inset, safeBottom)
}

/**
 * --safe-bottom 的值是 env(...)，自定义属性取回来是原始 token，parseFloat 永远 NaN，
 * 于是 iOS 上会连安全区一起算进键盘高度、多垫一条。这里用探针量成像素。
 */
let safeBottomCache: { value: number; at: number } | null = null
function measureSafeBottom(): number {
  const now = Date.now()
  if (safeBottomCache && now - safeBottomCache.at < 2000) return safeBottomCache.value
  let value = 0
  try {
    const probe = document.createElement('div')
    probe.style.cssText = 'position:fixed;left:-9999px;bottom:0;width:1px;height:env(safe-area-inset-bottom,0px);pointer-events:none;visibility:hidden'
    document.body.appendChild(probe)
    value = Math.max(0, Math.round(probe.getBoundingClientRect().height))
    probe.remove()
  } catch { value = 0 }
  safeBottomCache = { value, at: now }
  return value
}

/**
 * 真机排查用：URL 带 ?debug=kb（search 或 hash 里都行）时，右上角常驻一行读数。
 * 键盘相关的问题靠猜没用，必须看到 innerHeight / vv.height / safeBottom / 最终 inset。
 */
let debugEl: HTMLElement | null = null
function debugEnabled(): boolean {
  try {
    const search = new URLSearchParams(location.search)
    if (search.has('debug')) return search.get('debug') === 'kb'
    const qi = location.hash.indexOf('?')
    if (qi >= 0) return new URLSearchParams(location.hash.slice(qi + 1)).get('debug') === 'kb'
  } catch { /* ignore */ }
  return false
}
function paintDebug(inset: number, safeBottom: number): void {
  if (!debugEnabled()) return
  const vv = window.visualViewport
  if (!debugEl || !debugEl.isConnected) {
    debugEl = document.createElement('div')
    debugEl.id = 'kb-debug'
    debugEl.style.cssText = 'position:fixed;top:8px;right:8px;z-index:2147483647;padding:4px 8px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff;font:11px/1.4 monospace;pointer-events:none;white-space:pre'
    document.body.appendChild(debugEl)
  }
  debugEl.textContent = [
    `inner=${window.innerHeight} vv=${vv?.height ?? 0} off=${Math.round(vv?.offsetTop ?? 0)}`,
    `safe=${safeBottom} inset=${inset} focus=${editableFocused() ? 'y' : 'n'}`,
  ].join('\n')
}

let wired = false

/** App 启动时挂一次：键盘弹/收、输入法换高度、横竖屏都会触发。 */
export function installKeyboardInsetWatcher(): void {
  if (wired || typeof window === 'undefined') return
  wired = true
  installNativeImeBridge()
  const vv = window.visualViewport
  if (!vv) return
  vv.addEventListener('resize', applyKeyboardInset)
  vv.addEventListener('scroll', applyKeyboardInset)
  // 失焦 / 切后台回来：重新按当前状态算一次，把可能残留的旧值清掉。
  document.addEventListener('focusin', () => applyKeyboardInset())
  document.addEventListener('focusout', () => window.setTimeout(applyKeyboardInset, 60))
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') applyKeyboardInset()
  })
  applyKeyboardInset()
}
