import { computed, onBeforeUnmount, ref, watch, type ComputedRef, type Ref } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import {
  advanceReveal,
  forgetRevealRecord,
  initialRevealShown,
  peekRevealRecord,
  revealRecordFor,
  startRevealDriver,
  type RevealDriver,
} from '@/utils/streamReveal'

/** 参与逐字揭示的消息形状：助手正文、过程块里的叙述段都用它。 */
export interface RevealSource {
  id: string
  content: string
  streaming?: boolean
}

export interface StreamRevealHandle {
  /** 逐字中 = 已揭示的那一截文本；否则 null（调用方按原文渲染）。 */
  text: ComputedRef<string | null>
  /** 已揭示长度：渲染层的渐隐窗口也读这一份，避免第二套进度。 */
  head: Ref<number>
  /** 是否正在逐字揭示。 */
  revealing: ComputedRef<boolean>
  /** 立即全量落定（切会话 / 卸载 / 异常兜底）。 */
  settle: () => void
}

/** 系统「减少动态效果」时也不逐字（与 AgentState 同一探测口径）。 */
function reducedMotion(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches === true
}

/**
 * 渲染层唯一的逐字揭示入口（对标桌面端流式纯文本口径，Web 端多一层「按长度差推进」）。
 *
 * 三条设计约束：
 *   ① **只渲染、不猜**：是否「在生成」由 store 的权威证据决定（见 arm），
 *      不用 isBusy 单证据（真机上它偶尔不置位），也不用「时间线最后一项」单证据
 *      （恢复出来的历史消息也长那样，会被当成在生成而重播动画）。
 *   ② **进度不随组件销毁丢失**：vue-virtual-scroller 滚出视口会卸载行组件，
 *      已揭示长度与 armed 标志按消息 id 存在模块级表里，重挂时接着走。
 *   ③ **保证落定**：一切异常路径都收敛到「全量显示」，绝不留「没有字」。
 */
export function useStreamReveal(msg: RevealSource): StreamRevealHandle {
  const session = useSessionStore()
  const config = useConfigStore()

  const streaming = computed(() => msg.streaming === true)
  const target = computed(() => msg.content.length)
  /** 开关语义（config.smoothOutput）：关掉就走「直接整段追加」的旧行为。 */
  const enabled = computed(() => config.smoothOutput && !reducedMotion())

  const existing = peekRevealRecord(msg.id)
  const armed = ref(existing?.armed ?? false)
  const shown = ref(initialRevealShown(existing?.shown, msg.content.length))
  let owed = existing?.owed ?? 0
  let driver: RevealDriver | null = null
  /** 本组件存活期间见过的正文长度：用它判断「内容长过没有」。 */
  let seenLen = msg.content.length
  let frameCount = 0

  const revealing = computed(() => enabled.value && armed.value && shown.value < target.value)
  const text = computed(() => (revealing.value ? msg.content.slice(0, shown.value) : null))

  function syncRecord(): void {
    const rec = peekRevealRecord(msg.id)
    if (!rec) return
    rec.shown = shown.value
    rec.owed = owed
    rec.armed = armed.value
  }

  function settle(): void {
    stopDriver()
    shown.value = target.value
    owed = 0
    // 流还没结束：留着 armed（下一批字接着逐字），不删记录；
    // 已结束：这条消息从此是历史，删记录 + 撤 armed，之后绝不再逐字。
    if (streaming.value) syncRecord()
    else { armed.value = false; forgetRevealRecord(msg.id) }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('coomi:reveal-tick'))
  }

  function stopDriver(): void {
    driver?.stop()
    driver = null
  }

  function startDriver(): void {
    if (driver) return
    driver = startRevealDriver({
      target: () => target.value,
      step: (dt: number) => {
        const next = advanceReveal(shown.value, owed, target.value, dt)
        shown.value = next.shown
        owed = next.owed
        if (shown.value >= target.value) { settle(); return true }
        syncRecord()
        // 每 4 帧通知一次滚动跟随（约 65ms）：逐字增长也能贴着底部。
        if (++frameCount % 4 === 0 && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('coomi:reveal-tick'))
        }
        return false
      },
      settle,
    })
  }

  /**
   * 武装：确认「引擎正在往这条消息上追加」。
   *  · 权威证据：它就是 store 当前收字的那个指针（currentAssistant）；
   *  · 兜底证据：本组件见过它内容增长，且它仍标记着 streaming / 会话仍在跑。
   * 恢复出来的历史消息两条都不成立（没有指针、也不会再长）→ 不武装、不重播。
   */
  function arm(grew: boolean): void {
    if (armed.value || !enabled.value) return
    const isCurrent = msg.id === session.activeAssistantId
    if (!isCurrent && !(grew && (streaming.value || session.streamActive))) return
    const rec = revealRecordFor(msg.id)
    rec.armed = true
    armed.value = true
    // 重挂时正文已经存在：从已有内容接着显示，绝不回放最后一段。
    // 这里只同步一次进度，不把 shown 往回拨。
    if (shown.value < rec.shown) shown.value = rec.shown
    syncRecord()
  }

  watch(
    [streaming, () => session.activeAssistantId, () => session.streamActive, target, enabled],
    () => {
      const grew = target.value > seenLen
      seenLen = target.value
      arm(grew)
    },
    { immediate: true },
  )

  watch([revealing, target], () => {
    if (revealing.value) startDriver()
    else stopDriver()
  }, { immediate: true })

  // 开关被关掉 / 系统改为减少动态效果：立刻全量，绝不留半截。
  watch(enabled, (on) => { if (!on) settle() })

  onBeforeUnmount(() => {
    // 只停驱动、**不**落定：用户滚走再滚回来要接着看剩余的字。
    // 全部落定的消息在这里删记录，避免表无限长。
    stopDriver()
    syncRecord()
    if (!streaming.value && shown.value >= target.value) forgetRevealRecord(msg.id)
  })

  return { text, head: shown, revealing, settle }
}
