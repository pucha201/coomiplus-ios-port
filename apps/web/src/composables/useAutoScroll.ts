import { onBeforeUnmount, onMounted, ref, watch, type Ref } from 'vue'

/**
 * 瀑布流跟随滚动 —— 会话页**唯一**的滚动权威。
 *
 * 只做一件事：跟随态下，内容变高就把视口钉到底部。写 scrollTop 走 rAF 合并，
 * 一帧最多一次；不做「按剩余距离缓动」，否则流式正文永远追在内容后面。
 *
 * 两条纪律（旧版反复跳变的根源）：
 * 1) **脱离跟随只认手势**（滚轮向上 / 竖向拖动）。不再用「scrollTop 和上次记录
 *    不一样」猜用户意图 —— 虚拟列表测量、尺寸补偿、揭幕定位都会程序性改
 *    scrollTop，用位移反推必然误判，旧版切会话「停在顶部」就是这么来的。
 * 2) **不再有并行的补偿通道**。折叠组件展开/收起前调用 detachFollow（经由
 *    src/utils/anchorScroll.ts 的 keepAnchor），此后到用户回到底部之前，
 *    这里一次 scrollTop 都不写，不会和别处的补偿互相拉扯。
 */

/** 距离底部小于这个值就算「回到底部了」，配合手势窗口恢复跟随。 */
const REATTACH_PX = 14
/** 手势之后这段时间内的滚动仍算「用户在滚」，动量滚动也覆盖得到。 */
const GESTURE_TAIL_MS = 1500

let active: { detach(): void } | null = null

/**
 * 供折叠组件的一次性锚定使用：展开/收起前撤掉自动跟随。
 * 之后的位置由虚拟列表自身的尺寸补偿 + 瞬时高度负责，这里不再写 scrollTop。
 */
export function detachAutoFollow(): void {
  active?.detach()
}

