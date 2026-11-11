import { onBeforeUnmount } from 'vue'

/**
 * 侧边栏「盖子滑开」（照搬 DeepSeek 反编译参数 + 已验证补丁做法）。
 *
 * 为什么写 CSS 变量而不是内联 style：原样式 .shell.pushed 等规则带 !important，
 * 内联 transform 会被压掉。逐帧只写 --cp-f（进度）/ --cp-w（抽屉宽）到 :root，
 * 位移/缩放/圆角/阴影全部由样式表 calc() 消费。
 *
 * 动画：spring(dampingRatio 0.9, stiffness 1500) 的 Compose 解析解（非贝塞尔近似）。
 */
const DAMPING = 0.9
const STIFFNESS = 1500

/** Compose SpringSimulation 的位置解析解。 */
function springPos(from: number, to: number, z: number, stiffness: number) {
  const w0 = Math.sqrt(stiffness)
  const a = from - to
  const b = (z * w0 * a) / w0 / Math.sqrt(Math.max(1 - z * z, 1e-6))
  return (t: number): number => {
    if (z === 0) return to + a * Math.cos(w0 * t)
    if (z < 1) {
      const wd = w0 * Math.sqrt(1 - z * z)
      const e = Math.exp(-z * w0 * t)
      return to + e * (a * Math.cos(wd * t) + b * Math.sin(wd * t))
    }
    if (z === 1) return to + (a + w0 * a * t) * Math.exp(-w0 * t)
    const r = w0 * Math.sqrt(z * z - 1)
    const r1 = -z * w0 + r
    const r2 = -z * w0 - r
    const cb = (0 - a * r2) / (r1 - r2)
    return to + (a - cb) * Math.exp(r1 * t) + cb * Math.exp(r2 * t)
  }
}

export function drawerWidth(): number {
  return Math.min(326, Math.round((typeof window === 'undefined' ? 430 : window.innerWidth) * 0.8))
}

let f = 0
let raf = 0
let animating = false
let watchdog: ReturnType<typeof setTimeout> | null = null
let lastWritten = -1

/** 动画宿主：优先 .chat（就近失效，避免 :root 触发全树重算）。 */
function host(): HTMLElement | null {
  if (typeof document === 'undefined') return null
  return document.querySelector<HTMLElement>('.chat')
}

function writeF(value: number): void {
  f = value
  const el = host()
  if (!el) return
  if (Math.abs(value - lastWritten) < 1e-6) return
  lastWritten = value
  el.style.setProperty('--cp-f', value.toFixed(4))
  // 只在真正打开时启用 transform：关闭态必须 transform:none，否则 fixed 子元素会被捕获
  const active = value > 0.001
  if (active) {
    el.setAttribute('data-lid', '1')
    if (value > 0.05) el.querySelector('.lid')?.classList.add('open-shadow')
  } else {
    el.removeAttribute('data-lid')
    el.querySelector('.lid')?.classList.remove('open-shadow')
  }
}

function writeWidth(): void {
  const el = host()
  if (!el) return
  el.style.setProperty('--cp-w', drawerWidth() + 'px')
}

export function useDrawerFx() {
  writeWidth()

  function animateTo(target: number): void {
    const to = Math.max(0, Math.min(1, target))
    if (raf) cancelAnimationFrame(raf)
    const pos = springPos(f, to, DAMPING, STIFFNESS)
    const t0 = performance.now()
    animating = true
    if (watchdog) clearTimeout(watchdog)
    // 看门狗：后台节流导致 rAF 不跑时，直接落到目标，避免卡在半途
    watchdog = setTimeout(() => {
      if (!animating) return
      if (raf) cancelAnimationFrame(raf)
      animating = false
      writeF(to)
    }, 900)
    const step = (now: number) => {
      const t = (now - t0) / 1000
      const v = pos(t)
      if (Math.abs(v - to) < 0.0008) {
        writeF(to)
        animating = false
        if (watchdog) { clearTimeout(watchdog); watchdog = null }
        return
      }
      writeF(v)
      raf = requestAnimationFrame(step)
    }
    raf = requestAnimationFrame(step)
  }

  function setDirect(value: number): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    animating = false
    writeF(Math.max(0, Math.min(1, value)))
  }

  function syncWidth(): void { writeWidth() }

  onBeforeUnmount(() => { if (raf) cancelAnimationFrame(raf) })
  return { animateTo, setDirect, syncWidth, width: drawerWidth, current: () => f }
}

/** 非组件环境（如启动时）也能清理：把变量归零。 */
export function resetDrawerVars(): void {
  if (raf) cancelAnimationFrame(raf)
  raf = 0
  animating = false
  writeF(0)
}
