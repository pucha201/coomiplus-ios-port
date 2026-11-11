import type { AgentCommand, InboundEnvelope } from '../protocol/commands'
import type { UploadProgress } from '../protocol/remote'

export type ConnectionState = 'connecting' | 'reconnecting' | 'open' | 'closed' | 'error'

export interface ConnectionStatus {
  state: ConnectionState
  attempt?: number
  maxRetries?: number
  delayMs?: number
  reason?: string
}

export interface Transport {
  connect(): void
  close(): void
  send(command: AgentCommand): void
  onMessage(handler: (env: InboundEnvelope) => void): void
  onStateChange(handler: (status: ConnectionStatus) => void): void
  /** File transfer is available only on encrypted P2P DataChannels. */
  uploadFile?(file: Blob, filename: string, onProgress?: (progress: UploadProgress) => void): Promise<{ filename: string; size: number; sha256: string; path?: string }>
  downloadFile?(path: string, onProgress?: (progress: UploadProgress) => void): Promise<{ blob: Blob; filename: string; mimeType: string }>
  /** 引擎重启通知：强制立即重建 WS（可选，仅 WsTransport 实现）。 */
  forceReconnect?(): void
  /** 链路是否还「活着 / 会自动恢复」：connect() 幂等判断用（活着就跳过，不重建）。 */
  isAlive(): boolean
  /**
   * 命令是否会经过桌面宿主。
   *
   * `switch_session` 是宿主命令（宿主拿它切自己那条引擎 WS），引擎本身不认识。
   * LAN / 本机直连时对端就是引擎，发过去只会收到 `unsupported command`。
   */
  readonly hostCommands?: boolean
}
