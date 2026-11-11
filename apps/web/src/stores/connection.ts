import { defineStore } from 'pinia'
import { ref, computed } from 'vue'
import type { ConnectionState, ConnectionStatus } from '@/bridge'
import { isDemoMode } from '@/bridge/demoMode'
import { attributeTransport, readTransportDiag } from '@/utils/transportAttribution'
import type { TransportDiag } from '@/utils/transportAttribution'

export const useConnectionStore = defineStore('connection', () => {
  const state = ref<ConnectionState>('connecting')
  const retryMessage = ref<string | null>(null)
  const retryAttempt = ref(0)
  const retryMax = ref(0)
  const retryDelayMs = ref(0)
  const wsUrl = ref('')
  /** 云端降级链当下走的那条通道（本机模式为 null）。 */
  const transport = ref<TransportDiag | null>(readTransportDiag())
  const isOpen = computed(() => state.value === 'open')
  /**
   * 「互联连不上」要说清是哪条通道、卡在哪一步、为什么。
   * 通道状态只有一份真相：桥层的诊断，不是重连计数器。
   */
  const attribution = computed(() => attributeTransport(transport.value))
  /**
   * 正在自动重连：只有这一态才配「正在重试」的断续闪烁。
   * closed / error 是终态（例如云端没选设备），再闪就是在骗人。
   */
  const isRetrying = computed(() => state.value === 'reconnecting')
  /** 终态下的断开原因（OfflineTransport 会带 reason）；重连中为 null。 */
  const offlineReason = computed(() => {
    if (state.value === 'reconnecting' || state.value === 'open' || state.value === 'connecting') return null
    return retryMessage.value
  })
  /** 演示模式：底下接的是脚本，不是引擎。所有状态文案都要说清这件事。 */
  const demo = ref(isDemoMode())

  const label = computed(() => {
    if (demo.value) return '演示模式（未连引擎）'
    // 云端：通道归因比「连接中…」有用得多。只在两边对「连上没连上」看法一致时才替换，
    // 免得通道说 open、状态机说 reconnecting 时界面各报各的。
    if (attribution.value && attribution.value.connected === (state.value === 'open')) return attribution.value.detail
    switch (state.value) {
      case 'connecting': return '连接中…'
      case 'reconnecting': return retryMessage.value || '正在重连…'
      case 'open': return '已连接'
      case 'closed': return '已断开'
      case 'error': return '连接错误'
    }
  })

  function setStatus(status: ConnectionStatus) {
    state.value = status.state
    retryAttempt.value = status.attempt ?? 0
    retryMax.value = status.maxRetries ?? 0
    retryDelayMs.value = status.delayMs ?? 0
    // 云端降级链不报上限（maxRetries 缺省 0），写成「第 6/0 次」只会让人以为坏了；
    // 没有上限就只报当前第几次。
    const progress = retryMax.value > 0
      ? `第 ${retryAttempt.value}/${retryMax.value} 次重连`
      : `第 ${retryAttempt.value} 次重连`
    retryMessage.value = status.state === 'reconnecting'
      ? `${progress}，${Math.ceil(retryDelayMs.value / 1000)} 秒后尝试`
      : status.state === 'open' ? null : status.reason ?? null
  }
  function setState(s: ConnectionState) { setStatus({ state: s }) }
  function setRetry(msg: string | null) { retryMessage.value = msg }
  function setWsUrl(url: string) { wsUrl.value = url }
  function setTransport(diag: TransportDiag | null) { transport.value = diag }

  return { state, retryMessage, retryAttempt, retryMax, retryDelayMs, wsUrl, transport, isOpen, isRetrying, offlineReason, attribution, demo, label, setStatus, setState, setRetry, setWsUrl, setTransport }
})