export function useAutoScroll(target: Ref<HTMLElement | null>) {
  const following = ref(true)
  let boundTarget: HTMLElement | null = null
  let drawerOpen = false
  let raf = 0
  let lastGestureAt = 0
  let touchStartX = 0
  let touchStartY = 0
  let touchActive = false

  function distanceFromBottom(el: HTMLElement): number {
    return el.scrollHeight - el.scrollTop - el.clientHeight
  }

  function pinToBottom(): void {
    const el = boundTarget
    if (!el) return
    const bottom = el.scrollHeight - el.clientHeight
    if (bottom <= 0) return
    if (Math.abs(el.scrollTop - bottom) <= 0.5) return
    el.scrollTop = bottom
  }

  /**
 * 跟随态下的平滑滚底：每帧向目标插值，而不是「内容长高就整行跳到末尾」。
 * - 小步长（流式 token）按 32% 追，视觉是连续平移；
 * - 大跳变（切会话、展开大块）直接到底，避免慢慢追着飞；
 * - 只在跟随态跑，用户手势立刻停。
 */
  const FOLLOW_LERP = 0.32
  const FOLLOW_SNAP_PX = 420
  function followStep(): void {
    raf = 0
    const el = boundTarget
    if (!el || !following.value || drawerOpen) return
    const target = el.scrollHeight - el.clientHeight
    const current = el.scrollTop
    const delta = target - current
    if (delta <= 0) return
    if (delta < 0.6) { el.scrollTop = target; return }
    el.scrollTop = current + (delta > FOLLOW_SNAP_PX ? delta : delta * FOLLOW_LERP)
    raf = requestAnimationFrame(followStep)
  }

  /** 内容变化后调用：跟随态下启动（或续上）平滑滚底循环。 */
  function requestFollow(): void {
    if (!following.value || drawerOpen || raf) return
    raf = requestAnimationFrame(followStep)
  }

  /** 立即贴底：揭幕完成、换会话、换滚动宿主时用（调用方已确认应跟随）。 */
  function pinNow(): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    if (!following.value || drawerOpen) return
    pinToBottom()
  }

  function detachFollow(): void {
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    following.value = false
  }

  function onScroll(): void {
    const el = boundTarget
    if (!el || following.value) return
    // 只有「刚用手势滚过、且已经回到底部」才恢复跟随。
    // 内容自己变矮（折叠、重排）造成的距离变化不算，否则用户刚展开的卡片
    // 会在下一个 chunk 到来时被拽回底部。
    if (performance.now() - lastGestureAt > GESTURE_TAIL_MS) return
    if (distanceFromBottom(el) < REATTACH_PX) following.value = true
  }

  /** 用户手势（滚轮 / 竖向触摸滑动）→ 立刻脱离跟随，生成中也不回拉。
   *  横滑是抽屉手势，不能当成「用户在看历史」而停掉跟随。 */
  function onWheel(event: WheelEvent): void {
    lastGestureAt = performance.now()
    // 向下滚（deltaY > 0）不撤跟随：用户只是想把最后一点看完。
    if (event.deltaY < 0) detachFollow()
  }
  function onTouchStart(event: TouchEvent): void {
    if (event.touches.length !== 1) { touchActive = false; return }
    touchStartX = event.touches[0].clientX
    touchStartY = event.touches[0].clientY
    touchActive = true
  }
  function onTouchMove(event: TouchEvent): void {
    if (!touchActive) return
    const touch = event.touches[0]
    if (!touch) return
    const dx = touch.clientX - touchStartX
    const dy = touch.clientY - touchStartY
    if (Math.abs(dy) < 8) return
    if (Math.abs(dx) > Math.abs(dy)) return
    touchActive = false
    lastGestureAt = performance.now()
    detachFollow()
  }
  function onTouchEnd(): void { touchActive = false }

  function unbind(): void {
    boundTarget?.removeEventListener('scroll', onScroll)
    boundTarget?.removeEventListener('wheel', onWheel as EventListener)
    boundTarget?.removeEventListener('touchstart', onTouchStart as EventListener)
    boundTarget?.removeEventListener('touchmove', onTouchMove as EventListener)
    boundTarget?.removeEventListener('touchend', onTouchEnd)
    boundTarget?.removeEventListener('touchcancel', onTouchEnd)
  }

  function bindTarget(el: HTMLElement | null): void {
    if (el === boundTarget) return
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    unbind()
    boundTarget = el
    if (!el) return
    el.addEventListener('scroll', onScroll, { passive: true })
    el.addEventListener('wheel', onWheel, { passive: true })
    el.addEventListener('touchstart', onTouchStart, { passive: true })
    el.addEventListener('touchmove', onTouchMove, { passive: true })
    el.addEventListener('touchend', onTouchEnd, { passive: true })
    el.addEventListener('touchcancel', onTouchEnd, { passive: true })
    // 换宿主不继承旧位置：新宿主对应的是新内容（或同一内容的重新测量），
    // 跟随态直接贴底，非跟随态停在原位由揭幕门统一显示。
    if (following.value) pinToBottom()
  }

  /** 回到底部按钮：平滑滚过去，并立即恢复跟随。 */
  function jumpToBottom(): void {
    const el = boundTarget
    if (!el) return
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    following.value = true
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }

  const stopTargetWatch = watch(target, bindTarget, { flush: 'post' })

  function onDrawer(event: Event): void {
    const open = Boolean((event as CustomEvent<{ open?: boolean }>).detail?.open)
    if (open === drawerOpen) return
    drawerOpen = open
    // 抽屉关掉且仍在跟随：把抽屉打开期间积压的高度差一次补齐。
    if (!open) pinNow()
  }

  active = { detach: detachFollow }

  onMounted(() => {
    window.addEventListener('coomi:drawer-state', onDrawer)
    bindTarget(target.value)
  })

  onBeforeUnmount(() => {
    window.removeEventListener('coomi:drawer-state', onDrawer)
    if (active?.detach === detachFollow) active = null
    stopTargetWatch()
    if (raf) { cancelAnimationFrame(raf); raf = 0 }
    unbind()
    boundTarget = null
  })

  return { following, pinNow, requestFollow, detachFollow, jumpToBottom }
}
