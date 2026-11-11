import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { createLocalConnectionClient, RemoteConnectionClient } from '@/bridge/remote'
import { ensureIrohTunnel, lastIrohLatency } from '@/bridge/iroh'
import { authedFetch, engineToken, setEngineEndpoint } from '@/bridge/http'
import { discoverDesktops } from '@/bridge/discovery'
import { matchDiscoveredEndpoint, type DiscoveredPeer } from '@/utils/deviceDiscovery'
import { hasP2PChannel } from '@/bridge/p2pHttp'
import { useSessionStore } from '@/stores/session'
import { brokerUrlFor } from '@/utils/brokerConfig'
import type { HostProbe } from '@/utils/hostPresence'
import { readStoredMode, writeStoredMode } from '@/utils/connectionMode'
import { maskToken, normalizeEngineBaseUrl, type ConnectionMode, type EngineEndpoint, type PairedDevice } from '@/protocol/remote'
import { pairingExpired, pairingLikelyDead, pickAutoConnectDevice } from '@/utils/pairing'
import { readTransportDiag } from '@/utils/transportAttribution'
import { mergeEnginePeerSnapshot, planForgetDevice } from '@/utils/deviceRecords'

const DEVICES_KEY = 'coomi.pairedDevices'
const ACTIVE_KEY = 'coomi.deviceId'
const NAME_KEY = 'coomi.deviceName'
// coomi.connectionMode 的读写必须走 readStoredMode/writeStoredMode：这个键历史上被
// persist() 写成 JSON 带引号的 `"cloud"`，裸字符串比较读不回云端 → 重载即退回本地。

function readJson<T>(key: string, fallback: T): T {
  try { const value = JSON.parse(localStorage.getItem(key) ?? 'null'); return value ?? fallback } catch { return fallback }
}
function persist<T>(key: string, value: T): void { try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private mode */ } }

