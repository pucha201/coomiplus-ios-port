/// <reference types="vite/client" />

interface Window {
  /** 返回 true = 已消费；'exit' = 在栈根，请原生结束应用；false/undefined = 交给原生兜底。 */
  __coomiHandleSystemBack?: () => boolean | 'exit'
  __coomiApplyAppearance?: (config: AppearanceConfig) => void
  CoomiAndroid?: {
    openDashboard(): void
    /** 引擎访问令牌（重载后兜底）。 */
    getEngineToken?(): string
    /** 结束当前 WebView 宿主（从原生进来的页面，系统返回时用）。 */
    finishSelf?(): void
    /** 运行环境（auto/termux/proot/host）。 */
    getEnvMode?(): string
    setEnvMode?(mode: string): void
    /** 系统入口。 */
    openNotificationSettings?(): void
    requestBatteryExemption?(): void
    openAppInfo?(): void
    /** 打开原生设置页（承接原网页设置页全部入口）。 */
    openSettings?(): void
    /** 原生设置页里改过的对话页设置（JSON）。 */
    getChatSettings?(): string
    /** 网页侧改动写回原生设置。 */
    setChatSetting?(key: string, value: string): void
    importFiles?(): void
    importFilesForRequest?(requestId: string): void
    authorizeFolder?(): void
    /** 只选择目录路径（协同工作台工作目录），结果经 coomi:folder-selected 事件回传。 */
    pickDirectory?(): void
    /** 是否已授权手机存储权限（普通路径可访问）。 */
    hasStoragePermission?(): boolean
    /** 打开系统的存储权限设置页。 */
    openStorageSettings?(): void
    exportFile?(path: string, suggestedName: string): void
    exportFileForRequest?(requestId: string, path: string, suggestedName: string): void
    openFile?(path: string): void
    /** 保存图片（data URL）到相册或下载目录。 */
    saveImageData?(dataUrl: string, fileName: string): void
    /** 保存任意二进制（base64）：云端模式文件在电脑上，本地没有路径可导出时用它落盘。 */
    saveFileData?(base64: string, fileName: string, mime: string): void
    /** 当前 IME 垫高（CSS px）：页面重载时拉一次初值，之后由 __coomiImeInset 推送。 */
    getImeInsetCss?(): number
    /**
     * 键盘跟随是否走 transform：新壳返回 true（原生不再压缩 WebView，
     * 只推 --kb-inset）。老壳没有这个方法，前端继续沿用「原生 resize」。
     */
    usesImeTransform?(): boolean
    /** 通知原生层任务运行状态（更新通知栏：执行中 / 已完成）。 */
    updateTaskStatus?(status: string): void
    /** 1.4.5 后台任务通知协议，携带会话定位信息。 */
    updateTaskStatusDetails?(status: string, sessionId: string, background: boolean): void
    /** HyperOS 超级岛/增强任务通知：JSON payload，非小米机型自动降级普通通知。 */
    updateTaskIsland?(json: string): void
    /** 获取设备与 App 诊断信息（报错反馈使用，不含对话内容）。 */
    getDiagnostics?(): string
    /** 原生上报报错反馈（绕过 WebView CORS）：json 为反馈体，callbackId 用于异步回调。 */
    sendFeedback?(json: string, callbackId: string): void
    getThemeMode?(): string
    setThemeMode?(mode: string): void
    getDigitalLifeEnabled?(): boolean
    setDigitalLifeEnabled?(enabled: boolean): void
    getAppearanceConfig?(): string
    /** 当前安装的 versionCode（检查更新页对比用）。 */
    getAppVersionCode?(): number
    /** 当前安装的 versionName（如 1.6.10）：检查更新 semver 比较用。 */
    getAppVersionName?(): string
    /** 下载并安装更新 APK（url 为 APK 直链，version 用于文件名/提示；旧桥，兼容旧 web bundle）。 */
    installApk?(url: string, version: string): void
    /**
     * 下载并安装更新（新版桥）：原生用 gh-proxy 前缀拼直链走 DownloadManager，
     * 完成后流式校验 SHA-256（release notes 里的值）→ FileProvider 拉起系统安装器。
     * 进度经 coomi:update-progress / coomi:update-result 事件回传。
     */
    downloadUpdate?(tag: string, asset: string, version: string, sha256: string): void
    /** 系统浏览器打开 URL。 */
    openUrl?(url: string): void
    /** 系统通知 + 点开续聊。 */
    notifyUser?(title: string, body: string, sessionId?: string): void
    /** P0-4 语音输入：开始聆听（需麦克风权限，结果经 coomi:voice-result/partial/error 回传）。 */
    startVoiceInput?(): void
    /** 结束聆听并触发最终识别；cancel=true（上滑取消）时丢弃结果。 */
    stopVoiceInput?(cancel: boolean | string): void
    /** 语音引擎配置全景 JSON（engine/cloud/voskReady/systemAvailable）。 */
    getVoiceConfig?(): string
    /** 选择语音引擎：vosk（离线）/ cloud（云模型）/ system（系统服务）。 */
    setVoiceEngine?(engine: string): void
    /** 保存云语音配置 JSON：{ baseUrl, key, model }。 */
    setVoiceCloud?(json: string): void
    /** 系统 TTS 是否可用。 */
    isTtsAvailable?(): boolean
    /** 本地 TTS 朗读。rate 0.5–2，默认 1。 */
    speak?(text: string, rate?: number): void
    stopSpeak?(): void

    /* ── 配对与远程连接（原生 AndroidBridge 已实现，网页此前未声明） ── */
    /** 打开系统扫码器；结果经 coomi:qr-scan-result 事件回传。 */
    scanQrCode?(): void
    startQrScan?(): void
    /** 当前远程连接快照（JSON: selectedDevice / engineBase / engineToken）。 */
    getRemoteConnection?(): string
    /** 写入远程连接（JSON）。 */
    setRemoteConnection?(json: string): boolean
    /** 清除 endpoint 与 token。 */
    clearRemoteConnection?(): boolean
    /** 是否支持直连通道。 */
    supportsDirectTransport?(): boolean
    /** 向引擎透传一条命令。 */
    sendEngineCommand?(command: string): void

    /* ── 本机共享、启动首页 ── */
    /** 本机引擎是否允许局域网连接。 */
    getLanAccess?(): boolean
    setLanAccess?(enabled: boolean): void
    /** 启动首页：'chat' | 'dashboard'。 */
    getHomeRoute?(): string
    setHomeRoute?(route: string): void

    /* ── 文件与剪贴板 ── */
    /** 文件字节数；读不到返回 -1。 */
    getFileSize?(path: string): number
    /** 系统图片选择器（结果经 coomi:files-imported 事件回传）。 */
    pickImage?(): void
    /** 复制文本到系统剪贴板。 */
    copyText?(text: string): void
    /** 申请存储权限（结果经 coomi:storage-permission 事件回传）。 */
    ensureStoragePermission?(): void

    /* ── 备份 ── */
    /** 备份状态（JSON：enabled / intervalHours / keep / lastRunAt / dirLabel / running）。 */
    backupGetState?(): string
    backupConfigure?(json: string): boolean
    /** 立即备份；进度经 coomi:backup-progress 事件回传。 */
    backupRunNow?(): void
    /** 选择备份目录（SAF）；结果经 coomi:folder-selected 事件回传。 */
    backupPickDirectory?(): void
    /** 从备份 zip 还原。 */
    backupRestore?(uri: string): void
  }
}

interface AppearanceConfig {
  customEnabled?: boolean
  colors?: Record<string, string>
  chatBackground?: boolean
  chatMask?: number
  revision?: number
}

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'

  export const DynamicScroller: DefineComponent
  export const DynamicScrollerItem: DefineComponent
}
