import type {
  RemoteDownloadChunk, RemoteDownloadComplete, RemoteDownloadDescriptor, RemoteDownloadStart,
  RemoteFileAck, RemoteFileChunk, RemoteFileChunkAck, RemoteFileComplete, RemoteFileError,
  RemoteFileFinish, RemoteFileMessage, RemoteFileReady, RemoteFileStart,
  UploadChunkResponse, UploadFinishResponse, UploadProgress, UploadStartResponse,
} from '../protocol/remote'
import { ENGINE_UPLOAD_CHUNK_BYTES as ENGINE_CHUNK, ENGINE_UPLOAD_LIMIT_BYTES as MAX_UPLOAD, REMOTE_FILE_CHUNK_BYTES as DATA_CHUNK } from '../protocol/remote'

export interface EngineFileApi {
  startUpload(body: { filename: string; size: number; sha256: string }): Promise<UploadStartResponse>
  putUploadChunk(uploadId: string, offset: number, bytes: Uint8Array): Promise<UploadChunkResponse>
  finishUpload(uploadId: string): Promise<UploadFinishResponse>
  download(path: string): Promise<{ blob: Blob; filename: string; mimeType: string }>
}
export interface EngineFileApiOptions { engineBase: string; engineToken: string; fetchImpl?: typeof fetch }
export interface TransferChannel { sendPayload(value: unknown): Promise<void>; onPayload(handler: (value: unknown) => void): () => void }

async function jsonRequest<T>(fetcher: typeof fetch, base: string, token: string, path: string, init: RequestInit): Promise<T> {
  const headers = new Headers(init.headers)
  headers.set('Authorization', 'Bearer ' + token)
  headers.set('Accept', 'application/json')
  const response = await fetcher(base + path, { ...init, headers })
  if (!response.ok) {
    let detail = String(response.status)
    try { const data = await response.json() as { error?: string; message?: string }; detail = data.error ?? data.message ?? detail } catch { /* not JSON */ }
    throw new Error('HTTP ' + response.status + ': ' + detail)
  }
  return response.json() as Promise<T>
}

/** This adapter belongs to the host only and authenticates with its engine token. */
export function createEngineFileApi(options: EngineFileApiOptions): EngineFileApi {
  const base = options.engineBase.replace(/\/$/, '')
  const token = options.engineToken.trim()
  const fetcher = options.fetchImpl ?? fetch
  if (!base || !token) throw new Error('Host engine base and engine Bearer token are required')
  return {
    startUpload(body) {
      return jsonRequest(fetcher, base, token, '/api/device/uploads/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
    },
    putUploadChunk(uploadId, offset, bytes) {
      const raw = Uint8Array.from(bytes).buffer
      return jsonRequest(fetcher, base, token, '/api/device/uploads/' + encodeURIComponent(uploadId) + '/chunk?offset=' + offset, {
        method: 'PUT', headers: { 'Content-Type': 'application/octet-stream' }, body: raw,
      })
    },
    finishUpload(uploadId) {
      return jsonRequest(fetcher, base, token, '/api/device/uploads/' + encodeURIComponent(uploadId) + '/finish', { method: 'POST' })
    },
    async download(path) {
      const response = await fetcher(base + '/api/fs/download?path=' + encodeURIComponent(path), {
        headers: { Authorization: 'Bearer ' + token },
      })
      if (!response.ok) throw new Error('Download failed: HTTP ' + response.status)
      const disposition = response.headers.get('Content-Disposition') ?? ''
      const utf8 = disposition.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
      const plain = disposition.match(/filename="?([^";]+)"?/i)?.[1]
      const filename = utf8 ? decodeURIComponent(utf8) : plain ?? path.split(/[\\/]/).pop() ?? 'download.bin'
      return { blob: await response.blob(), filename, mimeType: response.headers.get('Content-Type') ?? 'application/octet-stream' }
    },
  }
}

interface UploadState {
  uploadId: string
  expectedSize: number
  expectedSha256: string
  received: number
  serverOffset: number
  pieces: Uint8Array[]
  buffered: number
}
interface DownloadState {
  filename: string
  mimeType: string
  size: number
  sha256: string
  received: number
  chunks: Uint8Array[]
}
interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}
function b64(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}
function fromB64(value: string): Uint8Array {
  const binary = atob(value)
  return Uint8Array.from(binary, char => char.charCodeAt(0))
}
function isRemoteFileMessage(value: unknown): value is RemoteFileMessage {
  return typeof value === 'object' && value !== null && 'type' in value && typeof value.type === 'string' && value.type.startsWith('file_')
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : 'File transfer failed' }
async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

