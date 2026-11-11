<script setup lang="ts">
/**
 * 检查更新页（#/updates）。
 *
 * 更新通道：GitHub Releases（pucha201/coomiplus-updates）的 mobile-v* 标签。
 *  - 取数：WebView fetch 直连 api.github.com，失败回退 gh-proxy；
 *  - 版本比较：semver（当前安装版本取原生桥 getAppVersionName）；
 *  - 下载/安装：点击后全部交给原生（DownloadManager + SHA-256 校验 + 安装器），
 *    进度/结果经 coomi:update-progress / coomi:update-result 事件回传。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import { goBack } from '@/bridge/navigation'
import {
  checkForUpdates, requestUpdateDownload, subscribeUpdateProgress, subscribeUpdateResult, readableNotes, isMobileHost, getCurrentVersion, getUpdateChannel, setUpdateChannel, getAutoCheck, setAutoCheck, listChannelReleases, type CheckResult, type UpdateInfo, type UpdateProgress,
} from '@/bridge/updater'

const router = useRouter()

/** 加载/结果状态 */
const loading = ref(true)
const error = ref('')
const info = ref<UpdateInfo | null>(null)
const currentVersion = ref<string | null>(null)
/** 是否有更新可下载 */
const hasUpdate = ref(false)
/** 是否已是最新（用于“已是最新版本”提示） */
const latest = ref(false)

/** 渠道与自动更新开关（更新页顶栏） */
const channel = ref<'beta' | 'release'>(getUpdateChannel())
const autoCheck = ref(getAutoCheck())
const releaseList = ref<Array<{ tag: string; version: string; notes: string; isBeta: boolean; publishedAt?: string }>>([])

/** 下载/安装过程状态 */
const busy = ref(false)
const progress = ref(0)
const stateText = ref('')
const failed = ref('')

const canDownload = computed(() => isMobileHost())

async function refresh() {
  loading.value = true
  releaseList.value = await listChannelReleases(channel.value)
  error.value = ''
  info.value = null
  hasUpdate.value = false
  latest.value = false
  failed.value = ''
  busy.value = false
  progress.value = 0
  stateText.value = ''
  const result = await checkForUpdates()
  currentVersion.value = result.currentVersion ?? getCurrentVersion()
  if (!result.ok) {
    error.value = result.error ?? '检查更新失败'
    loading.value = false
    return
  }
  hasUpdate.value = result.hasUpdate
  info.value = result.update ?? null
  latest.value = !result.hasUpdate
  loading.value = false
}

/** 点击「下载并安装」：交给原生，本地订阅进度事件渲染。 */
function download() {
  if (!info.value || busy.value) return
  if (!canDownload.value) {
    failed.value = '请在手机端（WebView）下载安装'
    return
  }
  busy.value = true
  failed.value = ''
  progress.value = 0
  stateText.value = '正在发起下载…'
  requestUpdateDownload(info.value)
}

function onProgress(p: UpdateProgress) {
  if (!busy.value) busy.value = true
  progress.value = p.progress
  stateText.value = p.message ?? progressText(p)
  if (p.state === 'error') {
    busy.value = false
    failed.value = p.message ?? '下载失败'
  } else if (p.state === 'install-permission') {
    // 已引导用户去系统设置授权：解锁按钮，回来后可再次点击（已下载的包会直接复用）。
    busy.value = false
    failed.value = ''
  } else if (p.state === 'installing') {
    // 安装器已拉起：本次流程结束。
    busy.value = false
    hasUpdate.value = false
    latest.value = true
  }
}

function progressText(p: UpdateProgress): string {
  switch (p.state) {
    case 'downloading': return `正在下载… ${p.progress}%`
    case 'verifying': return '正在校验 SHA-256…'
    case 'install-permission': return '需要允许安装未知来源应用'
    case 'installing': return '已校验通过，正在打开安装器…'
    default: return ''
  }
}

function onResult(r: { state: string; message?: string }) {
  if (r.state === 'error') {
    busy.value = false
    failed.value = r.message ?? '安装失败'
    return
  }
  // installing：安装器已拉起，页面提示去完成安装
  if (r.state === 'installing') {
    busy.value = false
    stateText.value = '已拉起系统安装器，请按提示完成安装'
    hasUpdate.value = false
    latest.value = true
  }
}

let unsubProgress: (() => void) | null = null
let unsubResult: (() => void) | null = null

onMounted(() => {
  unsubProgress = subscribeUpdateProgress(onProgress)
  unsubResult = subscribeUpdateResult(onResult)
  void refresh()
})

onBeforeUnmount(() => {
  unsubProgress?.()
  unsubResult?.()
})
</script>

