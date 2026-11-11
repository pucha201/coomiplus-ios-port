/**
 * 云端互联失败归因。
 *
 * 桥层（bridge/index.ts）只剩两条腿：iroh 隧道与局域网直连；WebRTC/MQTT 已移除。
 * 局域网直连，每换一条通道都会广播自己的阶段和原因。这个模块把那一份诊断翻成
 * 「哪条通道、走到哪步、为什么」的一句话：底层原因是英文时，直接贴给用户等于没说。
 */
import type { ConnectionState } from '../bridge/transport.ts'
import type { ConnectionMode } from '../protocol/remote.ts'

export type TransportPhase = 'webrtc' | 'relay' | 'lan'

export interface TransportDiag {
  phase: TransportPhase
  state: ConnectionState
  reason: string
}

export interface TransportAttribution {
  /** 现在真正在承载连接的通道。 */
  channel: string
  /** 通道 + 阶段 + 原因，界面可以直接显示。 */
  detail: string
  connected: boolean
}

const CHANNEL_LABEL: Record<TransportPhase, string> = {
  webrtc: 'WebRTC 直连',
  relay: '加密中转',
  lan: '局域网直连',
}

const PHASES = Object.keys(CHANNEL_LABEL) as TransportPhase[]
const STATES: ConnectionState[] = ['connecting', 'reconnecting', 'open', 'closed', 'error']

const STATE_PHRASE: Record<ConnectionState, string> = {
  connecting: '正在尝试',
  reconnecting: '中断，正在恢复',
  open: '',
  closed: '已断开',
  error: '连不上',
}

/**
 * 只翻译「原因」：状态由界面加，桥层不许把状态和原因混在一句里。
 * 顺序即优先级——「加密中转不可用：直连超时」要报最外面那层失败。
 */
const REASON_LABELS: ReadonlyArray<readonly [RegExp, string]> = [
  [/401|unauthor|invalid token|token|pairing/i, '配对凭据已失效，请在电脑上重新生成配对码'],
  // broker 明明连上了，只是房间里没有对端：问题在电脑那侧（没开、没登录、或已撤销这台手机），
  // 不能报成「中转服务连不上」，否则用户会去查网络/换 broker，方向全错。
  [/relay peer/i, '电脑端没有应答（确认电脑在运行、已登录，且配对未被撤销）'],
  [/relay unavailable/i, '加密中转不可用'],
  [/signaling/i, '信令服务器不可用'],
  // MQTT broker 的 WebSocket 连不上：以前这条英文原样出现在状态条里。
  // 它属于中转/信令服务不可达，不是电脑端没应答。
  [/mqtt|broker|websocket/i, '加密中转服务连不上'],
  [/\bice\b|candidate/i, 'NAT 打洞没有打通'],
  [/\bstun\b/i, 'NAT 反射服务器连不上'],
  [/datachannel/i, '加密数据通道没建立'],
  [/relay/i, '加密中转服务连不上'],
  [/timed out|timeout/i, '握手超时'],
  [/certificate|\btls\b|\bssl\b/i, '证书校验失败'],
  [/reachable on the local network/i, '局域网里的电脑有应答'],
  [/refused|unreachable|failed to fetch|\beconn|networkerror/i, '电脑的端口没有应答'],
  [/\blost\b|disconnect|\bclosed\b/i, '连接被对端关闭'],
]

/** 中文和英文之间要留空格，和纯中文通道名之间不要。 */
function join(head: string, channel: string): string {
  return /[一-鿿]$/.test(head) && /^[A-Za-z0-9]/.test(channel) ? head + ' ' + channel : head + channel
}

function reasonCause(reason: string): string {
  const clean = reason.trim()
  if (!clean) return ''
  for (const [pattern, label] of REASON_LABELS) if (pattern.test(clean)) return label
  // 认不出来的原因原样带出：宁可难看，也好过把真实错误编成一个假的。
  return clean
}

export function readTransportDiag(): TransportDiag | null {
  if (typeof window === 'undefined') return null
  const raw = (window as unknown as { __coomiTransport?: Partial<TransportDiag> | null }).__coomiTransport
  if (!raw) return null
  if (!PHASES.includes(raw.phase as TransportPhase)) return null
  if (!STATES.includes(raw.state as ConnectionState)) return null
  return { phase: raw.phase as TransportPhase, state: raw.state as ConnectionState, reason: raw.reason ?? '' }
}

export function attributeTransport(diag: TransportDiag | null | undefined): TransportAttribution | null {
  if (!diag) return null
  const channel = CHANNEL_LABEL[diag.phase]
  if (diag.state === 'open') return { channel, detail: join('已通过', channel) + '连上', connected: true }
  const cause = reasonCause(diag.reason)
  const phrase = STATE_PHRASE[diag.state]
  const head = diag.state === 'connecting' ? join(phrase, channel) : join(channel, phrase)
  return { channel, detail: cause ? `${head}：${cause}` : head, connected: false }
}

/**
 * 把桥层诊断写进连接 store，但只在本机模式为「云端」时收：
 * 切回本机后，旧云端降级链的迟到定时器还会补发诊断事件，
 * 不在这里拒掉，本机模式的状态条就会顶着「正在尝试 加密中转」。
 */
export function applyTransportDiagTo(
  connection: { setTransport(diag: TransportDiag | null): void },
  mode: ConnectionMode,
): void {
  connection.setTransport(mode === 'cloud' ? readTransportDiag() : null)
}
