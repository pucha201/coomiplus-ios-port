/**
 * 手机更新通道（检查 → 下载 → 安装引导）。
 *
 * 职责划分：
 *  - 「检查」在前端完成：WebView fetch 直连 GitHub Releases API（api.github.com），
 *    失败时回退 gh-proxy 前缀；过滤 mobile-v* 标签、按 semver 与当前安装版本比较。
 *  - 「下载 + 校验 + 安装」全部交给 Android 原生：DownloadManager（gh-proxy 加速）→
 *    流式 SHA-256 校验（release notes 里的值）→ FileProvider + ACTION_VIEW 安装器。
 *    前端只发起请求、并监听原生回报的进度/结果事件（coomi:update-progress / -result）。
 */
export const UPDATE_REPO = 'pucha201/coomiplus-updates'
/** GitHub Releases API：WebView 直连。 */
export const GITHUB_RELEASES_API = `https://api.github.com/repos/${UPDATE_REPO}/releases`
/** 直连失败时的 API 回退（gh-proxy 同时代理 api.github.com，已验证可访问）。 */
export const GH_PROXY_API = `https://gh-proxy.com/${GITHUB_RELEASES_API}`
/** 下载加速直链前缀：原生 DownloadManager 用它拼 ${tag}/${asset}。 */
export const GH_PROXY_DOWNLOAD_PREFIX = `https://gh-proxy.com/https://github.com/${UPDATE_REPO}/releases/download`

export interface MobileReleaseAsset {
  name: string
  browser_download_url: string
  digest?: string
  size?: number
}

export interface MobileRelease {
  tag_name: string
  prerelease: boolean
  draft: boolean
  published_at: string
  body: string
  assets: MobileReleaseAsset[]
}

/** 单个 mobile 更新的完整信息（前端与原生桥共享的“契约”）。 */
export interface UpdateInfo {
  /** release 标签，如 mobile-v1.6.11 */
  tag: string
  /** 去掉 mobile-v 前缀的语义版本，如 1.6.11 */
  version: string
  /** release notes 原文（含 SHA-256 行与更新说明） */
  notes: string
  /** 下载文件名，如 coomi-app_1.6.11_arm64-v8a.apk */
  assetName: string
  /** 小写 SHA-256（取自 release notes，回退资产 digest） */
  sha256: string
  size?: number
  publishedAt?: string
}

export interface CheckResult {
  ok: boolean
  error?: string
  hasUpdate: boolean
  /** 当前安装版本（无原生桥时为 null） */
  currentVersion?: string | null
  update?: UpdateInfo
}

/** 原生回报的下载/安装进度（state 见 UpdateChecker 的 emit）。 */
export interface UpdateProgress {
  state: 'downloading' | 'verifying' | 'install-permission' | 'installing' | 'error' | string
  progress: number
  message?: string
}

// ── 语义版本比较 ──

export interface SemVer { major: number; minor: number; patch: number; rc?: number }

/** 解析 "1.6.10" / "mobile-v1.6.10" / "v1.6.10" 为 SemVer；不合法返回 null。 */
export function parseSemVer(input: string | null | undefined): SemVer | null {
  if (!input) return null
  const m = input.match(/(?:mobile-?v|v)?(\d+)\.(\d+)\.(\d+)(?:-rc(\d+))?/i)
  if (!m) return null
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]), rc: m[4] ? Number(m[4]) : undefined }
}

/** a > b → 1；相等 → 0；a < b → -1。 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major > b.major ? 1 : -1
  if (a.minor !== b.minor) return a.minor > b.minor ? 1 : -1
  if (a.patch !== b.patch) return a.patch > b.patch ? 1 : -1
  const ar = a.rc ?? Infinity
  const br = b.rc ?? Infinity
  if (ar !== br) return ar === Infinity ? 1 : br === Infinity ? -1 : ar > br ? 1 : -1
  return 0
}

/** 从 release notes 提取 SHA-256（大写十六进制），回退 GitHub 资产的 digest，统一返回小写。 */
export function extractSha256(notes: string, asset?: MobileReleaseAsset): string {
  const m = (notes ?? '').match(/sha-?256\s*[:：]\s*([0-9a-fA-F]{64})/)
  if (m) return m[1].toLowerCase()
  const d = asset?.digest?.match(/sha256:([0-9a-fA-F]{64})/)
  if (d) return d[1].toLowerCase()
  return ''
}

