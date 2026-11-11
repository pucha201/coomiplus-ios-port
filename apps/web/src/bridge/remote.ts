import type { DeviceInfoResponse, EngineEndpoint, PairingResponse, P2pSecretResponse } from '../protocol/remote'
import { normalizeEngineBaseUrl } from '../protocol/remote'

export interface RemoteClientOptions { engineBase: string; engineToken?: string; fetchImpl?: typeof fetch }

/** Typed control-plane client. Tokens are only sent as Authorization headers. */
export class RemoteConnectionClient {
  readonly engineBase: string
  private readonly engineToken: string
  private readonly fetchImpl: typeof fetch
  constructor(options: RemoteClientOptions) {
    this.engineBase = normalizeEngineBaseUrl(options.engineBase)
    this.engineToken = options.engineToken?.trim() ?? ''
    this.fetchImpl = options.fetchImpl ?? fetch
    if (!this.engineBase) throw new Error('远程 engine base URL 无效')
  }
  private async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('Accept', 'application/json')
    if (this.engineToken) headers.set('Authorization', 'Bearer ' + this.engineToken)
    const response = await this.fetchImpl(this.engineBase + path, { ...init, headers })
    if (!response.ok) {
      let detail = String(response.status)
      try { const data = await response.json() as { error?: string; message?: string }; detail = data.error ?? data.message ?? detail } catch { /* non JSON */ }
      throw new Error((init.method ?? 'GET') + ' ' + path + ' → ' + detail)
    }
    return response.json() as Promise<T>
  }
  getDeviceInfo(): Promise<DeviceInfoResponse> { return this.request('/api/device/info') }
  pair(code: string, name?: string): Promise<PairingResponse> {
    return this.request('/api/device/pair', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: code.trim(), name }) })
  }
  getPeerP2pSecret(peerId: string): Promise<P2pSecretResponse> { return this.request('/api/device/peers/' + encodeURIComponent(peerId) + '/p2p-secret') }
  getEngineStatus(): Promise<EngineEndpoint> {
    return this.getDeviceInfo().then(info => ({ engineBase: info.engineBase ?? this.engineBase, maskedToken: info.maskedToken, tokenConfigured: info.tokenConfigured ?? Boolean(this.engineToken), checkedAt: Date.now() }))
  }

}

export function createLocalConnectionClient(): RemoteConnectionClient | null {
  const engineBase = typeof location !== 'undefined' ? location.origin : ''
  return engineBase ? new RemoteConnectionClient({ engineBase }) : null
}
