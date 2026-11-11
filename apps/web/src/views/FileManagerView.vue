<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import { authedFetch, engineToken } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'

interface Entry { name: string; is_dir: boolean; size: number; modified: number }
interface ClipItem { path: string; name: string; isDir: boolean }

const route = useRoute()
const router = useRouter()
const session = useSessionStore()
const path = ref('/')
const entries = ref<Entry[]>([])
const loading = ref(true)
const error = ref('')
let listRequest = 0
const notice = ref('')
const expandedName = ref('')
const previewEntry = ref<Entry | null>(null)
const previewOpen = ref(false)
const previewText = ref('')
const selectionActive = ref(false)
const selectedPaths = ref<Set<string>>(new Set())
const clip = ref<ClipItem[]>([])
const clipMode = ref<'copy' | 'move'>('copy')
const pasteBusy = ref(false)
const inputMode = ref<'none' | 'rename' | 'create'>('none')
const renaming = ref<Entry | null>(null)
const creating = ref<'dir' | 'file' | null>(null)
const inputName = ref('')
const deleteTargets = ref<Entry[] | null>(null)
const deleteBusy = ref(false)

const parentPath = computed(() => {
  const current = cleanPath(path.value)
  const index = current.lastIndexOf('/')
  return index <= 0 ? '/' : current.slice(0, index)
})

const crumbs = computed(() => {
  const parts = path.value.split('/').filter(Boolean)
  const out: { label: string; path: string }[] = []
  let current = ''
  for (const part of parts) { current += '/' + part; out.push({ label: part, path: current }) }
  return out
})

function cleanPath(value: string): string {
  return value.length > 1 ? value.replace(/\/+$/, '') : value
}

function fullPath(entry: Entry): string {
  return cleanPath(path.value) + '/' + entry.name
}

async function api(method: string, url: string, body?: unknown): Promise<any> {
  const response = await authedFetch(url, {
    method, headers: body ? { 'Content-Type': 'application/json' } : undefined, body: body ? JSON.stringify(body) : undefined,
  })
  // 引擎不在线时同源会把前端 index.html 以 200 回给 /api/*；JSON.parse 失败若当成 {},
  // 列表的 path 会被赋成 undefined，crumbs 每帧抛错，骨架屏永远不消失。
  const text = await response.text()
  let data: any = {}
  if (text) {
    try { data = JSON.parse(text) }
    catch { throw new Error(`电脑端返回了非 JSON 响应（HTTP ${response.status}），请检查连接`) }
  }
  if (!response.ok) {
    if (response.status === 403) throw new Error('禁止访问')
    throw new Error(data.error ?? data.message ?? `HTTP ${response.status}`)
  }
  return data
}

async function load(directory: string) {
  const request = ++listRequest
  loading.value = true
  error.value = ''
  try {
    const data = await api('GET', '/api/fs/list?path=' + encodeURIComponent(directory))
    if (request !== listRequest) return
    // 结构不对就不能写进 path/entries：path 一旦不是字符串，crumbs 会在渲染时抛错，
    // 页面停在骨架屏且看不到任何错误文案。
    if (typeof data.path !== 'string' || !Array.isArray(data.entries)) {
      throw new Error('文件列表响应格式不对，请检查电脑连接')
    }
    path.value = data.path
    entries.value = data.entries
    closeTransientState()
  } catch (cause) {
    if (request === listRequest) error.value = cause instanceof Error ? cause.message : String(cause)
  } finally {
    if (request === listRequest) loading.value = false
  }
}

function closeTransientState() {
  expandedName.value = ''
  selectionActive.value = false
  selectedPaths.value = new Set()
}

function fmtSize(size: number): string {
  if (size >= 1 << 30) return (size / (1 << 30)).toFixed(1) + 'G'
  if (size >= 1 << 20) return (size / (1 << 20)).toFixed(1) + 'M'
  if (size >= 1 << 10) return (size / (1 << 10)).toFixed(0) + 'k'
  return String(size)
}

