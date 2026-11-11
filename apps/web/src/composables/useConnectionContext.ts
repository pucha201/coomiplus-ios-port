import { nextTick, watch } from 'vue'
import { useConfigStore } from '@/stores/config'
import { useConnectionStore } from '@/stores/connection'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore } from '@/stores/sessions'
import { connectionContextKey, shouldClearSessionHistory } from '@/utils/connectionContext'
import { shouldProbeHost } from '@/utils/hostPresence'
import { primeHydration } from '@/utils/hydration'
import { waitForEngineToken } from '@/bridge/http'
import { applyTransportDiagTo } from '@/utils/transportAttribution'

/** 通道诊断广播只接一次：这个 composable 挂在 App，热重载或多处调用都不该叠监听。 */
let transportDiagWired = false
function wireTransportDiagnostics(
  connection: ReturnType<typeof useConnectionStore>,
  device: ReturnType<typeof useDeviceStore>,
): void {
  if (transportDiagWired || typeof window === 'undefined') return
  transportDiagWired = true
  // 只在云端模式收诊断：本机模式没有降级链，旧降级链的迟到事件不许把归因带回来。
  window.addEventListener('coomi:transport-state', () => applyTransportDiagTo(connection, device.mode))
}

/**
 * 连接上下文的全局入口：模式 / 设备一变，历史、模型、WS 一起换。
 *
 * 必须挂在 App 而不是 ChatView：原生桥、设置页、历史页都可能切设备，
 * 只有全局监听才能保证任何一页看到的都是当前上下文的会话。
 * （以前只在聊天页监听，在别的页面切到云端后，侧栏仍显示本地历史。）
 */
