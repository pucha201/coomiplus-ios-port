import type { Router } from 'vue-router'
import { closeTopOverlay } from './overlayStack'

type BackFallback = 'dashboard' | string

// ── 自维护路由栈 ──
// hash 模式下 window.history.state?.back 不可靠（hash 变更不更新 history.state），
// 之前用它判断导致「返回手势跳过头/跳旧页」。改为自己记录导航栈。
const navStack: string[] = []
let installing = false

const nativeEntryRoot = { value: '' as string }

/** 对话页返回键的「二级确认」窗口：两次返回间隔小于它才算确认退出。 */
const EXIT_CONFIRM_MS = 2000
let exitArmedAt = 0
let exitHintTimer = 0

/**
 * 首次返回只提示、不退出。
 *
 * 旧行为是在对话页按返回直接 finishAffinity —— 用户从别的 App 或锁屏回来，
 * 习惯性划一下就把正在跑的会话连壳一起关掉。安卓的通用约定是
 * 「再按一次退出」，这里补上，提示条也由前端画（原生侧不需要新桥方法）。
 */
function showExitHint(): void {
  if (typeof document === 'undefined' || !document.body) return
  let el = document.getElementById('coomi-exit-hint')
  if (!el) {
    el = document.createElement('div')
    el.id = 'coomi-exit-hint'
    el.setAttribute('role', 'status')
    el.style.cssText = [
      'position:fixed', 'left:50%', 'bottom:calc(env(safe-area-inset-bottom,0px) + 56px)',
      'transform:translateX(-50%)', 'z-index:2147483000', 'padding:9px 16px',
      'border-radius:999px', 'background:rgba(22,22,26,.9)', 'color:#fff',
      'font-size:13px', 'line-height:1.25', 'pointer-events:none', 'white-space:nowrap',
      'box-shadow:0 8px 28px rgba(0,0,0,.32)', 'opacity:0',
      'transition:opacity 160ms ease',
    ].join(';')
    document.body.appendChild(el)
  }
  el.textContent = '再按一次返回退出'
  el.style.opacity = '1'
  window.clearTimeout(exitHintTimer)
  exitHintTimer = window.setTimeout(() => {
    if (el) el.style.opacity = '0'
  }, EXIT_CONFIRM_MS - 200)
}

/** 路由一变就复位：在别的页面按过一次返回，不该影响对话页的退出确认。 */
function resetExitArm(): void {
  exitArmedAt = 0
}

/**
 * 标记「本 WebView 是从原生页用路由拉起的」：
 * 系统返回回到这一层时不再跳任何网页路由，而是结束宿主回到那个原生页。
 * （否则从原生进来 → 子页 → 三金刚返回 会经栈根 '/' 掉回对话页。）
 */
export function setNativeEntryRoute(route: string): void {
  nativeEntryRoot.value = route
}

/**
 * 记录一次导航：push 入栈。
 *
 * 已出现过的路径要把它之前的记录截断（A → B → A 时栈变成 [A]），
 * 否则 back 会把栈里残留的 B 当成「上一页」，出现 A ↔ B 来回循环。
 */
function recordNavigation(path: string): void {
  if (suppressRecord) return
  const last = navStack[navStack.length - 1]
  if (last === path) return
  const seen = navStack.lastIndexOf(path)
  if (seen >= 0) {
    navStack.length = seen + 1
    return
  }
  navStack.push(path)
  if (navStack.length > 64) navStack.shift()
}

/** 当前栈里是否有「上一页」。 */
function hasRouterHistory(): boolean {
  return navStack.length > 1
}

/**
 * 返回：栈里有上一页则回上一页；无历史时默认回**对话**（`/`）。
 * 仅显式 fallback === 'dashboard' 时才回原生控制台（用户从控制台点「返回」时）。
 */
