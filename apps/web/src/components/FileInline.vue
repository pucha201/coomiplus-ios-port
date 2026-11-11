<script setup lang="ts">
/**
 * 对话中的文件展示组件：
 * - 图片/SVG：消息内自动内联预览（AI「发出」的图直接可见）
 * - 其它类型：可点击文件卡片 → 底部 sheet 预览 / 另存 / 外部打开 / 复制路径
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { authedFetch, engineToken, isCloudConnectionMode, tokenRevision } from '@/bridge/http'
import { fileExt, fileName as fileNameOf, isImagePath } from '@/utils/filePaths'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ paths: string[] }>()

const open = ref(false)
const notice = ref('')
const saving = ref(false)
const activePath = ref('')
const previewText = ref('')
let previewRequest = 0
let destroyed = false

const activeName = computed(() => fileNameOf(activePath.value))

function ext(path: string): string { return fileExt(path) }
function isTextFile(path: string): boolean {
  return ['txt','md','json','log','sh','py','rs','js','ts','vue','toml','yaml','yml','conf','ini','env','html','css','xml','csv'].includes(ext(path))
}
function isImage(path: string): boolean { return isImagePath(path) }
function isSvg(path: string): boolean { return ext(path) === 'svg' }
function isInlinePreview(path: string): boolean {
  return isImage(path) || isSvg(path)
}
/** 消息内自动展示的路径（图 / SVG） */
const inlinePaths = computed(() => props.paths.filter(isInlinePreview).slice(0, 6))
/** 仍以卡片展示的其它文件 */
const chipPaths = computed(() => props.paths.filter(p => !isInlinePreview(p)).slice(0, 12))

const previewSrc = computed(() => {
  void tokenRevision.value // 令牌晚到（重载/首帧）时重算，避免裂图
  return '/api/fs/raw?path=' + encodeURIComponent(activePath.value)
  + '&token=' + encodeURIComponent(engineToken())
})

function downloadUrl(path: string): string {
  return '/api/fs/download?path=' + encodeURIComponent(path)
    + '&token=' + encodeURIComponent(engineToken())
}

/**
 * 文件是否真的在引擎那台机器上。
 * 返回 null = 通道本身失败（分不出「没有这个文件」还是「连不上」），
 * 交给调用方按「先试原生、失败再说」处理。
 */
async function fileExists(path: string): Promise<boolean | null> {
  try {
    const response = await authedFetch(`/api/fs/stat?path=${encodeURIComponent(path)}`)
    if (!response.ok) return false
    const data = await response.json() as { is_file?: boolean }
    return data.is_file === true
  } catch {
    return null
  }
}

function openSheet(path: string) {
  const request = ++previewRequest
  activePath.value = path
  notice.value = ''
  previewText.value = ''
  open.value = true
  if (isTextFile(path)) {
    void authedFetch(previewSrc.value)
      .then(r => { if (!r.ok) throw new Error('HTTP '+r.status); return r.text() })
      .then(t => { if (!destroyed && request === previewRequest && activePath.value === path) previewText.value = t.slice(0, 200000) })
      .catch(() => { if (!destroyed && request === previewRequest && activePath.value === path) previewText.value = '（无法读取）' })
  }
}

async function blobToBase64(blob: Blob): Promise<string> {
  const buffer = new Uint8Array(await blob.arrayBuffer())
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < buffer.length; i += chunk) {
    binary += String.fromCharCode(...buffer.subarray(i, i + chunk))
  }
  return btoa(binary)
}

