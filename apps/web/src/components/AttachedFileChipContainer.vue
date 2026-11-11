<script setup lang="ts">
/**
 * 已添加附件行（输入栏）。
 *
 * 规格：
 *  · **单行横向滚动**（旧实现换行后文件一多就往下堆，把输入栏顶得很高）；
 *  · 每个附件是 72×72 方块（图片直接显示缩略图，见 AttachmentTile）；
 *  · 两端渐隐表示还有内容，不再用一个「›」按钮（按钮会挡住最后一个附件）。
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import AttachmentTile from './AttachmentTile.vue'

interface AttachedFile {
  id: string
  path: string
  name: string
  size: number
  mimeType?: string
  isDir?: boolean
}

const props = defineProps<{ files: AttachedFile[] }>()
const emit = defineEmits<{ remove: [id: string] }>()

const scrollEl = ref<HTMLDivElement | null>(null)
const hasOverflow = ref(false)

function updateScroll(): void {
  const el = scrollEl.value
  if (!el) return
  hasOverflow.value = el.scrollWidth > el.clientWidth + 2
}

function onRemove(id: string): void {
  emit('remove', id)
  nextTick(updateScroll)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  updateScroll()
  observer = new ResizeObserver(updateScroll)
  if (scrollEl.value) observer.observe(scrollEl.value)
})
onUnmounted(() => observer?.disconnect())
</script>

<template>
  <transition name="chip-list">
    <div v-if="files.length" class="file-chips-wrap" :class="{ overflow: hasOverflow }">
      <div ref="scrollEl" class="file-chips" @scroll.passive="updateScroll">
        <transition-group name="chip">
          <AttachmentTile
            v-for="file in files"
            :key="file.id"
            :file="file"
            removable
            interactive
            @remove="onRemove"
          />
        </transition-group>
      </div>
    </div>
  </transition>
</template>

<style scoped>
.file-chips-wrap {
  position: relative;
  padding: var(--sp-2) 2px 2px;
  margin: 0 2px;
}
.file-chips {
  display: flex;
  flex-wrap: nowrap;
  align-items: flex-start;
  gap: 10px;
  overflow-x: auto;
  overflow-y: hidden;
  padding: 2px 2px var(--sp-1);
  scroll-behavior: smooth;
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.file-chips::-webkit-scrollbar { display: none; }

/* 两端渐隐：只在真的溢出时出现，否则会盖住第一个附件的左边。 */
.file-chips-wrap.overflow .file-chips {
  -webkit-mask-image: linear-gradient(90deg, transparent 0, #000 10px, #000 calc(100% - 14px), transparent 100%);
  mask-image: linear-gradient(90deg, transparent 0, #000 10px, #000 calc(100% - 14px), transparent 100%);
}

.chip-enter-active { transition: opacity var(--dur-slow) var(--ease-out), transform var(--dur-slow) var(--ease-out); }
.chip-enter-from { opacity: 0; transform: translateX(-12px) scale(.88); }
.chip-leave-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); position: absolute; }
.chip-leave-to { opacity: 0; transform: scale(.8); }
.chip-leave-active ~ .chip-enter-active { transition-delay: var(--dur-press) var(--ease-out); }

/* 整行出现/消失：只动透明度与 4px 位移，不改高度（改高度会把输入栏顶一下）。 */
.chip-list-enter-active, .chip-list-leave-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.chip-list-enter-from, .chip-list-leave-to { opacity: 0; transform: translateY(-4px); }
@media (prefers-reduced-motion: reduce) {
  .chip-enter-active, .chip-leave-active, .chip-list-enter-active, .chip-list-leave-active { transition: none; }
}
</style>