function fmtTime(timestamp: number): string {
  if (!timestamp) return ''
  const date = new Date(timestamp * 1000)
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function isSelected(entry: Entry): boolean { return selectedPaths.value.has(fullPath(entry)) }

function toggleSelected(entry: Entry) {
  const next = new Set(selectedPaths.value)
  const target = fullPath(entry)
  if (next.has(target)) next.delete(target); else next.add(target)
  selectedPaths.value = next
}

function beginSelection(entry?: Entry) {
  selectionActive.value = true
  expandedName.value = ''
  if (entry && !isSelected(entry)) toggleSelected(entry)
}

function cancelSelection() {
  selectionActive.value = false
  selectedPaths.value = new Set()
}

function selectAll() {
  selectedPaths.value = selectedPaths.value.size === entries.value.length
    ? new Set()
    : new Set(entries.value.map(fullPath))
}

function selectedEntries(): Entry[] {
  return entries.value.filter(isSelected)
}

let pressTimer: ReturnType<typeof setTimeout> | null = null
let pressStart = { x: 0, y: 0 }
let suppressClick = false

function onPressStart(event: PointerEvent, entry: Entry) {
  if (event.button !== 0 || (event.target as HTMLElement).closest('button')) return
  clearPressTimer()
  pressStart = { x: event.clientX, y: event.clientY }
  pressTimer = setTimeout(() => {
    suppressClick = true
    beginSelection(entry)
    navigator.vibrate?.(18)
  }, 450)
}

function onPressMove(event: PointerEvent) {
  if (Math.hypot(event.clientX - pressStart.x, event.clientY - pressStart.y) > 8) clearPressTimer()
}

function clearPressTimer() {
  if (pressTimer) clearTimeout(pressTimer)
  pressTimer = null
}

function onRowClick(entry: Entry) {
  clearPressTimer()
  if (suppressClick) { suppressClick = false; return }
  if (selectionActive.value) { toggleSelected(entry); return }
  if (entry.is_dir) void load(fullPath(entry))
  else void openPreview(entry)
}

function toggleMenu(entry: Entry) {
  if (selectionActive.value) { toggleSelected(entry); return }
  expandedName.value = expandedName.value === entry.name ? '' : entry.name
}

function startRename(entry: Entry) {
  expandedName.value = ''
  renaming.value = entry
  inputName.value = entry.name
  inputMode.value = 'rename'
}
function startCreate(kind: 'dir' | 'file') {
  creating.value = kind
  inputName.value = ''
  inputMode.value = 'create'
}
function closeInput() {
  inputMode.value = 'none'
  renaming.value = null
  creating.value = null
}
async function submitInput() {
  const name = inputName.value.trim()
  if (!name) { closeInput(); return }
  if (inputMode.value === 'rename' && renaming.value) {
    try {
      await api('POST', '/api/fs/rename', { from: fullPath(renaming.value), to: cleanPath(path.value) + '/' + name })
      notice.value = '已重命名'
      closeInput()
      await load(path.value)
    } catch (cause) {
      notice.value = `重命名失败：${cause instanceof Error ? cause.message : cause}`
    }
    return
  }
  if (inputMode.value === 'create' && creating.value) {
    if (entries.value.some(e => e.name === name)) {
      notice.value = `新建失败：已存在「${name}」`
      return
    }
    try {
      const target = cleanPath(path.value) + '/' + name
      if (creating.value === 'dir') await api('POST', '/api/fs/mkdir', { path: target })
      else await api('POST', '/api/fs/write', { path: target, content: '' })
      notice.value = creating.value === 'dir' ? '已新建文件夹' : '已新建文件'
      closeInput()
      await load(path.value)
    } catch (cause) {
      notice.value = `新建失败：${cause instanceof Error ? cause.message : cause}`
    }
  }
}

function setClip(targets: Entry[], mode: 'copy' | 'move') {
  if (!targets.length) return
  clip.value = targets.map(e => ({ path: fullPath(e), name: e.name, isDir: e.is_dir }))
  clipMode.value = mode
  notice.value = `已${mode === 'copy' ? '复制' : '剪切'} ${targets.length} 项`
  expandedName.value = ''
}

function copyPath(entry: Entry) {
  const p = fullPath(entry)
  copyText(p)
  notice.value = '已复制路径：' + p
}

/** 复制文本：原生桥 → Clipboard API → execCommand 三级兜底（WebView 里后两者常被拦）。 */
function copyText(text: string): void {
  const native = (window as unknown as { CoomiAndroid?: { copyText?: (value: string) => void } }).CoomiAndroid?.copyText
  if (typeof native === 'function') {
    try { native(text); return } catch { /* 落到网页实现 */ }
  }
  if (navigator.clipboard?.writeText) {
    void navigator.clipboard.writeText(text).catch(() => legacyCopy(text))
    return
  }
  legacyCopy(text)
}
function legacyCopy(text: string): void {
  const area = document.createElement('textarea')
  area.value = text
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try { document.execCommand('copy') } catch { /* 忽略 */ }
  area.remove()
}

async function confirmDelete(targets: Entry[]) {
  if (!targets.length) return
  deleteTargets.value = targets
}
async function doDelete() {
  const targets = deleteTargets.value ?? []
  if (!targets.length || deleteBusy.value) return
  deleteBusy.value = true
  let ok = 0
  const fails: string[] = []
  for (const e of targets) {
    try { await api('POST', '/api/fs/delete', { path: fullPath(e) }); ok += 1 }
    catch (cause) { fails.push(`${e.name}: ${cause instanceof Error ? cause.message : cause}`) }
  }
  deleteTargets.value = null
  deleteBusy.value = false
  notice.value = fails.length ? `已删除 ${ok} 项，失败：${fails.join('；')}` : `已永久删除 ${ok} 项`
  cancelSelection()
  await load(path.value)
}

async function pasteClip() {
  if (!clip.value.length || pasteBusy.value) return
  pasteBusy.value = true
  let ok = 0
  for (const item of clip.value) {
    const dest = cleanPath(path.value) + '/' + item.name
    try {
      await api('POST', clipMode.value === 'copy' ? '/api/fs/copy' : '/api/fs/rename', { from: item.path, to: dest })
      ok += 1
    } catch { /* continue */ }
  }
  pasteBusy.value = false
  notice.value = `已${clipMode.value === 'copy' ? '复制' : '移动'} ${ok} 项`
  if (clipMode.value === 'move') clip.value = []
  await load(path.value)
}

const previewSrc = computed(() =>
  previewEntry.value
    ? '/api/fs/raw?path=' + encodeURIComponent(fullPath(previewEntry.value)) + '&token=' + encodeURIComponent(engineToken())
    : '',
)
function isTextFile(name: string): boolean {
  return /\.(txt|md|json|log|sh|py|rs|js|ts|vue|toml|yaml|yml|conf|ini|env|html|css|xml)$/i.test(name)
}
function isImage(name: string): boolean {
  return /\.(png|jpe?g|gif|webp|svg)$/i.test(name)
}
async function openPreview(entry: Entry) {
  previewEntry.value = entry
  previewOpen.value = true
  previewText.value = ''
  expandedName.value = ''
  if (isTextFile(entry.name)) {
    try {
      const res = await authedFetch(previewSrc.value)
      previewText.value = (await res.text()).slice(0, 200000)
    } catch { previewText.value = '（无法读取）' }
  }
}
function openExternal(entry?: Entry) {
  const e = entry ?? previewEntry.value
  if (!e) return
  const full = fullPath(e)
  if (window.CoomiAndroid?.openFile) {
    window.CoomiAndroid.openFile(full)
    return
  }
  if (e.is_dir) {
    notice.value = '当前环境不支持外部打开目录，可复制路径'
    return
  }
  const url = '/api/fs/download?path=' + encodeURIComponent(full) + '&token=' + encodeURIComponent(engineToken())
  window.open(url, '_blank', 'noopener')
}
function saveAs(entry?: Entry) {
  const e = entry ?? previewEntry.value
  if (!e || e.is_dir) return
  const full = fullPath(e)
  if (window.CoomiAndroid?.exportFile) {
    window.CoomiAndroid.exportFile(full, e.name)
    notice.value = '已打开另存为…'
    return
  }
  const url = '/api/fs/download?path=' + encodeURIComponent(full) + '&token=' + encodeURIComponent(engineToken())
  const a = document.createElement('a')
  a.href = url
  a.download = e.name
  document.body.appendChild(a)
  a.click()
  a.remove()
  notice.value = '已触发下载'
}
function setSessionDir() {
  session.setSessionCwd(path.value)
  notice.value = '已设为当前会话目录'
}
function goBackHome() {
  goBack(router, '/settings')
}

onMounted(() => {
  // 支持 ?path= 定位到群聊工作目录/附件父目录；否则用会话 cwd
  const q = String(route.query.path || '')
  const start = q && q.startsWith('/')
    ? q
    : (session.cwd && session.cwd.startsWith('/') ? session.cwd : '/')
  void load(start)
})
onBeforeUnmount(clearPressTimer)
</script>

<template>
  <div class="page">
    <PageHead title="文件管理" @back="goBackHome" />
    <main class="body">
      <div class="crumbs">
        <button class="crumb" @click="load('/')">/</button>
        <template v-for="c in crumbs" :key="c.path">
          <span class="sep">/</span>
          <button class="crumb" :class="{ cur: c.path === path }" @click="load(c.path)">{{ c.label }}</button>
        </template>
      </div>

      <p v-if="notice" class="notice">{{ notice }}</p>
      <p v-if="error" class="notice err">{{ error === '禁止访问' ? '禁止访问' : `加载失败：${error}` }}</p>

      <div v-if="selectionActive" class="selection-toolbar">
        <button class="icon-btn" title="退出多选" @click="cancelSelection"><CoomiIcon name="close" :size="17" /></button>
        <span class="selection-count">已选 {{ selectedPaths.size }} 项</span>
        <button class="tool-action" @click="selectAll">{{ selectedPaths.size === entries.length ? '取消全选' : '全选' }}</button>
        <button class="tool-action" :disabled="selectedPaths.size === 0" @click="setClip(selectedEntries(), 'copy')"><CoomiIcon name="copy" :size="15" /><span>复制</span></button>
        <button class="tool-action" :disabled="selectedPaths.size === 0" @click="setClip(selectedEntries(), 'move')"><CoomiIcon name="scissors" :size="15" /><span>剪切</span></button>
        <button class="tool-action danger" :disabled="selectedPaths.size === 0" @click="confirmDelete(selectedEntries())"><CoomiIcon name="trash" :size="15" /><span>删除</span></button>
      </div>
      <div v-else class="toolbar">
        <button class="tool-action" :disabled="path === '/'" @click="load(parentPath)"><CoomiIcon name="chevronLeft" :size="15" /><span>上一级</span></button>
        <button class="tool-action" @click="startCreate('dir')"><CoomiIcon name="plus" :size="15" /><span>文件夹</span></button>
        <button class="tool-action" @click="startCreate('file')"><CoomiIcon name="fileWrite" :size="15" /><span>文件</span></button>
        <button class="tool-action" :disabled="clip.length === 0 || pasteBusy" @click="pasteClip"><CoomiIcon name="download" :size="15" /><span>粘贴{{ clip.length ? ` (${clip.length})` : '' }}</span></button>
        <button class="tool-action" @click="beginSelection()"><CoomiIcon name="check" :size="15" /><span>选择</span></button>
        <button class="tool-action" @click="setSessionDir"><CoomiIcon name="target" :size="15" /><span>会话目录</span></button>
      </div>

      <UiSkeleton v-if="loading" variant="list" :rows="6" />
      <UiEmpty
        v-else-if="!entries.length && !error"
        icon="folder"
        title="空目录"
        desc="这个目录下还没有文件，可以上传或新建。"
      />
      <div v-else class="file-list">
        <div v-for="entry in entries" :key="entry.name" class="file-item enter-item">
          <div
            class="file-row"
            :class="{ selected: isSelected(entry), expanded: expandedName === entry.name }"
            @pointerdown="onPressStart($event, entry)"
            @pointermove="onPressMove"
            @pointerup="clearPressTimer"
            @pointercancel="clearPressTimer"
            @click="onRowClick(entry)"
          >
            <span v-if="selectionActive" class="selection-mark" :class="{ on: isSelected(entry) }">
              <CoomiIcon v-if="isSelected(entry)" name="check" :size="13" />
            </span>
            <CoomiIcon :name="entry.is_dir ? 'folder' : 'fileRead'" :size="19" class="file-icon" />
            <span class="file-name" :class="{ mono: !entry.is_dir }">{{ entry.name }}</span>
            <span class="file-meta">{{ entry.is_dir ? '' : fmtSize(entry.size) }} {{ fmtTime(entry.modified) }}</span>
            <button v-if="!selectionActive" class="more-btn" :title="`${entry.name} 操作`" @click.stop="toggleMenu(entry)"><CoomiIcon name="more" :size="18" /></button>
          </div>
          <div v-if="expandedName === entry.name && !selectionActive" class="inline-actions">
            <button v-if="!entry.is_dir" @click="openPreview(entry)"><CoomiIcon name="eye" :size="15" /><span>预览</span></button>
            <button v-if="!entry.is_dir" @click="saveAs(entry)"><CoomiIcon name="download" :size="15" /><span>另存</span></button>
            <button @click="openExternal(entry)"><CoomiIcon name="external" :size="15" /><span>外部打开</span></button>
            <button @click="startRename(entry)"><CoomiIcon name="pencil" :size="15" /><span>重命名</span></button>
            <button @click="setClip([entry], 'move')"><CoomiIcon name="scissors" :size="15" /><span>剪切</span></button>
            <button @click="setClip([entry], 'copy')"><CoomiIcon name="copy" :size="15" /><span>复制</span></button>
            <button @click="copyPath(entry)"><CoomiIcon name="link" :size="15" /><span>路径</span></button>
            <button class="danger" @click="confirmDelete([entry])"><CoomiIcon name="trash" :size="15" /><span>删除</span></button>
          </div>
        </div>
      </div>
    </main>

    <div v-if="inputMode !== 'none'" class="sheet-mask enter-flat" @click.self="closeInput">
      <div class="sheet compact-sheet">
        <p class="sheet-title">{{ inputMode === 'rename' ? '重命名' : creating === 'dir' ? '新建文件夹' : '新建文件' }}</p>
        <input v-model="inputName" class="path-input" placeholder="名称" autofocus @keyup.enter="submitInput" />
        <div class="sheet-actions">
          <button class="button ghost" @click="closeInput">取消</button>
          <button class="button primary" @click="submitInput">确定</button>
        </div>
      </div>
    </div>

    <div v-if="deleteTargets" class="sheet-mask enter-flat" @click.self="!deleteBusy && (deleteTargets = null)">
      <div class="sheet compact-sheet" role="alertdialog">
        <p class="sheet-title">永久删除所选内容？</p>
        <p class="sheet-sub">将删除 {{ deleteTargets.filter(e => !e.is_dir).length }} 个文件和 {{ deleteTargets.filter(e => e.is_dir).length }} 个文件夹。文件夹内的全部内容也会被删除，此操作无法恢复。</p>
        <div class="sheet-actions">
          <button class="button ghost" :disabled="deleteBusy" @click="deleteTargets = null">取消</button>
          <button class="button danger-fill" :disabled="deleteBusy" @click="doDelete">{{ deleteBusy ? '删除中…' : '永久删除' }}</button>
        </div>
      </div>
    </div>

    <div v-if="previewOpen && previewEntry" class="sheet-mask enter-flat" @click.self="previewOpen = false">
      <div class="sheet preview-sheet">
        <div class="preview-head">
          <span class="preview-name">{{ previewEntry.name }}</span>
          <button class="icon-btn" @click="saveAs()"><CoomiIcon name="download" :size="15" /></button>
          <button class="icon-btn" @click="openExternal()"><CoomiIcon name="external" :size="15" /></button>
          <button class="icon-btn" @click="previewOpen = false"><CoomiIcon name="close" :size="15" /></button>
        </div>
        <div class="preview-body">
          <img v-if="isImage(previewEntry.name)" :src="previewSrc" class="preview-image" alt="" />
          <pre v-else-if="isTextFile(previewEntry.name)" class="preview-text">{{ previewText }}</pre>
          <div v-else class="preview-other">
            <p>该类型无法内联预览。</p>
            <button class="button primary" @click="openExternal()">用其它应用打开</button>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow: auto; padding: 10px var(--sp-3) calc(var(--sp-5) + var(--safe-bottom)); }
