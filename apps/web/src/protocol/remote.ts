/** Types shared by phone/desktop pairing, mirror, and file transfer clients. */

export type ConnectionMode = 'local' | 'cloud'
export type DeviceKind = 'desktop' | 'phone' | 'tablet' | 'browser' | 'unknown'
export type DeviceReachability = 'unknown' | 'online' | 'offline' | 'checking'

export interface EngineEndpoint {
  engineBase: string
  engineToken?: string
  maskedToken?: string
  tokenConfigured: boolean
  checkedAt?: number
  error?: string
}

export interface PairedDevice {
  id: string
  /** Pair-specific client identity issued by the host. */
  peerId?: string
  /** Per-peer bearer from QR; stays on the paired device and is never sent to MQTT. */
  pairingSecret?: string
  /** SHA-256(pairingSecret), used as P2P KDF input. */
  p2pSecretHash?: string
  name: string
  kind: DeviceKind
  engineBase: string
  engineToken?: string
  maskedToken?: string
  /** 电脑配置的中转/信令 broker：随配对码下发，双端必须连同一个才握得上手。 */
  brokerUrl?: string
  /** iroh EndpointAddr：存在时优先走 iroh QUIC 隧道，不再依赖 WebRTC/MQTT。
   *  relay/mode 是配对那一刻的中继快照：mode=direct 表示电脑当时只有局域网地址，
   *  跨网连不上时要如实提示「只能同网、去电脑上重新配对」。 */
  iroh?: {
    id?: string
    addr?: unknown
    relay?: string[]
    /**
     * relay  = 中继真的连上了，可跨网；
     * direct = 配对时没有中继，只能同 Wi-Fi；
     * relay_pending = 二维码里有中继地址但中继没就绪（新引擎如实标记）。
     */
    relayReady?: boolean
    mode?: 'relay' | 'direct' | 'relay_pending'
  } | null
  reachability: DeviceReachability
  /** 电脑端已经把这台手机 peer 记录删掉/撤销：需要重新扫码，不能再自动连接。 */
  remoteRevoked?: boolean
  lastSeenAt?: number
  /** 配对令牌过期时间（毫秒 epoch）；电脑端撤销/过期后必须重新扫码。 */
  expiresAt?: number
  createdAt: number
  updatedAt: number
}

export interface DeviceInfoResponse {
  id?: string
  name?: string
  kind?: DeviceKind
  engineBase?: string
  tokenConfigured?: boolean
  maskedToken?: string
  [key: string]: unknown
}
export interface DevicePeersResponse { peers: PairedDevice[]; activeDeviceId?: string | null }
export interface PairingResponse { device: PairedDevice; accepted: boolean }
export interface P2pSecretResponse { token_hash: string; expires_at?: number }

export interface MirrorHello {
  type: 'mirror_hello'
  version: 1
  deviceId: string
  sessionId?: string
  capabilities: { events: true; commands: false; files: boolean }
}
export interface MirrorEvent { type: 'mirror_event'; version: 1; seq: number; sessionId: string; event: unknown }
export interface MirrorAck { type: 'mirror_ack'; version: 1; seq: number }
export type MirrorMessage = MirrorHello | MirrorEvent | MirrorAck

export type RtcSignalType = 'offer' | 'answer' | 'ice'
export type RelayGuarantee = 'turn-configured' | 'not-guaranteed'
export interface RtcSignal { v: 1; frame: EncryptedSyncFrame }
export interface RtcSignalPayload { v: 1; room: string; from: string; to: string; type: RtcSignalType; sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }
export type AuthenticatedRtcSignal = RtcSignalPayload
export interface EncryptedSyncFrame {
  v: 1
  iv: string
  ciphertext: string
}

export interface P2PHttpRequest {
  kind: 'http:req'
  id: string
  method: string
  path: string
  headers: Record<string, string>
  body?: string
}
export interface P2PHttpResponse {
  kind: 'http:res'
  id: string
  status: number
  headers: Record<string, string>
  body?: string
  error?: string
}
export interface UploadDescriptor { filename: string; size: number; mimeType?: string; lastModified?: number }
export const REMOTE_FILE_CHUNK_BYTES = 32 * 1024
export const ENGINE_UPLOAD_CHUNK_BYTES = 512 * 1024
export const ENGINE_UPLOAD_LIMIT_BYTES = 100 * 1024 * 1024
export interface UploadProgress { loaded: number; total: number; percent: number }
export interface UploadStartResponse { upload_id: string; filename: string; chunk_size: number; max_size: number; received: number }
export interface UploadChunkResponse { upload_id: string; next_offset: number }
export interface UploadFinishResponse { ok: true; upload_id: string; filename: string; path: string; size: number; sha256: string }
export interface RemoteFileStart { type: 'file_upload_start'; transferId: string; descriptor: UploadDescriptor; sha256: string }
export interface RemoteFileReady { type: 'file_upload_ready'; transferId: string; uploadId: string; chunkSize: number; maxSize: number }
export interface RemoteFileChunk { type: 'file_upload_chunk'; transferId: string; offset: number; data: string }
export interface RemoteFileChunkAck { type: 'file_upload_chunk_ack'; transferId: string; nextOffset: number; loaded: number; total: number }
export interface RemoteFileFinish { type: 'file_upload_finish'; transferId: string; uploadId: string }
export interface RemoteFileComplete { type: 'file_upload_complete'; transferId: string; result: Omit<UploadFinishResponse, 'upload_id'> }
export interface RemoteFileError { type: 'file_error'; transferId: string; message: string }
export interface RemoteDownloadStart { type: 'file_download_start'; transferId: string; path: string }
export interface RemoteDownloadDescriptor { type: 'file_download_descriptor'; transferId: string; filename: string; size: number; mimeType: string; sha256: string; chunkSize: number }
export interface RemoteDownloadChunk { type: 'file_download_chunk'; transferId: string; offset: number; data: string }
export interface RemoteDownloadComplete { type: 'file_download_complete'; transferId: string }
export interface RemoteFileAck { type: 'file_transfer_ack'; transferId: string; offset: number }
export type RemoteFileMessage = RemoteFileStart | RemoteFileReady | RemoteFileChunk | RemoteFileChunkAck | RemoteFileFinish | RemoteFileComplete | RemoteFileError | RemoteDownloadStart | RemoteDownloadDescriptor | RemoteDownloadChunk | RemoteDownloadComplete | RemoteFileAck

export function normalizeEngineBaseUrl(value: string): string {
  const raw = value.trim()
  if (!raw) return ''
  try {
    const url = new URL(raw)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return ''
    return url.toString().replace(/\/$/, '')
  } catch { return '' }
}

export function maskToken(token: string | undefined): string {
  if (!token) return ''
  if (token.length <= 8) return '••••'
  return token.slice(0, 3) + '••••' + token.slice(-3)
}