/** 按渠道过滤 mobile-v* 标签取最新：beta（默认）含 -rc 测试版；release 只看无 -rc 的正式版。 */
export function pickLatestMobileRelease(releases: MobileRelease[], channel: 'beta' | 'release' = 'beta'): UpdateInfo | null {
  const candidates: { release: MobileRelease; ver: SemVer }[] = []
  for (const r of releases ?? []) {
    if (!r.tag_name || !r.tag_name.startsWith('mobile-v')) continue
    if (r.draft) continue
    const isRc = /-rc\d+/i.test(r.tag_name)
    if (channel === 'release' && isRc) continue
    const ver = parseSemVer(r.tag_name)
    if (!ver) continue
    candidates.push({ release: r, ver })
  }
  if (candidates.length === 0) return null
  candidates.sort((a, b) => compareSemVer(b.ver, a.ver))
  const best = candidates[0]
  const asset = best.release.assets?.find(a => a.name?.endsWith('.apk') && /arm64-v8a/.test(a.name))
  if (!asset) return null
  return {
    tag: best.release.tag_name,
    // version 必须带 rc 后缀：否则 tag 1.6.7-rc8 被存成 1.6.7，与已装的 1.6.7-rc8 比较时
    // 会被当成「正式版 > 预发布」→ 永远提示有更新（2026-10-04 实锤）。
    version: best.ver.rc != null
      ? `${best.ver.major}.${best.ver.minor}.${best.ver.patch}-rc${best.ver.rc}`
      : `${best.ver.major}.${best.ver.minor}.${best.ver.patch}`,
    notes: best.release.body ?? '',
    assetName: asset.name,
    sha256: extractSha256(best.release.body ?? '', asset),
    size: asset.size,
    publishedAt: best.release.published_at,
  }
}

/** 去掉 release notes 里的 SHA-256 行，只留给人看的更新说明。 */
export function readableNotes(notes: string): string {
  return (notes ?? '')
    .split(/\r?\n/)
    .filter(line => !/^\s*sha-?256\s*[:：]/i.test(line))
    .join('\n')
    .trim()
}

// ── 取数 ──

async function fetchReleasesJson(): Promise<MobileRelease[]> {
  let lastError: unknown
  for (const [url, label] of [[GITHUB_RELEASES_API, '直连'], [GH_PROXY_API, 'gh-proxy']] as const) {
    try {
      const ctrl = new AbortController()
      const timer = setTimeout(() => ctrl.abort(), 12000)
      const res = await fetch(url, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'coomi-mobile-updater' },
        signal: ctrl.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`${label} → HTTP ${res.status}`)
      const data = (await res.json()) as unknown
      if (!Array.isArray(data)) throw new Error(`${label} → 响应格式错误`)
      return data as MobileRelease[]
    } catch (e) {
      lastError = e
      // 直连失败（超时/被墙）→ 换 gh-proxy 再试一次
    }
  }
  throw lastError instanceof Error ? lastError : new Error('获取更新信息失败')
}

/** 当前安装版本：优先原生桥 getAppVersionName()（Android WebView），否则 null。 */
export function getCurrentVersion(): string | null {
  const bridge = window.CoomiAndroid
  if (bridge && typeof bridge.getAppVersionName === 'function') {
    try {
      const v = String(bridge.getAppVersionName() ?? '').trim()
      if (v) return v
    } catch { /* 桥异常按无版本处理 */ }
  }
  return null
}

/** 是否手机宿主（WebView 里有下载桥）：桌面/浏览器环境返回 false。 */
export function isMobileHost(): boolean {
  const bridge = window.CoomiAndroid
  return Boolean(bridge && typeof bridge.downloadUpdate === 'function')
}

/** 更新渠道偏好：beta（默认，含 -rc 测试版）/ release（只看正式版）。localStorage 持久化。 */
export function getUpdateChannel(): 'beta' | 'release' {
  try {
    return window.localStorage.getItem('coomi.updateChannel') === 'release' ? 'release' : 'beta'
  } catch {
    return 'beta'
  }
}

export function setUpdateChannel(channel: 'beta' | 'release'): void {
  try { window.localStorage.setItem('coomi.updateChannel', channel) } catch { /* ignore */ }
}

/** 自动更新开关：开（默认）= 有更新自动提醒；关 = 只手动检查。localStorage 持久化。 */
export function getAutoCheck(): boolean {
  try {
    return window.localStorage.getItem('coomi.autoCheck') !== 'off'
  } catch {
    return true
  }
}

export function setAutoCheck(on: boolean): void {
  try { window.localStorage.setItem('coomi.autoCheck', on ? 'on' : 'off') } catch { /* ignore */ }
}