/** 远端（或浏览器）保存：先取回字节，再交给原生 SAF / 浏览器下载。 */
async function downloadAndSave(): Promise<boolean> {
  if (saving.value) return false
  saving.value = true
  try {
    const response = await authedFetch(downloadUrl(activePath.value))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    if (window.CoomiAndroid?.saveFileData) {
      window.CoomiAndroid.saveFileData(await blobToBase64(blob), activeName.value, blob.type || 'application/octet-stream')
      notice.value = '已保存（下载目录 / 你选择的位置）'
      return true
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = activeName.value
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
    notice.value = '已开始下载'
    return true
  } catch (error) {
    notice.value = `保存失败：${error instanceof Error ? error.message : String(error)}`
    return false
  } finally {
    saving.value = false
  }
}

async function saveAs() {
  notice.value = ''
  const path = activePath.value
  const cloud = isCloudConnectionMode()
  // 本地模式：文件就在这台手机上，原生导出最自然；但必须先确认真实存在，
  // 否则原生会静默（找不到文件时只 toast 一句，用户以为按钮坏了）。
  if (!cloud && window.CoomiAndroid?.exportFile) {
    const exists = await fileExists(path)
    if (exists === true || exists === null) {
      window.CoomiAndroid.exportFile(path, activeName.value)
      notice.value = '已打开另存为…'
      return
    }
    notice.value = '文件不在手机上（可能已被移动或删除）'
    return
  }
  await downloadAndSave()
}

async function openExternal() {
  notice.value = ''
  const path = activePath.value
  const cloud = isCloudConnectionMode()
  if (!cloud && window.CoomiAndroid?.openFile) {
    const exists = await fileExists(path)
    if (exists === true || exists === null) {
      window.CoomiAndroid.openFile(path)
      return
    }
    notice.value = '文件不在手机上（可能已被移动或删除）'
    return
  }
  // 云端：手机上没有这个文件，原生打不开。先落盘，再引导用户去文件管理器打开。
  const saved = await downloadAndSave()
  if (saved) notice.value = '已保存到手机，可用文件管理器打开'
}

function copyPath() {
  void navigator.clipboard?.writeText(activePath.value).catch(() => {})
  notice.value = '已复制路径'
}
function srcFor(path: string): string {
  void tokenRevision.value // 同上：令牌到达即重绘
  return '/api/fs/raw?path=' + encodeURIComponent(path) + '&token=' + encodeURIComponent(engineToken())
}
onBeforeUnmount(() => { destroyed = true; previewRequest++ })
</script>

<template>
  <!-- 自动内联：图片 / SVG -->
  <div v-if="inlinePaths.length" class="inline-media">
    <div v-for="p in inlinePaths" :key="'m-' + p" class="media-card" @click="openSheet(p)">
      <img :src="srcFor(p)" class="media" :alt="p.split('/').pop()" loading="lazy" decoding="async" />
      <span class="media-cap">{{ p.split('/').pop() }}</span>
    </div>
  </div>

  <!-- 其它文件：卡片 -->
  <div v-if="chipPaths.length" class="file-chips">
    <button v-for="p in chipPaths" :key="p" class="chip" @click="openSheet(p)">
      <CoomiIcon name="fileRead" :size="14" />
      <span class="chip-name">{{ p.split('/').pop() }}</span>
      <CoomiIcon name="chevronRight" :size="12" class="arw" />
    </button>
  </div>

  <Teleport v-if="open" to="body">
    <div class="mask enter-flat" @click="open = false">
    <div class="sheet" @click.stop>
      <div class="grip" @click="open = false" />
      <div class="head">
        <CoomiIcon name="fileRead" :size="16" />
        <span class="name">{{ activeName }}</span>
        <button class="x" @click="open = false" aria-label="关闭"><CoomiIcon name="close" :size="15" /></button>
      </div>
      <p class="path">{{ activePath }}</p>
      <p v-if="notice" class="notice">{{ notice }}</p>

      <div class="body">
        <img v-if="isImage(activePath)" :src="previewSrc" class="img" alt="" loading="lazy" decoding="async" />
        <img v-else-if="isSvg(activePath)" :src="previewSrc" class="img" alt="" loading="lazy" decoding="async" />
        <pre v-else-if="isTextFile(activePath)" class="text">{{ previewText }}</pre>
        <div v-else class="other">
          <p>该类型不支持内联预览。</p>
        </div>
      </div>

      <div class="actions">
        <button class="btn" @click="saveAs"><CoomiIcon name="download" :size="15" /><span>另存为</span></button>
        <button class="btn" @click="openExternal"><CoomiIcon name="external" :size="15" /><span>用其它应用打开</span></button>
        <button class="btn" @click="copyPath"><CoomiIcon name="link" :size="15" /><span>复制路径</span></button>
      </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.inline-media { display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: var(--sp-2); }
.media-card {
  max-width: min(100%, 280px);
  border-radius: var(--r-md);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--fill);
  cursor: pointer;
}
.media { display: block; width: 100%; max-height: 220px; object-fit: contain; background: var(--bg); }
.media-cap {
  display: block; padding: 6px 10px; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.file-chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
.chip {
  display: inline-flex; align-items: center; gap: 5px;
  padding: 6px 10px; border-radius: var(--r-sm);
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-label); font-weight: 500;
}
.chip-name { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.arw { opacity: 0.6; }
.mask { position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(0, 0, 0, 0.45); display: flex; align-items: flex-end; }
.sheet {
  width: 100%; background: var(--bg-card);
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  max-height: 86vh; display: flex; flex-direction: column;
  padding-bottom: env(safe-area-inset-bottom, 0px);
  /* 底部弹层入场：rise（100% 上滑，已收敛 global.css），遮罩淡入由 .enter-flat 类负责 */
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grip {
  width: 36px; height: 4px; border-radius: 2px; background: var(--border-strong);
  margin: var(--sp-2) auto 0; flex-shrink: 0;
}
.head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 14px var(--sp-4) var(--sp-2);
}
.name { flex: 1; font-weight: 600; font-size: var(--fs-body); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.x { border: 0; background: var(--fill); width: 30px; height: 30px; border-radius: var(--r-sm); color: var(--text-2); }
.path { margin: 0 var(--sp-4) var(--sp-2); font-size: var(--fs-caption); color: var(--text-3); word-break: break-all; }
.notice { margin: 0 var(--sp-4) var(--sp-2); font-size: var(--fs-label); color: var(--blue); }
.body { flex: 1; overflow: auto; padding: 0 var(--sp-4) var(--sp-3); min-height: 80px; }
.img { max-width: 100%; max-height: 50vh; border-radius: var(--r-md); display: block; margin: 0 auto; }
.text {
  margin: 0; padding: var(--sp-3); border-radius: var(--r-md); background: var(--fill);
  font: 12px/1.55 var(--font-mono, monospace); color: var(--text);
  white-space: pre-wrap; word-break: break-word; max-height: 50vh; overflow: auto;
}
.other { text-align: center; color: var(--text-3); padding: var(--sp-6) 0; font-size: var(--fs-sub); }
.actions {
  display: flex; gap: var(--sp-2); padding: var(--sp-2) var(--sp-4) var(--sp-4);
  border-top: 1px solid var(--border);
}
.btn {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 5px; min-height: 42px; border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--fill); color: var(--text); font-size: var(--fs-label); font-weight: 600;
}

/* 减弱动态效果：预览弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