.crumbs { display: flex; flex-wrap: wrap; align-items: center; gap: 2px; margin-bottom: var(--sp-2); }
.crumb { border: 0; background: none; color: var(--blue); font-size: var(--fs-sub); padding: 2px var(--sp-1); }
.crumb.cur { font-weight: 700; color: var(--text); }
.sep { color: var(--text-3); font-size: var(--fs-label); }
.notice { margin: 0 0 var(--sp-2); font-size: var(--fs-label); color: var(--text-2); }
.notice.err { color: var(--danger); }
.toolbar, .selection-toolbar { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 10px; }
.tool-action {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 7px 10px; border-radius: var(--r-sm); border: 1px solid var(--border);
  background: var(--bg); color: var(--text-2); font-size: var(--fs-label);
}
.tool-action.danger { color: var(--danger); }
.tool-action:disabled { opacity: 0.4; }
.selection-count { font-size: var(--fs-label); color: var(--text-2); align-self: center; }
/* 空态已统一到 .empty-sm，这里只保留本页的 .hint。 */
.hint { text-align: center; color: var(--text-3); padding: 30px 10px; font-size: var(--fs-sub); }
.file-list { display: flex; flex-direction: column; gap: var(--sp-1); }
.file-item { border-radius: var(--r-md); overflow: hidden; border: 1px solid var(--border); background: var(--bg-card); }
.file-row { display: flex; align-items: center; gap: 10px; padding: 11px 10px; cursor: pointer; }
.file-row.selected { background: var(--blue-soft); }
.file-row.expanded { border-bottom: 0; border-radius: 12px 12px 0 0; }
.file-icon { color: var(--blue); flex-shrink: 0; }
.file-name { flex: 1; min-width: 0; font-size: var(--fs-sub); color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-meta { font-size: var(--fs-caption); color: var(--text-3); flex-shrink: 0; }
.more-btn { border: 0; background: none; color: var(--text-3); padding: var(--sp-1); }
.selection-mark { width: 20px; height: 20px; border-radius: var(--r-sm); border: 1.5px solid var(--border-strong); display: grid; place-items: center; color: #fff; }
.selection-mark.on { background: var(--blue); border-color: var(--blue); }
.inline-actions { display: flex; flex-wrap: wrap; gap: var(--sp-1); padding: 0 var(--sp-2) 10px; border-top: 1px solid var(--border); }
.inline-actions button {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  padding: 6px var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: var(--fill); color: var(--text-2); font-size: var(--fs-caption);
}
.inline-actions button.danger { color: var(--danger); }
.icon-btn { border: 0; background: var(--fill); width: 32px; height: 32px; border-radius: var(--r-sm); color: var(--text-2); display: grid; place-items: center; }
.sheet-mask { position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(0,0,0,.4); display: flex; align-items: flex-end; justify-content: center; }
.sheet { width: 100%; max-width: 480px; background: var(--bg-card); border-radius: 16px 16px 0 0; padding: 18px var(--sp-4) calc(var(--sp-4) + var(--safe-bottom)); animation: rise var(--dur-base) var(--ease-out) backwards; /* rise 已收敛 global.css，遮罩淡入由 .enter-flat 类负责 */ }
.sheet-title { margin: 0 0 10px; font-size: var(--fs-strong); font-weight: 600; color: var(--text); }
.sheet-sub { margin: 0 0 14px; font-size: var(--fs-sub); color: var(--text-2); line-height: 1.5; }
.sheet-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.button { flex: 1; min-height: 44px; border-radius: var(--r-md); border: 0; font-size: var(--fs-body); font-weight: 600; }
.button.ghost { background: var(--fill); color: var(--text-2); }
.button.primary { background: var(--blue); color: #fff; }
.button.danger-fill { background: var(--danger); color: #fff; }
.path-input { width: 100%; min-height: 42px; border-radius: var(--r-md); border: 1px solid var(--border); background: var(--fill); color: var(--text); padding: 0 var(--sp-3); font-size: var(--fs-body); }
.preview-sheet { max-height: 86vh; display: flex; flex-direction: column; }
.preview-head { display: flex; align-items: center; gap: var(--sp-2); margin-bottom: 10px; }
.preview-name { flex: 1; font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; }
.preview-body { overflow: auto; min-height: 100px; }
.preview-image { max-width: 100%; max-height: 60vh; border-radius: var(--r-md); display: block; margin: 0 auto; }
.preview-text { margin: 0; padding: var(--sp-3); border-radius: var(--r-md); background: var(--fill); font: 12px/1.5 monospace; white-space: pre-wrap; word-break: break-word; max-height: 55vh; overflow: auto; }
.preview-other { text-align: center; padding: var(--sp-6) 0; color: var(--text-3); }

/* 减弱动态效果：底部弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