export function goBack(router: Router, fallback: BackFallback = '/'): void {
  if (hasRouterHistory()) {
    const current = router.currentRoute.value.path
    navStack.pop()
    let target = navStack[navStack.length - 1] || '/'
    // 栈里残留的「上一页」如果就是当前页，继续往前退一格，否则会原地打转。
    while (target === current && navStack.length > 1) {
      navStack.pop()
      target = navStack[navStack.length - 1] || '/'
    }
    if (target === current) { replaceWithoutRecord(router, fallback === 'dashboard' ? '/' : fallback); return }
    replaceWithoutRecord(router, target)
    return
  }
  if (fallback === 'dashboard') {
    if (window.CoomiAndroid?.openDashboard) {
      window.CoomiAndroid.openDashboard()
      return
    }
    replaceWithoutRecord(router, '/')
    return
  }
  replaceWithoutRecord(router, fallback)
}

/**
 * 回退用的 replace：期间不记录导航栈。
 *
 * 以前 afterEach 把 replace 也记进栈，于是「返回」把当前页又写回去，
 * 下一次返回又弹回同一个子页 —— 设置页与子页之间来回循环。
 */
let suppressRecord = false
function replaceWithoutRecord(router: Router, target: string): void {
  suppressRecord = true
  void router.replace(target).finally(() => { suppressRecord = false })
}

/**
 * 页面「上一级」映射：系统返回（右滑手势/返回键）且没有历史栈时用它。
 * 以前统一兜底 '/'（对话页）—— 从设置/控制台点进子页，一返回就掉回对话页。
 */
const PARENT_ROUTES: Array<[RegExp, string]> = [
  /* 设置族：二级页一律回设置首页（控制台已是同一个网页，不再回原生 Activity）。 */
  [/^\/settings(\/|$)/, '/'],
  [/^\/providers(\/|$)/, '/settings'],
  [/^\/memory(\/|$)/, '/settings'],
  [/^\/catalog(\/|$)/, '/settings'],
  [/^\/runtime(\/|$)/, '/settings'],
  [/^\/files(\/|$)/, '/settings'],
  [/^\/updates(\/|$)/, '/settings'],
  [/^\/usage(\/|$)/, '/settings'],
  [/^\/persona(\/|$)/, '/settings'],
  [/^\/appearance(\/|$)/, '/settings'],
  [/^\/devices(\/|$)/, '/settings'],
  [/^\/backup(\/|$)/, '/settings'],
  [/^\/about(\/|$)/, '/settings'],
  [/^\/hooks(\/|$)/, '/catalog'],
  [/^\/workflows(\/|$)/, '/catalog'],
  [/^\/maintenance(\/|$)/, '/settings'],
  [/^\/life(\/|$)/, '/'],
  [/^\/sessions(\/|$)/, '/settings'],
  [/^\/tasks(\/|$)/, '/settings'],
  [/^\/browser(\/|$)/, '/settings'],
  [/^\/custom-iteration(\/|$)/, '/settings'],
]

/** 取某条路由的父页（找不到就回对话页）。 */
export function parentRouteOf(route: string): string {
  for (const [pattern, parent] of PARENT_ROUTES) {
    if (pattern.test(route)) return parent
  }
  return '/'
}