/** 检查更新：取数 → 按渠道过滤 mobile-v*（beta 含 rc / release 只正式版）→ semver 与当前版本比较。 */
/** 渠道内全部 mobile-v* release：更新消息列表用（含 BETA/正式版标注）。按版本号降序。 */
export async function listChannelReleases(channel: 'beta' | 'release' = getUpdateChannel()): Promise<Array<{ tag: string; version: string; notes: string; isBeta: boolean; publishedAt?: string }>> {
  try {
    const releases = await fetchReleasesJson()
    const out: Array<{ tag: string; version: string; notes: string; isBeta: boolean; publishedAt?: string }> = []
    for (const r of releases ?? []) {
      if (!r.tag_name || !r.tag_name.startsWith('mobile-v')) continue
      if (r.draft) continue
      const ver = parseSemVer(r.tag_name)
      if (!ver) continue
      const isBeta = /-rc\d+/i.test(r.tag_name)
      if (channel === 'release' && isBeta) continue
      out.push({
        tag: r.tag_name,
        version: ver.rc != null ? ver.major + "." + ver.minor + "." + ver.patch + "-rc" + ver.rc : ver.major + "." + ver.minor + "." + ver.patch,
        notes: readableNotes(r.body ?? ''),
        isBeta,
        publishedAt: r.published_at,
      })
    }
    out.sort((a, b) => compareSemVer(parseSemVer(b.version)!, parseSemVer(a.version)!))
    return out
  } catch {
    return []
  }
}
export async function checkForUpdates(): Promise<CheckResult> {
  const currentVersion = getCurrentVersion()
  const current = currentVersion ? parseSemVer(currentVersion) : null
  if (!current) {
    return { ok: false, error: '无法获取当前版本（请通过手机端检查更新）', hasUpdate: false, currentVersion }
  }
  try {
    const releases = await fetchReleasesJson()
    const update = pickLatestMobileRelease(releases, getUpdateChannel())
    const hasUpdate = update !== null && compareSemVer(parseSemVer(update.version)!, current) > 0
    return { ok: true, hasUpdate, currentVersion, update: hasUpdate ? update : undefined }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e), hasUpdate: false, currentVersion }
  }
}

/** 发起「下载并安装」：全部交给原生（DownloadManager → SHA-256 校验 → 安装器）。 */
export function requestUpdateDownload(update: UpdateInfo): boolean {
  const bridge = window.CoomiAndroid
  if (bridge && typeof bridge.downloadUpdate === 'function') {
    bridge.downloadUpdate(update.tag, update.assetName, update.version, update.sha256)
    return true
  }
  return false
}

// ── 原生进度/结果事件（原生 → 前端）──

export type UpdateProgressListener = (progress: UpdateProgress) => void
export type UpdateResultListener = (result: { state: string; message?: string }) => void

export function subscribeUpdateProgress(listener: UpdateProgressListener): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail ?? {}
    listener({
      state: String(detail.state ?? ''),
      progress: Number(detail.progress ?? 0),
      message: detail.message ? String(detail.message) : undefined,
    })
  }
  window.addEventListener('coomi:update-progress', handler)
  return () => window.removeEventListener('coomi:update-progress', handler)
}

export function subscribeUpdateResult(listener: UpdateResultListener): () => void {
  const handler = (e: Event) => {
    const detail = (e as CustomEvent).detail ?? {}
    listener({ state: String(detail.state ?? ''), message: detail.message ? String(detail.message) : undefined })
  }
  window.addEventListener('coomi:update-result', handler)
  return () => window.removeEventListener('coomi:update-result', handler)
}

// ── 启动静默检查（有新版本才提示）──

let startupChecked = false

/**
 * 启动时静默查一次：仅手机宿主执行；有新版本且用户未对同版本点过「稍后」时，
 * 广播 coomi:update-available（由 App.vue 的 UpdatePrompt 展示提示）。
 */
export async function runStartupUpdateCheck(): Promise<void> {
  if (startupChecked) return
  startupChecked = true
  if (!isMobileHost()) return
  // 自动更新开关：关 = 不自动提醒，只手动检查（更新页里点「检查更新」）。
  if (!getAutoCheck()) return
  const result = await checkForUpdates()
  if (!result.ok || !result.hasUpdate || !result.update) return
  let dismissed = ''
  try { dismissed = localStorage.getItem('coomi.updater.dismissed') ?? '' } catch { /* 隐私模式忽略 */ }
  if (dismissed === result.update.version) return
  window.dispatchEvent(new CustomEvent('coomi:update-available', { detail: { update: result.update } }))
}

/** 记住用户对某个版本点过「稍后」：同版本不再打扰。 */
export function dismissUpdatePrompt(version: string): void {
  try { localStorage.setItem('coomi.updater.dismissed', version) } catch { /* 忽略 */ }
}
