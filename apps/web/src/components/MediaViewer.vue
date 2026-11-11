<script setup lang="ts">
/**
 * 统一图片查看器（正文图片 / 附件瓦片共用）。
 *
 * 交互：
 *  · 双击（或双指捏合）在 1× 与 2.5× 之间缩放；
 *  · 放大后单指拖动平移；
 *  · 1× 时下滑关闭（超过 96px 或快速下滑）；
 *  · 保存走同一条路：本地/云端的图片都先取回字节，再交给原生保存或浏览器下载。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const props = defineProps<{ src: string; name?: string }>()
const emit = defineEmits<{ close: [] }>()

const MAX_SCALE = 2.5
const scale = ref(1)
const tx = ref(0)
const ty = ref(0)
const dragY = ref(0)
const dragging = ref(false)
const saving = ref(false)

const pointers = new Map<number, { x: number; y: number }>()
let pinchStart = 0
let pinchBase = 1
let tapAt = 0
let startY = 0
let startX = 0
let startTx = 0
let startTy = 0

const style = computed(() => ({
  transform: `translate3d(${tx.value}px, ${ty.value + dragY.value}px, 0) scale(${scale.value})`,
  transition: dragging.value ? 'none' : 'transform .22s cubic-bezier(.22,.68,.19,1)',
}))

const backdrop = computed(() => {
  const fade = Math.min(0.55, Math.abs(dragY.value) / 320)
  return `rgba(8,10,14,${0.86 - fade})`
})

function clampTranslate(): void {
  const limitX = (window.innerWidth * (scale.value - 1)) / 2
  const limitY = (window.innerHeight * (scale.value - 1)) / 2
  tx.value = Math.max(-limitX, Math.min(limitX, tx.value))
  ty.value = Math.max(-limitY, Math.min(limitY, ty.value))
}

function reset(): void {
  scale.value = 1
  tx.value = 0
  ty.value = 0
  dragY.value = 0
}

function toggleZoom(): void {
  if (scale.value > 1) { reset(); return }
  scale.value = MAX_SCALE
  clampTranslate()
}

function onPointerDown(event: PointerEvent): void {
  ;(event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  dragging.value = true
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    pinchStart = Math.hypot(a.x - b.x, a.y - b.y)
    pinchBase = scale.value
    return
  }
  startX = event.clientX
  startY = event.clientY
  startTx = tx.value
  startTy = ty.value
}

function onPointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]
    const distance = Math.hypot(a.x - b.x, a.y - b.y)
    if (pinchStart > 0) {
      scale.value = Math.max(1, Math.min(MAX_SCALE, (pinchBase * distance) / pinchStart))
      clampTranslate()
    }
    return
  }
  if (scale.value > 1) {
    tx.value = startTx + (event.clientX - startX)
    ty.value = startTy + (event.clientY - startY)
    clampTranslate()
    return
  }
  dragY.value = Math.max(0, event.clientY - startY)
}

function onPointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId)
  if (pointers.size === 0) dragging.value = false
  if (scale.value > 1) return
  const now = Date.now()
  if (now - tapAt < 280 && Math.abs(dragY.value) < 8) { tapAt = 0; toggleZoom(); dragY.value = 0; return }
  tapAt = now
  if (dragY.value > 96) { emit('close'); return }
  dragY.value = 0
}

async function save(): Promise<void> {
  if (saving.value) return
  saving.value = true
  const fileName = props.name || 'coomi-image.png'
  try {
    const response = await fetch(props.src)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const blob = await response.blob()
    if (window.CoomiAndroid?.saveFileData) {
      const base64 = await blobToBase64(blob)
      window.CoomiAndroid.saveFileData(base64, fileName, blob.type || 'image/png')
      return
    }
    if (window.CoomiAndroid?.saveImageData) {
      const dataUrl = await blobToDataUrl(blob)
      window.CoomiAndroid.saveImageData(dataUrl, fileName)
      return
    }
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = fileName
    link.rel = 'noopener'
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 4000)
  } catch {
    /* 保存失败时保持查看器打开：用户可以直接截图，不需要再弹一层错误 */
  } finally {
    saving.value = false
  }
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result || ''))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(blob)
  })
}

async function blobToBase64(blob: Blob): Promise<string> {
  const dataUrl = await blobToDataUrl(blob)
  const comma = dataUrl.indexOf('base64,')
  return comma >= 0 ? dataUrl.slice(comma + 'base64,'.length) : ''
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}
window.addEventListener('keydown', onKeydown)
// 只在展开时挂载：挂载即登记返回栈，系统返回先关查看器而不是退出应用。
onMounted(() => registerOverlay('media-viewer', () => emit('close')))
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
  unregisterOverlay('media-viewer')
})
</script>

<template>
  <Teleport to="body">
    <div class="viewer" :style="{ background: backdrop }" role="dialog" aria-modal="true" aria-label="查看图片">
      <button class="v-close" aria-label="关闭" @click="emit('close')"><CoomiIcon name="close" :size="18" /></button>
      <div
        class="v-stage"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @dblclick="toggleZoom"
      >
        <img :src="src" :style="style" alt="" draggable="false" />
      </div>
      <div class="v-bar">
        <button class="v-btn" :disabled="saving" @click="save">
          <CoomiIcon name="download" :size="15" /><span>{{ saving ? '保存中…' : '保存' }}</span>
        </button>
        <span class="v-tip">双击缩放 · 下滑关闭</span>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.viewer {
  position: fixed; inset: 0; z-index: var(--z-modal, 300);
  display: flex; flex-direction: column;
  touch-action: none;
  padding-top: var(--safe-top, 0px);
  padding-bottom: calc(var(--safe-bottom, 0px) + var(--sp-2));
  animation: viewer-in 160ms var(--ease-out);
}
@keyframes viewer-in { from { opacity: 0; } to { opacity: 1; } }
.v-stage {
  flex: 1; min-height: 0;
  display: grid; place-items: center;
  overflow: hidden;
  cursor: grab;
}
.v-stage img {
  max-width: 100vw; max-height: 100%;
  object-fit: contain;
  user-select: none; -webkit-user-select: none;
  will-change: transform;
}
.v-close {
  position: absolute; top: calc(var(--safe-top, 0px) + 10px); right: 12px;
  width: 34px; height: 34px; display: grid; place-items: center;
  border: 0; border-radius: 50%;
  background: rgb(255 255 255 / .14); color: #fff;
  backdrop-filter: blur(8px);
}
.v-bar {
  display: flex; align-items: center; justify-content: space-between;
  gap: var(--sp-3); padding: 10px var(--sp-4) 6px;
}
.v-btn {
  display: inline-flex; align-items: center; gap: 6px;
  min-height: 36px; padding: 0 14px;
  border: 1px solid rgb(255 255 255 / .18); border-radius: var(--r-pill);
  background: rgb(255 255 255 / .12); color: #fff;
  font-size: var(--fs-label); font-weight: 600;
}
.v-btn:active { background: rgb(255 255 255 / .22); }
.v-btn:disabled { opacity: .6; }
.v-tip { color: rgb(255 255 255 / .55); font-size: var(--fs-caption); }
@media (prefers-reduced-motion: reduce) {
  .viewer { animation: none; }
  .v-stage img { transition: none !important; }
}
</style>