/** Upload/download protocol over an encrypted RemoteSyncTransport payload channel. */
export class RemoteFileTransfer {
  private readonly pending = new Map<string, Deferred<RemoteFileMessage>>()
  private readonly uploads = new Map<string, UploadState>()
  private readonly downloads = new Map<string, DownloadState>()
  private readonly unsubscribe: () => void
  private readonly listeners = new Set<(message: RemoteFileMessage) => void>()
  private receiveQueue: Promise<void> = Promise.resolve()
  constructor(private readonly channel: TransferChannel, private readonly options: {
    engineApi?: EngineFileApi
    authorizeDownload?: (path: string) => boolean | Promise<boolean>
    requestTimeoutMs?: number
  } = {}) {
    this.unsubscribe = channel.onPayload(value => {
      if (!isRemoteFileMessage(value)) return
      this.receiveQueue = this.receiveQueue.then(() => this.receive(value)).catch(error => console.warn('[remote-files] frame rejected:', errorMessage(error)))
    })
  }
  close(): void {
    this.unsubscribe()
    for (const deferred of this.pending.values()) {
      clearTimeout(deferred.timer)
      deferred.reject(new Error('File transfer channel closed'))
    }
    this.pending.clear(); this.uploads.clear(); this.downloads.clear(); this.listeners.clear()
  }
  onMessage(handler: (message: RemoteFileMessage) => void): () => void {
    this.listeners.add(handler)
    return () => this.listeners.delete(handler)
  }
  async upload(file: Blob, filename: string, onProgress?: (progress: UploadProgress) => void): Promise<Omit<UploadFinishResponse, 'upload_id'>> {
    if (file.size > MAX_UPLOAD) throw new Error('File exceeds 100 MiB limit')
    const whole = await file.arrayBuffer()
    const hash = await sha256(whole)
    const transferId = crypto.randomUUID()
    const readyPromise = this.waitFor(transferId, 'file_upload_ready')
    const start: RemoteFileStart = {
      type: 'file_upload_start', transferId,
      descriptor: { filename, size: file.size, mimeType: file.type || 'application/octet-stream', lastModified: undefined },
      sha256: hash,
    }
    await this.channel.sendPayload(start)
    const ready = await readyPromise as RemoteFileReady
    if (ready.chunkSize !== ENGINE_CHUNK || ready.maxSize > MAX_UPLOAD) throw new Error('Host upload limits do not match client protocol')
    let offset = 0
    while (offset < file.size) {
      const bytes = new Uint8Array(await file.slice(offset, Math.min(file.size, offset + DATA_CHUNK)).arrayBuffer())
      const ackPromise = this.waitFor(transferId, 'file_upload_chunk_ack')
      const chunk: RemoteFileChunk = { type: 'file_upload_chunk', transferId, offset, data: b64(bytes) }
      await this.channel.sendPayload(chunk)
      const ack = await ackPromise as RemoteFileChunkAck
      if (ack.nextOffset <= offset || ack.nextOffset > file.size) throw new Error('Invalid upload offset acknowledgement')
      offset = ack.nextOffset
      onProgress?.({ loaded: offset, total: file.size, percent: file.size ? offset * 100 / file.size : 100 })
    }
    const completePromise = this.waitFor(transferId, 'file_upload_complete')
    const finish: RemoteFileFinish = { type: 'file_upload_finish', transferId, uploadId: ready.uploadId }
    await this.channel.sendPayload(finish)
    const complete = await completePromise as RemoteFileComplete
    return complete.result
  }
  async download(path: string, onProgress?: (progress: UploadProgress) => void): Promise<{ blob: Blob; filename: string; mimeType: string }> {
    const transferId = crypto.randomUUID()
    const descriptorPromise = this.waitFor(transferId, 'file_download_descriptor')
    const completePromise = this.waitFor(transferId, 'file_download_complete')
    const start: RemoteDownloadStart = { type: 'file_download_start', transferId, path }
    await this.channel.sendPayload(start)
    const descriptor = await descriptorPromise as RemoteDownloadDescriptor
    if (descriptor.size > MAX_UPLOAD || descriptor.chunkSize !== DATA_CHUNK) throw new Error('Download limits do not match protocol')
    const completed = await completePromise as RemoteDownloadComplete
    const state = this.downloads.get(transferId)
    if (!state || completed.transferId !== transferId || state.received !== descriptor.size) throw new Error('Downloaded file is incomplete')
    const result = new Uint8Array(state.size)
    let offset = 0
    for (const chunk of state.chunks) { result.set(chunk, offset); offset += chunk.length }
    if (await sha256(result.buffer) !== state.sha256) throw new Error('Downloaded file SHA-256 mismatch')
    this.downloads.delete(transferId)
    onProgress?.({ loaded: state.size, total: state.size, percent: 100 })
    return { blob: new Blob([result], { type: state.mimeType }), filename: state.filename, mimeType: state.mimeType }
  }
  private waitFor(transferId: string, type: RemoteFileMessage['type']): Promise<RemoteFileMessage> {
    const key = transferId + ':' + type
    const previous = this.pending.get(key)
    if (previous) { clearTimeout(previous.timer); previous.reject(new Error('Duplicate transfer wait')) }
    let resolve!: (message: RemoteFileMessage) => void
    let reject!: (error: Error) => void
    const promise = new Promise<RemoteFileMessage>((yes, no) => { resolve = yes; reject = no })
    const timer = setTimeout(() => { this.pending.delete(key); reject(new Error('File transfer timed out: ' + type)) }, this.options.requestTimeoutMs ?? 30_000)
    this.pending.set(key, { promise, resolve, reject, timer })
    return promise
  }
  private resolveWait(transferId: string, message: RemoteFileMessage): boolean {
    const key = transferId + ':' + message.type
    const waiter = this.pending.get(key)
    if (!waiter) return false
    clearTimeout(waiter.timer); this.pending.delete(key); waiter.resolve(message); return true
  }
  private async receive(message: RemoteFileMessage): Promise<void> {
    for (const listener of this.listeners) listener(message)
    if (message.type === 'file_error') {
      for (const [key, waiter] of this.pending) if (key.startsWith(message.transferId + ':')) { clearTimeout(waiter.timer); this.pending.delete(key); waiter.reject(new Error(message.message)) }
      return
    }
    if (message.type === 'file_download_descriptor') {
      this.downloads.set(message.transferId, { filename: message.filename, mimeType: message.mimeType, size: message.size, sha256: message.sha256, received: 0, chunks: [] })
      this.resolveWait(message.transferId, message)
      return
    }
    if (this.resolveWait(message.transferId, message)) return
    if (message.type === 'file_download_start' && this.options.engineApi) { void this.startHostDownload(message); return }
    if (message.type === 'file_upload_start') return this.startHostUpload(message)
    if (message.type === 'file_upload_chunk') return this.acceptHostUploadChunk(message)
    if (message.type === 'file_upload_finish') return this.finishHostUpload(message)
    if (message.type === 'file_download_chunk') return this.acceptDownloadChunk(message)
  }
  private async startHostUpload(message: RemoteFileStart): Promise<void> {
    const api = this.options.engineApi
    if (!api) return this.sendError(message.transferId, 'Host upload API unavailable')
    try {
      if (message.descriptor.size > MAX_UPLOAD || !/^[a-f0-9]{64}$/i.test(message.sha256)) throw new Error('Invalid file descriptor')
      const started = await api.startUpload({ filename: message.descriptor.filename, size: message.descriptor.size, sha256: message.sha256 })
      this.uploads.set(message.transferId, { uploadId: started.upload_id, expectedSize: message.descriptor.size, expectedSha256: message.sha256, received: 0, serverOffset: 0, pieces: [], buffered: 0 })
      const ready: RemoteFileReady = { type: 'file_upload_ready', transferId: message.transferId, uploadId: started.upload_id, chunkSize: started.chunk_size, maxSize: started.max_size }
      await this.channel.sendPayload(ready)
    } catch (error) { await this.sendError(message.transferId, errorMessage(error)) }
  }
  private async acceptHostUploadChunk(message: RemoteFileChunk): Promise<void> {
    const state = this.uploads.get(message.transferId); const api = this.options.engineApi
    try {
      if (!state || !api) throw new Error('Upload session not found')
      if (message.offset !== state.received) throw new Error('Unexpected upload offset')
      const bytes = fromB64(message.data)
      if (!bytes.length || bytes.length > DATA_CHUNK || state.received + bytes.length > state.expectedSize) throw new Error('Invalid upload chunk size')
      state.pieces.push(bytes); state.buffered += bytes.length; state.received += bytes.length
      if (state.buffered === ENGINE_CHUNK || state.received === state.expectedSize) {
        const joined = new Uint8Array(state.buffered); let cursor = 0
        for (const piece of state.pieces) { joined.set(piece, cursor); cursor += piece.length }
        const result = await api.putUploadChunk(state.uploadId, state.serverOffset, joined)
        state.pieces = []; state.buffered = 0; state.serverOffset = result.next_offset
      }
      const ack: RemoteFileChunkAck = { type: 'file_upload_chunk_ack', transferId: message.transferId, nextOffset: state.received, loaded: state.received, total: state.expectedSize }
      await this.channel.sendPayload(ack)
    } catch (error) { await this.sendError(message.transferId, errorMessage(error)) }
  }
  private async finishHostUpload(message: RemoteFileFinish): Promise<void> {
    const state = this.uploads.get(message.transferId); const api = this.options.engineApi
    try {
      if (!state || !api || message.uploadId !== state.uploadId || state.received !== state.expectedSize || state.serverOffset !== state.expectedSize) throw new Error('Upload is incomplete')
      const result = await api.finishUpload(state.uploadId); this.uploads.delete(message.transferId)
      const complete: RemoteFileComplete = { type: 'file_upload_complete', transferId: message.transferId, result: { ok: result.ok, filename: result.filename, path: result.path, size: result.size, sha256: result.sha256 } }
      await this.channel.sendPayload(complete)
    } catch (error) { await this.sendError(message.transferId, errorMessage(error)) }
  }
  private async startHostDownload(message: RemoteDownloadStart): Promise<void> {
    const api = this.options.engineApi
    try {
      if (!api || !this.options.authorizeDownload || !await this.options.authorizeDownload(message.path)) throw new Error('Host did not authorize this download')
      const file = await api.download(message.path); if (file.blob.size > MAX_UPLOAD) throw new Error('File exceeds transfer limit')
      const content = await file.blob.arrayBuffer(); const hash = await sha256(content)
      const descriptor: RemoteDownloadDescriptor = { type: 'file_download_descriptor', transferId: message.transferId, filename: file.filename, size: file.blob.size, mimeType: file.mimeType, sha256: hash, chunkSize: DATA_CHUNK }
      await this.channel.sendPayload(descriptor)
      for (let offset = 0; offset < content.byteLength; offset += DATA_CHUNK) {
        const ackPromise = this.waitFor(message.transferId, 'file_transfer_ack')
        const chunk: RemoteDownloadChunk = { type: 'file_download_chunk', transferId: message.transferId, offset, data: b64(new Uint8Array(content.slice(offset, Math.min(offset + DATA_CHUNK, content.byteLength)))) }
        await this.channel.sendPayload(chunk)
        const ack = await ackPromise as RemoteFileAck
        if (ack.offset !== Math.min(offset + DATA_CHUNK, content.byteLength)) throw new Error('Invalid download acknowledgement')
      }
      await this.channel.sendPayload({ type: 'file_download_complete', transferId: message.transferId } satisfies RemoteDownloadComplete)
    } catch (error) { await this.sendError(message.transferId, errorMessage(error)) }
  }
  private async acceptDownloadChunk(message: RemoteDownloadChunk): Promise<void> {
    const state = this.downloads.get(message.transferId)
    try {
      if (!state || message.offset !== state.received) throw new Error('Unexpected download offset')
      const bytes = fromB64(message.data)
      if (!bytes.length || bytes.length > DATA_CHUNK || state.received + bytes.length > state.size) throw new Error('Invalid download chunk')
      state.chunks.push(bytes); state.received += bytes.length
      const ack: RemoteFileAck = { type: 'file_transfer_ack', transferId: message.transferId, offset: state.received }
      await this.channel.sendPayload(ack)
    } catch (error) { await this.sendError(message.transferId, errorMessage(error)) }
  }
  private async sendError(transferId: string, message: string): Promise<void> {
    const error: RemoteFileError = { type: 'file_error', transferId, message }
    await this.channel.sendPayload(error)
  }
}
