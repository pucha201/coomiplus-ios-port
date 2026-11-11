/**
 * 帧率读数（只在 `?perf=1` / `#...?perf=1` 时出现）。
 *
 * 真机上调流畅度靠猜没用：这里用 rAF 间隔算 FPS 与 p95 帧耗时，
 * 键盘弹起/收起、列表滚动时能直接看到有没有掉到 60 以下。
 * 生产包不带任何常态开销（不满足条件时一行都不会执行）。
 */
let installed = false

function enabled(): boolean {
  try {
    const search = new URLSearchParams(location.search)
    if (search.get('perf') === '1') return true
    const index = location.hash.indexOf('?')
    if (index >= 0) return new URLSearchParams(location.hash.slice(index + 1)).get('perf') === '1'
  } catch { /* ignore */ }
  return false
}

export function installPerfHud(): void {
  if (installed || typeof window === 'undefined' || !enabled()) return
  installed = true
  const el = document.createElement('div')
  el.id = 'perf-hud'
  el.style.cssText = [
    'position:fixed;top:calc(env(safe-area-inset-top,0px) + 6px);left:6px;z-index:2147483647',
    'padding:4px 8px;border-radius:8px;background:rgba(0,0,0,.72);color:#fff',
    'font:11px/1.45 ui-monospace,monospace;pointer-events:none;white-space:pre',
  ].join(';')
  document.body.appendChild(el)

  const frames: number[] = []
  let last = performance.now()
  let lastPaint = last
  let fps = 0
  const loop = (now: number) => {
    const delta = now - last
    last = now
    if (delta > 0 && delta < 500) frames.push(delta)
    if (frames.length > 120) frames.shift()
    if (now - lastPaint > 250) {
      lastPaint = now
      const sorted = [...frames].sort((a, b) => a - b)
      const p95 = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0
      fps = frames.length ? Math.round(1000 / (frames.reduce((a, b) => a + b, 0) / frames.length)) : 0
      const inset = getComputedStyle(document.documentElement).getPropertyValue('--kb-inset').trim() || '0px'
      const mode = document.documentElement.dataset.ime ?? 'resize'
      el.textContent = `${fps} fps  p95 ${p95.toFixed(1)}ms\nkb ${inset} · ime ${mode}`
    }
    requestAnimationFrame(loop)
  }
  requestAnimationFrame(loop)
}