export function installSystemBackHandler(router: Router): void {
  if (installing) return
  installing = true
  // 初始化栈 + 每次路由变化都记录（afterEach 覆盖 push/replace 所有导航）。
  recordNavigation(router.currentRoute.value.fullPath)
  router.afterEach((to) => { recordNavigation(to.fullPath); resetExitArm() })

  // 原生带路由拉起时（控制台/设置里点条目进来）会广播这个事件：把当前路由记为入口根。
  window.addEventListener('coomi:native-entry', () => {
    // 父页：console = 从原生控制台进来（返回要回控制台）；chat = 对话页里自己点进来的。
    ;(window as unknown as { __coomiNativeEntry?: boolean }).__coomiNativeEntry = true
    setNativeEntryRoute(router.currentRoute.value.path)
  })

  window.__coomiHandleSystemBack = () => {
    if (closeTopOverlay()) return true
    const route = router.currentRoute.value.path
    // 对话页（栈根）按系统返回 = 退出应用，但不是第一次就退：
    // 先给一次可见提示，2 秒内再按一次才真的结束进程（安卓通用约定）。
    if (route === '/') {
      const now = Date.now()
      if (exitArmedAt > 0 && now - exitArmedAt <= EXIT_CONFIRM_MS) {
        exitArmedAt = 0
        return 'exit'
      }
      exitArmedAt = now
      showExitHint()
      return true
    }

    // 栈里有上一页则回上一页（自维护栈，hash 模式可靠）
    if (hasRouterHistory()) {
      navStack.pop()
      const target = navStack[navStack.length - 1] || '/'
      replaceWithoutRecord(router, target)
      return true
    }

    // 已到「从原生页拉起的入口根」：结束当前 WebView 宿主，回到下面那个原生页。
    // 绝不再 router.replace('/') —— 那会把对话页塞回这个宿主，返回时先闪一下对话页，
    // 再被控制台拉起，表现为「子页 ↔ 设置页」来回循环。
    const isNativeRoot = (window as unknown as { __coomiNativeEntry?: boolean }).__coomiNativeEntry === true
    if (isNativeRoot && route === nativeEntryRoot.value) {
      const api = (window as unknown as { CoomiAndroid?: { finishSelf?: () => void } }).CoomiAndroid
      if (api?.finishSelf) { api.finishSelf(); return true }
      return 'exit'
    }

    // 独立群聊首页
    if (route === '/home' || route === '/im' || route === '/collab-chat') {
      goBack(router, '/')
      return true
    }
    if (/^\/im\/[^/]+$/.test(route) || /^\/collab-chat\/[^/]+$/.test(route)) {
      goBack(router, '/home')
      return true
    }

    // 协同工作台树
    if (route === '/collab' || route === '/collab/new') {
      goBack(router, '/')
      return true
    }
    if (/^\/collab\/[^/]+$/.test(route)) {
      goBack(router, '/collab')
      return true
    }
    if (route.startsWith('/collab/new') || route === '/collab/create') {
      goBack(router, '/collab')
      return true
    }

    if (route.startsWith('/life/')) goBack(router, '/life')
    else if (route === '/appearance' || route === '/persona') goBack(router, '/settings')
    // 从原生页面（控制台/设置）用路由拉起的：返回绝不再掉回对话页 —— 
    // 只要「落点会是栈根 '/'（对话页）」，就直接结束 WebView 宿主，回到那个原生页。
    const nativeEntry = (window as unknown as { __coomiNativeEntry?: boolean }).__coomiNativeEntry === true
    const stackNext = navStack.length > 1 ? navStack[navStack.length - 2] : ''
    // 落点是栈根 '/'（对话页）时：从原生拉起的直接结束宿主回原生页；
    // 其余情况优先回「本页的父页」—— 系统返回绝不再掉回对话页。
    if (!nativeEntry && route !== '/' && (stackNext === '' || stackNext === '/')) {
      const parent = parentRouteOf(route)
      if (parent !== '/') { goBack(router, parent); return true }
    }
    if (nativeEntry && (stackNext === '' || stackNext === '/')) {
      // 从原生拉起的子页：优先回设置首页（控制台已经并入网页）。
      const parent = parentRouteOf(route)
      if (parent !== '/') { goBack(router, parent); return true }
      const api = (window as unknown as { CoomiAndroid?: { finishSelf?: () => void } }).CoomiAndroid
      if (api?.finishSelf) { api.finishSelf(); return true }
      return 'exit'
    }
    // 其余子页按「上一级」回父页，不再一律掉回对话页。
    else goBack(router, parentRouteOf(route))
    return true
  }
}