export const useDeviceStore = defineStore('device', () => {
  // 设备切换 UI 已恢复：启动按上次选择进入本地/某台电脑；没有设备时会停在「选择设备」。
  const mode = ref<ConnectionMode>(readStoredMode(localStorage))
  const devices = ref<PairedDevice[]>(readJson(DEVICES_KEY, []))
  const deviceId = ref(localStorage.getItem(ACTIVE_KEY) ?? '')
  const deviceName = ref(localStorage.getItem(NAME_KEY) ?? '')
  const localDeviceId = ref(localStorage.getItem('coomi.localDeviceId') ?? createLocalDeviceId())
  localStorage.setItem('coomi.localDeviceId', localDeviceId.value)
  const engineBase = ref(normalizeEngineBaseUrl(localStorage.getItem('coomi.engineBase') ?? ''))
  const engineTokenValue = ref(localStorage.getItem('coomi.engineToken') ?? '')
  rememberLocalEndpoint()
  const engineStatus = ref<EngineEndpoint>({ engineBase: '', tokenConfigured: false })
  /** 后台探活结论：只回答「这台电脑本身有没有应答」，供横幅说清故障在哪一侧。 */
  const hostProbe = ref<HostProbe | null>(null)
  /**
   * 链路诊断：云端模式下「现在走哪条、各花多久、上次为什么失败」的唯一来源。
   * 之前这些信息散在三处日志里，用户只能看到「连不上」。
   */
  const linkDiag = ref<{ channel: 'local' | 'lan' | 'iroh' | 'none'; irohMs: number; lanMs: number; error: string }>({
    channel: 'none', irohMs: 0, lanMs: 0, error: '',
  })
  // iroh 连续失败后**冷却**一段时间，而不是整会话放弃：
  // 以前失败两次就再也不试，切网、回前台、重新配对都不恢复，
  // 用户看到的就是「明明在新网络里还是连不上」。
  const irohFailures = new Map<string, number>()
  const irohCooldownUntil = new Map<string, number>()
  const IROH_FAILURE_LIMIT = 2
  const IROH_COOLDOWN_MS = 60_000

  function irohCooling(id: string): boolean {
    const until = irohCooldownUntil.get(id) ?? 0
    if (!until) return false
    if (Date.now() >= until) { irohCooldownUntil.delete(id); irohFailures.delete(id); return false }
    return true
  }

  /** 网络恢复/回前台/重新配对：清掉冷却，下一次连接重新试 iroh。 */
  function resetIrohCooldown(id?: string): void {
    if (id) { irohCooldownUntil.delete(id); irohFailures.delete(id) }
    else { irohCooldownUntil.clear(); irohFailures.clear() }
  }

  // 单测环境可能只有 window（stub）没有 document：两处分开判断。
  if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
    window.addEventListener('online', () => resetIrohCooldown())
  }
  if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') resetIrohCooldown()
    })
  }
  const loading = ref(false)
  const error = ref<string | null>(null)
  /** 「删是删掉了，但有半件事没成」这类信息不能染成红色错误，否则用户以为失败了。 */
  const notice = ref<string | null>(null)
  const activeDevice = computed(() => devices.value.find(device => device.id === deviceId.value) ?? null)
  const tokenStatus = computed(() => { const value = engineTokenValue.value || engineToken(); return { configured: Boolean(value), masked: maskToken(value) } })

  /** 切本地/云端或换设备后需要重绑 WS/传输层：整页刷新最稳（状态全量重建）。 */
  function reconnectActiveTransport() {
    try {
      const session = useSessionStore()
      session.reconnect()
    } catch { /* store may be created before Pinia active context */ }
  }

  /** 解析电脑端生成的连接码（JSON / Base64 / coomi://）→ 设备条目（不需要请求本机引擎）。 */
  async function parsePairingPayload(code: string): Promise<PairedDevice | null> {
    let raw = code.trim()
    if (raw.toLowerCase().startsWith('coomi://')) raw = raw.slice('coomi://'.length)
    if (raw && !raw.startsWith('{')) {
      try { const decoded = atob(raw); if (decoded.trim().startsWith('{')) raw = decoded } catch { /* not base64 */ }
    }
    let parsed: { v?: number; deviceId?: string; peerId?: string; name?: string; lan?: { host?: string; port?: number }; token?: string; exp?: number; brokerUrl?: string; iroh?: PairedDevice['iroh'] }
    try {
      parsed = JSON.parse(raw) as typeof parsed
    } catch { return null }
    try {
      const data = parsed
      const host = data.lan?.host ?? ''
      const port = Number(data.lan?.port ?? 0)
      if (!data.deviceId) return null
      // 桌面端配对码带过期时间（秒）：过期的码在扫码阶段就拒绝，别等连上以后 401。
      if (data.exp && data.exp * 1000 <= Date.now()) throw new Error('配对码已过期，请在电脑上重新生成')
      const now = Date.now()
      const device: PairedDevice = {
        id: data.deviceId,
        peerId: data.peerId,
        pairingSecret: data.token ?? '',
        p2pSecretHash: undefined,
        name: data.name || data.deviceId,
        kind: 'desktop',
        engineBase: host && port ? 'http://' + host + ':' + port : '',
        engineToken: data.token ?? '',
        brokerUrl: data.brokerUrl?.trim() || undefined,
        iroh: data.iroh && typeof data.iroh === 'object' ? data.iroh : undefined,
        reachability: 'unknown',
        lastSeenAt: now,
        expiresAt: data.exp ? data.exp * 1000 : undefined,
        createdAt: now,
        updatedAt: now,
      }
      if (device.pairingSecret) {
        const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(device.pairingSecret))
        device.p2pSecretHash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
      }
      return device
    } catch (error) {
      if (error instanceof Error && error.message.includes('过期')) throw error
      return null
    }
  }

  function saveDevices() { persist(DEVICES_KEY, devices.value) }
  function createLocalDeviceId(): string {
    try { return 'web-' + crypto.randomUUID() } catch { return 'web-' + Date.now().toString(36) + Math.random().toString(36).slice(2) }
  }
  async function ensureP2pSecretHash(peer: PairedDevice): Promise<string> {
    if (!peer.peerId) throw new Error('连接码缺少 peerId，请重新获取配对码')
    if (peer.p2pSecretHash) return peer.p2pSecretHash
    if (!peer.pairingSecret) throw new Error('配对凭据已丢失，请重新扫描连接码')
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(peer.pairingSecret))
    peer.p2pSecretHash = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
    devices.value = devices.value.map(item => item.id === peer.id ? { ...item, p2pSecretHash: peer.p2pSecretHash } : item)
    saveDevices()
    return peer.p2pSecretHash
  }
  async function getRemotePeerConfig(device?: PairedDevice | null) {
    const peer = device ?? activeDevice.value
    if (!peer) throw new Error('请选择已配对设备')
    if (!peer.peerId) throw new Error('连接码缺少 peerId，请重新获取配对码')
    return { device: peer, localDeviceId: peer.peerId, peerDeviceId: peer.id, sharedSecret: await ensureP2pSecretHash(peer), brokerUrl: brokerUrlFor(peer, import.meta.env.VITE_SYNC_BROKER_WSS as string | undefined) }
  }
  const LOCAL_TOKEN_KEY = 'coomi.localEngineToken'
  const LOCAL_BASE_KEY = 'coomi.localEngineBase'
  function bridgeValue(name: 'getEngineToken' | 'getEngineBase'): string {
    try { return String((window as unknown as { CoomiAndroid?: Record<string, () => string> }).CoomiAndroid?.[name]?.() ?? '') } catch { return '' }
  }
  /** 切云端前记住手机本地引擎的 base/token（配对 token 会覆盖全局键）。 */
  function rememberLocalEndpoint(): void {
    try {
      const token = bridgeValue('getEngineToken') || engineTokenValue.value || engineToken()
      if (token && !token.startsWith('coomi_pair_')) localStorage.setItem(LOCAL_TOKEN_KEY, token)
    } catch { /* ignore */ }
  }
  /** 切回本地：恢复本地引擎地址与 token，否则所有 /api 都会 401（模型列表空、WS 无限重连）。 */
  function restoreLocalEndpoint(): void {
    try {
      const token = bridgeValue('getEngineToken') || localStorage.getItem(LOCAL_TOKEN_KEY) || ''
      // 本地引擎永远同源：不要用 pairing store 里的 engineBase（那是远程地址）
      engineBase.value = ''
      engineTokenValue.value = token
      // 第三个参数必须显式传：传 undefined 会把内存里的配对 token 留在桥里。
      setEngineEndpoint('', token)
    } catch { /* ignore */ }
  }

  /** 局域网探活：返回往返毫秒，够不到返回 null。 */
  async function probeLan(base: string, token: string | undefined, timeoutMs = 1500): Promise<number | null> {
    if (!base) return null
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()
    try {
      const response = await fetch(base.replace(/\/+$/, '') + '/api/runtime/health', {
        headers: { Accept: 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
        signal: controller.signal,
      })
      return response.ok ? Date.now() - startedAt : null
    } catch { return null } finally { clearTimeout(timer) }
  }

  /** 把隧道失败翻译成四类可操作原因：中继不可达 / 打洞失败 / 令牌失效 / 电脑未启动。 */
  function classifyIrohFailure(message: string, selected: PairedDevice): string {
    const text = message.toLowerCase()
    const directOnly = selected.iroh?.mode === 'direct'
      || (Array.isArray(selected.iroh?.relay) && selected.iroh.relay.length === 0)
    if (directOnly) {
      return '这台电脑配对时没有连上中继，只能在同一个 Wi-Fi 下使用；跨网请让电脑联网后重新生成配对码'
    }
    if (/401|403|token|令牌|凭据|unauthor/i.test(text)) {
      return '配对令牌已失效，请在电脑上重新生成配对码并扫码'
    }
    if (/没有响应|超时|timeout|timed out|打洞|handshake/i.test(text)) {
      return '中继或打洞没有打通（' + message + '）。检查电脑是否联网、防火墙是否放行 UDP；同一 Wi-Fi 可直接用局域网'
    }
    if (/refused|unreachable|not running|未启动|连接被拒/i.test(text)) {
      return '电脑端引擎没有应答，请确认 CoomiPlus 正在运行'
    }
    return 'iroh 直连不可用，改用局域网：' + message
  }

  async function endpointForDevice(selected: PairedDevice): Promise<string> {
    const failures = irohFailures.get(selected.id) ?? 0
    if (!selected.iroh?.addr) {
      // 旧配对的二维码里没有 iroh 地址：同网还能走 LAN，跨网必须重新配对。
      linkDiag.value = { channel: 'lan', irohMs: 0, lanMs: 0, error: '这台电脑的配对码没有隧道地址（旧配对），跨网需要重新扫码配对' }
    }
    // iroh 仍然优先（用户定的顺序），但必须验活：本地代理端口起得来不代表隧道通。
    if (selected.iroh?.addr && irohCooling(selected.id)) {
      linkDiag.value = {
        channel: 'lan',
        irohMs: 0,
        lanMs: 0,
        error: `iroh 冷却中，${Math.max(1, Math.ceil(((irohCooldownUntil.get(selected.id) ?? 0) - Date.now()) / 1000))} 秒后自动重试`,
      }
    }
    if (selected.iroh?.addr && !irohCooling(selected.id)) {
      try {
        const base = await ensureIrohTunnel(selected)
        if (base) {
          resetIrohCooldown(selected.id)
          linkDiag.value = { channel: 'iroh', irohMs: lastIrohLatency, lanMs: 0, error: '' }
          return base
        }
      } catch (cause) {
        const next = failures + 1
        if (next >= IROH_FAILURE_LIMIT) {
          irohCooldownUntil.set(selected.id, Date.now() + IROH_COOLDOWN_MS)
          irohFailures.set(selected.id, 0)
        } else {
          irohFailures.set(selected.id, next)
        }
        const message = cause instanceof Error ? cause.message : String(cause)
        const reason = classifyIrohFailure(message, selected)
        notice.value = reason
        linkDiag.value = { channel: 'lan', irohMs: 0, lanMs: 0, error: 'iroh：' + reason }
      }
    }
    // 局域网地址来自扫码那一刻：DHCP 换 IP / 换网卡后先探活，不通再用 UDP 发现找回来。
    const token = selected.pairingSecret ?? selected.engineToken
    let base = selected.engineBase
    let lanMs = await probeLan(base, token)
    if (lanMs === null && await healEndpoint(selected)) {
      const healed = devices.value.find(item => item.id === selected.id)
      if (healed?.engineBase) { base = healed.engineBase; lanMs = await probeLan(base, token) }
    }
    linkDiag.value = {
      channel: 'lan',
      irohMs: linkDiag.value.irohMs,
      lanMs: lanMs ?? 0,
      error: lanMs === null ? (linkDiag.value.error || '局域网地址没有应答（检查同一 Wi-Fi / 电脑的局域网直连开关 / 防火墙）') : linkDiag.value.error,
    }
    return base
  }

  function setMode(next: ConnectionMode) {
    mode.value = next
    writeStoredMode(localStorage, next)
    // 上一次探活说的是别的网络/别的电脑，换了上下文就不能再拿去解释现状。
    hostProbe.value = null
    if (next === 'local') { restoreLocalEndpoint(); reconnectActiveTransport(); return }
    // 切云端：有已选设备就立刻把端点换成那台电脑（幂等），没有就清空远端地址，
    // 让界面显示「选择设备」而不是悄悄继续用本地引擎。
    const selected = activeDevice.value
    if (selected) {
      rememberLocalEndpoint()
      void selectDevice(selected.id)
    } else {
      rememberLocalEndpoint()
      engineBase.value = ''
      engineTokenValue.value = ''
      setEngineEndpoint('', '')
      reconnectActiveTransport()
    }
  }
  async function selectDevice(id: string): Promise<void> {
    const selected = devices.value.find(device => device.id === id)
    if (!selected) return
    // 引擎对活跃配对会滑动续期，本地记录可能「名义过期但实际还活着」：
    // 只有过期超过一整天才硬拒；宽限内照常连接，真 401 时再由连接归因提示重扫。
    if (pairingLikelyDead(selected.expiresAt)) {
      error.value = '这台电脑的配对已过期（超过一天未连接），请在电脑上重新生成连接码'
      return
    }
    deviceId.value = id; localStorage.setItem(ACTIVE_KEY, id)
    hostProbe.value = null
    rememberLocalEndpoint()
    const base = await endpointForDevice(selected)
    if (!base) {
      error.value = '这台电脑没有可用的连接地址；请重新生成连接码'
      return
    }
    setEndpoint(base, selected.pairingSecret, selected.name)
    mode.value = 'cloud'
    writeStoredMode(localStorage, 'cloud')
    reconnectActiveTransport()
  }
  function setEndpoint(base: string, token?: string, name?: string) {
    engineBase.value = normalizeEngineBaseUrl(base)
    if (token !== undefined) engineTokenValue.value = token.trim()
    if (name !== undefined) { deviceName.value = name; localStorage.setItem(NAME_KEY, name) }
    setEngineEndpoint(engineBase.value, token)
  }
  function setEngine(base: string, token?: string) { rememberLocalEndpoint(); setEndpoint(base, token); mode.value = 'cloud'; writeStoredMode(localStorage, 'cloud'); reconnectActiveTransport() }
  function removeDevice(id: string) { devices.value = devices.value.filter(device => device.id !== id); if (deviceId.value === id) { deviceId.value = ''; localStorage.removeItem(ACTIVE_KEY) }; saveDevices() }

  /**
   * 冷启动兜底：云端模式却没选设备时，只自动选「配对未过期 + 在线 + 最近见过」的那台。
   * 过期/离线/久未确认的设备一律不选 —— 否则一进应用就进无限重连。
   */
  async function autoSelectDeviceOnBoot(): Promise<void> {
    if (mode.value !== 'cloud' || !devices.value.length) return
    const chosen = (deviceId.value && devices.value.find(item => item.id === deviceId.value))
      || pickAutoConnectDevice(devices.value)
    if (!chosen) return
    if (!deviceId.value) {
      deviceId.value = chosen.id
      localStorage.setItem(ACTIVE_KEY, chosen.id)
    }
    // 冷启动必须重建 iroh 代理（端口会变）；否则 browser 还拿着上次的旧端口。
    if (chosen.iroh?.addr) {
      const base = await endpointForDevice(chosen)
      if (mode.value !== 'cloud' || deviceId.value !== chosen.id) return
      if (base) {
        setEndpoint(base, chosen.pairingSecret, chosen.name)
        reconnectActiveTransport()
      }
      void ensureP2pSecretHash(chosen).catch(() => undefined)
      return
    }
    if (!engineBase.value) {
      setEndpoint(chosen.engineBase, chosen.pairingSecret, chosen.name)
      reconnectActiveTransport()
    }
    void ensureP2pSecretHash(chosen).catch(() => undefined)
  }

  /** 冷启动先清掉已过期的选中设备：留在选中态只会让传输层拿废令牌无限重连。 */
  function dropExpiredSelectionOnBoot(): void {
    if (!deviceId.value) return
    const selected = devices.value.find(item => item.id === deviceId.value)
    if (!selected || !pairingExpired(selected.expiresAt)) return
    deviceId.value = ''
    localStorage.removeItem(ACTIVE_KEY)
    engineBase.value = ''
    engineTokenValue.value = ''
    setEngineEndpoint('', '')
    error.value = '这台电脑的配对已过期，请在电脑上重新生成连接码'
  }

  dropExpiredSelectionOnBoot()
  void autoSelectDeviceOnBoot()

  function clientFor(device?: PairedDevice | null): RemoteConnectionClient | null {
    const target = device ?? activeDevice.value
    // 云端优先用当前 engineBase：它可能是 iroh 本地代理，而不是配对时的 LAN 地址。
    const base = (mode.value === 'cloud' && engineBase.value) ? engineBase.value : (target?.engineBase || engineBase.value)
    const token = target?.pairingSecret || engineTokenValue.value || (mode.value === 'cloud' ? '' : engineToken())
    if (!base) return createLocalConnectionClient()
    try { return new RemoteConnectionClient({ engineBase: base, engineToken: token }) } catch { return createLocalConnectionClient() }
  }

  async function refreshDevices(): Promise<boolean> {
    loading.value = true; error.value = null
    try {
      const response = await authedFetch('/api/device/peers', { headers: { Accept: 'application/json' } })
      if (!response.ok) throw new Error('GET /api/device/peers → ' + response.status)
      const data = await response.json() as { peers?: Array<{ id: string; online?: boolean; revoked?: boolean; expired?: boolean; lastSeenAt?: number; expiresAt?: number }> }
      // 电脑那边的 peers 是「配过这台电脑的手机号」，和我存的「哪台电脑」不是一回事：
      // 只能按 peerId 对齐着更新状态，整表替换会把 pairingSecret/peerId 冲掉，互联只能重扫。
      devices.value = mergeEnginePeerSnapshot(devices.value, data.peers ?? [])
      saveDevices(); return true
    } catch (cause) { error.value = cause instanceof Error ? cause.message : '设备列表暂不可用'; return false } finally { loading.value = false }
  }
  async function addDeviceByCode(code: string, name?: string): Promise<PairedDevice | null> {
    let parsed: PairedDevice | null = null
    try {
      parsed = await parsePairingPayload(code)
    } catch (cause) {
      error.value = cause instanceof Error ? cause.message : '连接码无法识别'
      return null
    }
    if (parsed) {
      devices.value = [...devices.value.filter(d => d.id !== parsed.id), parsed]
      saveDevices()
      // 配对那一刻电脑没有中继：当场说清楚，别等用户切到蜂窝才失败。
      // relay_pending = 二维码里有中继地址但中继还没连上（新引擎会如实标记）。
      if (parsed.iroh?.mode === 'direct') {
        notice.value = '配对成功，但电脑当前没有连上中继：这次配对只能在同一个 Wi-Fi 下使用。跨网请让电脑联网后重新生成配对码。'
      } else if (parsed.iroh?.mode === 'relay_pending') {
        notice.value = '配对成功，但电脑的中继还没就绪：跨网可能暂时连不上。稍后让电脑重新生成配对码再扫一次即可。'
      }
      await selectDevice(parsed.id)
      return parsed
    }
    const client = clientFor(); if (!client) { error.value = '连接码无法识别（请粘贴电脑端生成的连接码）'; return null }
    loading.value = true; error.value = null
    try { const result = await client.pair(code, name); devices.value = [...devices.value.filter(d => d.id !== result.device.id), result.device]; await selectDevice(result.device.id); saveDevices(); return result.device }
    catch (cause) { error.value = cause instanceof Error ? cause.message : '添加设备失败'; return null } finally { loading.value = false }
  }
  async function deleteDevice(id: string): Promise<boolean> {
    const record = devices.value.find(item => item.id === id) ?? null
    loading.value = true; error.value = null; notice.value = null
    const plan = record
      ? planForgetDevice(record, hasP2PChannel())
      : { localRemoved: true as const, shouldNotifyEngine: false, reason: '' }
    if (plan.shouldNotifyEngine) {
      try {
        await authedFetch('/api/device/self-revoke', { method: 'POST' })
      } catch (cause) {
        plan.reason = '已在本地忘记这台电脑，但没能通知它作废凭据：' + (cause instanceof Error ? cause.message : '网络不可达')
      }
    }
    removeDevice(id)
    notice.value = plan.reason || null
    loading.value = false
    return true
  }
  /**
   * 通道没打通时探一次电脑的局域网地址。
   *
   * 只记「有没有应答」，绝不改 reachability：蜂窝网络下 LAN 地址必然无应答，
   * 把设备标成离线会让回到 Wi-Fi 后的冷启动自动连接直接放弃这台电脑。
   * 401 也算应答 —— 有人应答就说明电脑开着，问题在令牌/通道，不在电源。
   */
  async function probeHost(): Promise<void> {
    const peer = activeDevice.value
    if (mode.value !== 'cloud' || !peer?.engineBase) return
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 4000)
    let reachable = false
    try {
      await fetch(peer.engineBase + '/api/device/info', {
        headers: { Accept: 'application/json', Authorization: 'Bearer ' + (peer.engineToken ?? peer.pairingSecret ?? '') },
        signal: controller.signal,
      })
      reachable = true
    } catch { reachable = false } finally { clearTimeout(timer) }
    if (activeDevice.value?.id !== peer.id) return
    hostProbe.value = { reachable, checkedAt: Date.now() }
  }

  /**
   * 电脑换了 IP / 重启换了端口时，按 deviceId 在局域网里把它找回来。
   *
   * 二维码里焊死的是「生成那一刻的局域网地址」，DHCP 续租、换网卡、引擎重启都会让它过期；
   * 之前唯一的补救是重新扫码。发现回包里的 host 取自 UDP 源地址，天然是当前可达的那张网卡。
   */
  let lastHealAttemptAt = 0
  let lastHealDeviceId = ''
  async function healEndpoint(target?: PairedDevice | null): Promise<boolean> {
    const peer = target ?? activeDevice.value
    if (!peer || peer.kind !== 'desktop') return false
    // 探活是周期性的：同一台电脑 30 秒内只广播一次，别让离线期间的轮询变成广播风暴。
    const now = Date.now()
    if (peer.id === lastHealDeviceId && now - lastHealAttemptAt < 30_000) return false
    lastHealDeviceId = peer.id
    lastHealAttemptAt = now
    let peers: DiscoveredPeer[] = []
    try { peers = await discoverDesktops() } catch { return false }
    const base = matchDiscoveredEndpoint(peer.id, peers)
    if (!base || base === normalizeEngineBaseUrl(peer.engineBase)) return false
    devices.value = devices.value.map(item => item.id === peer.id
      ? { ...item, engineBase: base, updatedAt: Date.now() }
      : item)
    saveDevices()
    if (deviceId.value === peer.id && mode.value === 'cloud') {
      engineBase.value = base
      setEngineEndpoint(base, peer.pairingSecret)
      reconnectActiveTransport()
    }
    return true
  }

  async function checkEngine(target?: PairedDevice | null): Promise<EngineEndpoint | null> {
    const client = clientFor(target)
    const id = target?.id ?? deviceId.value
    const mark = (reachability: 'online' | 'offline') => {
      if (!id) return
      devices.value = devices.value.map(item => item.id === id
        ? { ...item, reachability, lastSeenAt: reachability === 'online' ? Date.now() : item.lastSeenAt, updatedAt: Date.now() }
        : item)
      saveDevices()
    }
    /**
     * 活跃通道已经开着 = 电脑此刻可达，直接判在线。
     *
     * 以前这里还要再打一次 HTTP 去「证明」它在线：P2P 代理偶发失败就掉到局域网判定，
     * 蜂窝下必然失败 → 设备被标成离线，而桌面那边明明显示「直连中」。
     * 通道状态本身就是最硬的证据，不该被一次附加请求推翻。
     */
    const live = readTransportDiag()
    if (mode.value === 'cloud' && live?.state === 'open') {
      const online: EngineEndpoint = {
        engineBase: client?.engineBase ?? engineBase.value,
        tokenConfigured: tokenStatus.value.configured,
        checkedAt: Date.now(),
      }
      engineStatus.value = online
      mark('online')
      return online
    }
    if (!client) return null
    // 蜂窝/中转下 LAN 地址不可达，但加密 P2P 通道可能正连着：优先经 P2P 探测，
    // 否则会把正在使用的设备误标成离线。
    let status: EngineEndpoint | null = null
    if (mode.value === 'cloud' && hasP2PChannel()) {
      try {
        const response = await authedFetch('/api/device/info', { headers: { Accept: 'application/json' } })
        if (!response.ok) throw new Error(String(response.status))
        const info = await response.json() as { engineBase?: string; maskedToken?: string; tokenConfigured?: boolean }
        status = {
          engineBase: info.engineBase ?? client.engineBase,
          maskedToken: info.maskedToken,
          tokenConfigured: info.tokenConfigured ?? true,
          checkedAt: Date.now(),
        }
      } catch { status = null }
    }
    if (status) {
      engineStatus.value = status
      mark('online')
      return status
    }
    try {
      const lanStatus = await client.getEngineStatus()
      engineStatus.value = lanStatus
      mark('online')
      return lanStatus
    } catch (cause) {
      // 地址失效是常态（DHCP / 引擎换端口）：先在局域网里找回来再重试一次，
      // 用户不必因为「二维码是昨天扫的」重新配对。
      if (await healEndpoint(target)) {
        const healedPeer = devices.value.find(item => item.id === (target?.id ?? deviceId.value)) ?? null
        const retry = healedPeer ? clientFor(healedPeer) : null
        if (retry) {
          try {
            const lanStatus = await retry.getEngineStatus()
            engineStatus.value = lanStatus
            mark('online')
            return lanStatus
          } catch { /* 自愈后仍不通：按真实离线处理 */ }
        }
      }
      engineStatus.value = { engineBase: client.engineBase, tokenConfigured: tokenStatus.value.configured, error: cause instanceof Error ? cause.message : '引擎不可达', checkedAt: Date.now() }
      mark('offline')
      return engineStatus.value
    }
  }
  void autoSelectDeviceOnBoot()
  return { mode, devices, deviceId, deviceName, localDeviceId, engineBase, engineToken: engineTokenValue, engineStatus, hostProbe, linkDiag, loading, error, notice, activeDevice, tokenStatus, setMode, selectDevice, setEngine, setEndpoint, refreshDevices, addDeviceByCode, deleteDevice, removeDevice, checkEngine, probeHost, healEndpoint, getRemotePeerConfig }
})
