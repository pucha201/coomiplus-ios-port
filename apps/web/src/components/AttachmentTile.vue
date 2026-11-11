<script setup lang="ts">
/**
 * 附件方块（输入栏 / 已发送消息共用）。
 *
 * 为什么是方的：旧 UI 是 26px 高的药丸，图片附件只能显示一个图标 ——
 * 用户加了图却看不到图。改成 72×72 方块后，图片直接出缩略图，
 * 非图片用「类型图标 + 扩展名」占位，信息密度和可辨认度都更高。
 */
import { computed, ref } from 'vue'
import { engineToken, tokenRevision } from '@/bridge/http'
import { fileExt, fileName, isImagePath } from '@/utils/filePaths'
import CoomiIcon from './CoomiIcon.vue'

interface AttachedFile {
  id?: string
  path: string
  name?: string
  size?: number
  mimeType?: string
  isDir?: boolean
}

const props = defineProps<{
  file: AttachedFile
  /** 输入栏用 true：右上角出现移除徽标。 */
  removable?: boolean
  /** 只有点击有行为时才渲染成按钮（已发送的非图片附件是纯展示）。 */
  interactive?: boolean
}>()
const emit = defineEmits<{ remove: [id: string]; open: [path: string] }>()

const failed = ref(false)

const displayName = computed(() => props.file.name || fileName(props.file.path))
const extLabel = computed(() => (fileExt(displayName.value) || 'DIR').toUpperCase().slice(0, 4))
const isDir = computed(() => props.file.isDir === true || displayName.value.endsWith('/') || !fileExt(displayName.value))
const isImage = computed(() => !isDir.value && isImagePath(displayName.value))
const thumbnail = computed(() => {
  void tokenRevision.value // 令牌晚到时重算，避免缩略图裂开
  if (!isImage.value) return ''
  return '/api/fs/raw?path=' + encodeURIComponent(props.file.path)
    + '&token=' + encodeURIComponent(engineToken())
})
const icon = computed(() => {
  if (isDir.value) return 'folder'
  const ext = fileExt(displayName.value)
  if (['doc', 'docx'].includes(ext)) return 'fileEdit'
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'fileWrite'
  if (['zip', 'tar', 'gz', 'rar', '7z'].includes(ext)) return 'folder'
  return 'fileRead'
})

function onTap(): void {
  if (props.interactive) emit('open', props.file.path)
}
function onRemove(event: MouseEvent): void {
  event.stopPropagation()
  if (props.file.id) emit('remove', props.file.id)
}
</script>

<template>
  <div class="tile-wrap">
    <component
      :is="interactive ? 'button' : 'div'"
      class="tile"
      :class="{ 'is-interactive': interactive }"
      :aria-label="displayName"
      @click="onTap"
    >
      <img
        v-if="isImage && !failed"
        class="tile-img"
        :src="thumbnail"
        :alt="displayName"
        loading="lazy"
        decoding="async"
        @error="failed = true"
      />
      <span v-else class="tile-fallback">
        <CoomiIcon :name="icon" :size="22" />
        <em>{{ isDir ? '文件夹' : extLabel }}</em>
      </span>
      <button v-if="removable" class="tile-x" :aria-label="'移除 ' + displayName" @click="onRemove">
        <CoomiIcon name="close" :size="11" />
      </button>
    </component>
    <p class="tile-name">{{ displayName }}</p>
  </div>
</template>

<style scoped>
.tile-wrap {
  display: flex; flex-direction: column; align-items: center;
  gap: var(--sp-1); width: 72px; flex: 0 0 72px;
  scroll-snap-align: start;
}
.tile {
  position: relative;
  width: 72px; height: 72px;
  aspect-ratio: 1 / 1;
  padding: 0; border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--fill);
  overflow: hidden;
  display: grid; place-items: center;
  color: var(--text-3);
  transition: transform var(--dur-base) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.tile.is-interactive { cursor: pointer; }
.tile.is-interactive:active { transform: scale(.96); border-color: var(--border-strong); }
.tile-img {
  width: 100%; height: 100%;
  object-fit: cover; display: block;
  background: var(--bg);
}
.tile-fallback {
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  color: var(--blue);
}
.tile-fallback em {
  font-style: normal;
  font-size: 10px; font-weight: 700; letter-spacing: .04em;
  color: var(--text-3);
}
.tile-x {
  position: absolute; top: 3px; right: 3px;
  width: 18px; height: 18px;
  display: grid; place-items: center;
  border: 0; border-radius: 50%;
  background: rgb(17 22 31 / .62);
  color: #fff;
  backdrop-filter: blur(4px);
}
.tile-x:active { background: rgb(17 22 31 / .82); }
.tile-name {
  width: 72px;
  margin: 0;
  font-size: 10.5px; line-height: 1.25;
  color: var(--text-3);
  text-align: center;
  overflow: hidden;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical;
  word-break: break-all;
}
@media (prefers-reduced-motion: reduce) {
  .tile { transition: none; }
}
</style>