<template>
  <div class="page">
    <PageHead title="检查更新" @back="goBack(router, '/settings')" />

    <main class="body">
      <section class="group">
        <div class="line"><span>自动更新提醒</span><strong class="ctrl-right"><button class="chip" :class="{ on: autoCheck }" @click="autoCheck = !autoCheck; setAutoCheck(autoCheck)">{{ autoCheck ? '开' : '关' }}</button></strong></div>
        <div class="line"><span>更新渠道</span><strong class="ctrl-right flex gap-2"><button class="chip" :class="{ on: channel === 'beta' }" @click="channel = 'beta'; setUpdateChannel('beta'); refresh()">BETA</button><button class="chip" :class="{ on: channel === 'release' }" @click="channel = 'release'; setUpdateChannel('release'); refresh()">release</button></strong></div>
      </section>

      <p v-if="loading" class="notice">正在获取更新信息…</p>
      <p v-if="error" class="notice error">{{ error }}（直连失败会走 gh-proxy 加速）</p>

      <template v-if="!loading && !error">
        <section class="group">
          <div class="line"><span>当前版本</span><strong>v{{ currentVersion || '—' }}</strong></div>
          <div v-if="info" class="line"><span>最新版本</span><strong>v{{ info.version }}</strong></div>
          <div v-if="info?.publishedAt" class="line"><span>发布日期</span><strong>{{ info.publishedAt.slice(0, 10) }}</strong></div>
          <div v-if="info" class="line"><span>安装包</span><strong class="mono">{{ info.assetName }}</strong></div>
          <div v-if="info?.sha256" class="line"><span>SHA-256</span><strong class="mono short">{{ info.sha256 }}</strong></div>
        </section>

        <p v-if="latest" class="ok-line">已是最新版本</p>
        <p v-if="hasUpdate && info" class="update-line">发现新版本 v{{ info.version }}，点击下方按钮下载并安装。</p>

        <section v-if="hasUpdate && info" class="group">
          <div class="notes-title">更新说明</div>
          <div class="notes">{{ readableNotes(info.notes) || '（无说明）' }}</div>
        </section>

        <p v-if="stateText && busy" class="notice">{{ stateText }}</p>
        <div v-if="busy" class="progress"><i :style="{ width: progress + '%' }" /></div>
        <p v-if="failed" class="notice error">{{ failed }}</p>

        <button
          v-if="hasUpdate"
          class="primary"
          :disabled="busy || !canDownload"
          @click="download"
        >
          {{ busy ? (progress > 0 && progress < 100 ? `正在下载 ${progress}%` : stateText) : '下载并安装' }}
        </button>
        <p v-if="hasUpdate && !canDownload" class="hint">当前是桌面/浏览器环境，请在手机端 CoomiPlus 里执行更新。</p>
      </template>

      <section v-if="releaseList.length" class="group rel-list">
        <div class="notes-title">更新消息（{{ releaseList.length }}）</div>
        <div v-for="rel in releaseList" :key="rel.tag" class="rel enter-item">
          <div class="rel-head"><strong>v{{ rel.version }}</strong><span v-if="rel.isBeta" class="badge beta">BETA</span><span v-else class="badge stable">正式版</span></div>
          <p v-if="rel.notes" class="rel-notes">{{ rel.notes }}</p>
          <p v-else class="rel-none">（无说明）</p>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 14px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6)); }
.notice { margin: 0 0 10px; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-sm); background: var(--blue-soft); color: var(--blue); font-size: var(--fs-label); }
.notice.error { background: color-mix(in srgb, var(--orange) 16%, var(--bg)); color: var(--orange); }
.group { margin-bottom: var(--sp-3); overflow: hidden; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.line { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: var(--sp-3) 13px; border-bottom: 1px solid var(--border); font-size: var(--fs-sub); }
.line:last-of-type { border-bottom: 0; }
.line span { color: var(--text-3); flex-shrink: 0; }
.line strong { color: var(--text); word-break: break-all; text-align: right; }
.line strong.mono { font-family: var(--font-mono); font-size: var(--fs-label); }
.line strong.short { max-width: 62vw; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.notes-title { padding: var(--sp-3) 13px 2px; font-size: var(--fs-label); color: var(--text-3); }
.notes { padding: 6px 13px var(--sp-3); font-size: var(--fs-label); line-height: 1.7; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.ok-line { margin: 2px 2px var(--sp-3); font-size: var(--fs-sub); color: var(--ok); }
.update-line { margin: 0 2px var(--sp-3); font-size: var(--fs-sub); color: var(--blue); }
.primary { display: inline-flex; align-items: center; justify-content: center; width: 100%; min-height: 44px; border-radius: var(--r-md); background: var(--blue); color: #fff; font-size: var(--fs-body); }
.primary:disabled { opacity: 0.6; }
.progress { height: 6px; margin: 0 0 10px; overflow: hidden; border-radius: 3px; background: var(--fill); }
.progress i { display: block; height: 100%; border-radius: 3px; background: var(--blue); transition: width var(--dur-slow) var(--ease-out); }
.hint { margin: var(--sp-2) 2px 0; font-size: var(--fs-label); color: var(--text-3); }
.ctrl-right { display: inline-flex; align-items: center; justify-content: flex-end; }
.chip { min-width: 48px; padding: 5px 10px; border-radius: var(--r-sm); font-size: var(--fs-label); background: var(--fill); color: var(--text-2); }
.chip.on { background: var(--blue-soft); color: var(--blue); font-weight: 600; }
/* --line 未定义 → border 整条失效，版本条目之间没有分隔线。改用 --border。 */
.rel { padding: 10px 13px; border-bottom: 1px solid var(--border); }
.rel:last-of-type { border-bottom: 0; }
.rel-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: var(--sp-1); font-size: var(--fs-sub); color: var(--text); }
.badge { padding: 1px 7px; border-radius: var(--r-sm); font-size: var(--fs-caption); font-weight: 600; }
.badge.beta { background: color-mix(in srgb, var(--orange) 18%, var(--bg)); color: var(--orange); }
.badge.stable { background: color-mix(in srgb, var(--ok) 18%, var(--bg)); color: var(--ok); }
.rel-notes { font-size: var(--fs-label); line-height: 1.7; color: var(--text-2); white-space: pre-wrap; word-break: break-word; margin: 0; }
.rel-none { font-size: var(--fs-label); color: var(--text-3); margin: 0; }
</style>