export function useConnectionContext(): void {
  const device = useDeviceStore()
  const session = useSessionStore()
  const sessions = useSessionsStore()
  const config = useConfigStore()
  const connection = useConnectionStore()
  wireTransportDiagnostics(connection, device)

  /**
   * 启动/切上下文后的加载：先立刻打一次，没成功才挂到「通道 open」上补。
   *
   * 冷启动时 WS 的 open 常常早于这个 composable 执行（页面加载前通道就绪），
   * 之后又一直稳定、不会再发第二次 open；只靠 open 触发会让列表永远空着，
   * 直到用户手动切一次模式。所以这里必须主动试，open 只作为失败后的补加载时机。
   */
  let hydrationReplace = false
  let hydrating = false
  let hydrationQueued = false
  const hydrationTask = async (): Promise<void> => {
    // 首帧可能还没拿到引擎令牌：先等它（本机由原生壳注入，云端由配对写入）。
    // 不等就会发出一串 401，界面表现是「什么都没有，切一次模式才出来」。
    await waitForEngineToken()
    const synced = await sessions.syncFromEngine({ replace: hydrationReplace })
    if (!synced) throw new Error('会话列表未同步')
    // 模型列表失败必须让任务留在队列里：以前它内部吞掉错误、永远 resolve，
    // 于是「通道打开后补加载」把它当成功出队，界面就一直空着。
    const providersLoaded = await config.fetchProviders()
    if (!providersLoaded) throw new Error('模型列表未同步')
  }
  function hydrateContext(replace: boolean): void {
    hydrationReplace = replace
    if (hydrating) { hydrationQueued = true; return }
    hydrating = true
    void primeHydration(hydrationTask).finally(() => {
      hydrating = false
      if (hydrationQueued) { hydrationQueued = false; hydrateContext(hydrationReplace) }
    })
  }

  /** 运行中切页回来不立刻同步列表（会让抽屉顺序/标题抖动），等本轮结束再补。 */
  let idleStop: (() => void) | null = null
  function syncSessionsWhenIdle(): void {
    if (!session.isBusy) { void sessions.syncFromEngine({ replace: device.mode === 'cloud' }); return }
    if (idleStop) return
    idleStop = watch(() => session.isBusy, busy => {
      if (busy) return
      idleStop?.()
      idleStop = null
      void sessions.syncFromEngine({ replace: device.mode === 'cloud' })
    })
  }

  let applying = false
  let queued = false
  function applyConnectionContext(): void {
    // 一次只应用一个上下文；过程中又切了模式/设备，就在结束后补跑最后一次。
    if (applying) { queued = true; return }
    applying = true
    const mode = device.mode
    const deviceId = device.deviceId
    const key = connectionContextKey(mode, deviceId)
    // 同步部分先做完：即使后续网络请求失败，当前页的列表也已经切到正确上下文。
    const contextChanged = sessions.switchContext(key)
    if (contextChanged) {
      // 用户指定行为：本地对话里切到云端（或换一台电脑）时，界面必须回到新建对话页，
      // 不能停留在旧上下文的那段对话上。冷启动 context 未变，不会误重置。
      session.newSession()
    }
    config.switchEngineContext(key)
    // 本机模式没有降级链：留着上一次云端通道诊断，状态条会一直播报一条不存在的连接。
    applyTransportDiagTo(connection, mode)
    void (async () => {
      try {
        if (shouldClearSessionHistory(mode, deviceId)) {
          // 云端但没选电脑：历史必须是空的，也不能继续用本地端点收事件。
          sessions.clearSessions()
          session.disconnect()
          // 还没选电脑，任何通道诊断都是上一台设备的旧话：先清空，别让横幅指错原因。
          connection.setTransport(null)
          // disconnect 不会清连接状态：不显式落到 error，顶部会一直挂着上一次的「正在重连」。
          connection.setStatus({ state: 'error', reason: '云端未选择电脑，请先在侧栏选择设备' })
          return
        }
        await nextTick()
        hydrateContext(contextChanged || mode === 'cloud')
        void sessions.refreshRunning()
        // 首帧不需要重连（connect 已经用当前端点建过连接）；只有上下文真的换了才重绑 WS。
        if (contextChanged) session.reconnect()
        if (session.isBusy) syncSessionsWhenIdle()
      } finally {
        applying = false
        if (queued) { queued = false; applyConnectionContext() }
      }
    })()
  }

  watch(() => [device.mode, device.deviceId] as const, () => { applyConnectionContext() })
  applyConnectionContext()

  /**
   * 云端连不上时探一次电脑：横幅要说清故障在电脑那侧还是通道那侧。
   * immediate 让「启动即断开」第一轮就有探活结论，而不是等状态再翻一次。
   */
  let lastHostProbeAt = 0
  watch(() => [device.mode, device.deviceId, connection.state] as const, ([mode, deviceId, state]) => {
    const now = Date.now()
    if (!shouldProbeHost({ mode, deviceId, state, lastProbeAt: lastHostProbeAt, now })) return
    lastHostProbeAt = now
    void device.probeHost()
  }, { immediate: true })

  /**
   * 主动维护「这台电脑现在在不在线」。
   *
   * 侧栏的在线点、设备可连接状态都来自 device.reachability，而它只有 checkEngine 会更新。
   * 旧的那次调用随一个停用的组件一起消失了，于是每台电脑永远停在 unknown →
   * 侧栏一律显示「离线」、点它还会被拦下 —— 用户看到的就是「电脑不在线」。
   *
   * checkEngine 内部同时承担地址自愈（地址失效时局域网发现换新地址再重试）。
   */
  let statusTimer: ReturnType<typeof setTimeout> | null = null
  let statusInFlight = false
  function stopStatusChecks(): void {
    if (statusTimer) { clearTimeout(statusTimer); statusTimer = null }
  }
  function scheduleStatusCheck(delay: number): void {
    stopStatusChecks()
    statusTimer = setTimeout(async () => {
      statusTimer = null
      if (device.mode !== 'cloud' || !device.deviceId) return
      if (statusInFlight) { scheduleStatusCheck(15_000); return }
      statusInFlight = true
      try { await device.checkEngine() } finally {
        statusInFlight = false
        // 连着的时候 30 秒确认一次就够；不通的时候 10 秒一次，让自愈尽快发生。
        const online = device.activeDevice?.reachability === 'online'
        scheduleStatusCheck(online ? 30_000 : 10_000)
      }
    }, delay)
  }
  watch(() => [device.mode, device.deviceId] as const, ([mode, id]) => {
    if (mode !== 'cloud' || !id) { stopStatusChecks(); return }
    scheduleStatusCheck(600)
  }, { immediate: true })
}
