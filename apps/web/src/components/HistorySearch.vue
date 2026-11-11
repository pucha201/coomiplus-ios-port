<script setup lang="ts">
/**
 * §四 历史消息搜索：关键词过滤当前会话消息，点结果跳转。
 * 展开/收起都有过渡（遮罩淡入 + 面板放大生长）。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

export interface SearchItem { blockIndex: number; messageId?: string; kind: string; text: string }

const props = defineProps<{ items: SearchItem[] }>()
const emit = defineEmits<{ close: []; jump: [blockIndex: number] }>()

const query = ref('')
const inputEl = ref<HTMLInputElement | null>(null)
onMounted(() => {
  requestAnimationFrame(() => inputEl.value?.focus())
  // 组件只在展开时挂载：挂载即登记返回栈，返回键先关搜索而不是退出应用。
  registerOverlay('history-search', () => emit('close'))
})
onBeforeUnmount(() => unregisterOverlay('history-search'))

/** 命中片段：以关键词为中心截 90 字上下文。 */
const results = computed(() => {
  const q = query.value.trim().toLowerCase()
  if (!q) return [] as Array<SearchItem & { excerpt: string }>
  const out: Array<SearchItem & { excerpt: string }> = []
  for (const item of props.items) {
    const at = item.text.toLowerCase().indexOf(q)
    if (at < 0) continue
    const start = Math.max(0, at - 24)
    const excerpt = (start > 0 ? '…' : '') + item.text.slice(start, start + 90).replace(/\s+/g, ' ')
    out.push({ ...item, excerpt })
    if (out.length >= 60) break
  }
  return out
})
</script>

<template>
  <div class="hs-mask" @click="emit('close')">
    <div class="hs-panel" @click.stop>
      <div class="hs-head">
        <CoomiIcon name="search" :size="17" class="hs-icon" />
        <input ref="inputEl" v-model="query" class="hs-input" type="search" placeholder="搜索历史消息关键词" aria-label="搜索历史消息" />
        <button class="hs-close" aria-label="关闭" @click="emit('close')"><CoomiIcon name="close" :size="16" /></button>
      </div>
      <p v-if="!query" class="hs-empty">输入关键词，匹配当前会话的历史消息</p>
      <p v-else-if="!results.length" class="hs-empty">没有匹配「{{ query }}」的消息</p>
      <div v-else class="hs-list">
        <button v-for="(item, i) in results" :key="item.blockIndex + ':' + i" class="hs-row" @click="emit('jump', item.blockIndex)">
          <span class="hs-kind" :class="item.kind">{{ item.kind === 'user' ? '我' : 'AI' }}</span>
          <span class="hs-text">{{ item.excerpt }}</span>
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.hs-mask {
  position: fixed; inset: 0; z-index: calc(var(--z-drawer) + 2);
  display: flex; align-items: flex-start; justify-content: center;
  padding: calc(var(--safe-top) + var(--sp-5)) var(--sp-3) 0;
  background: color-mix(in srgb, var(--bg) 66%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  animation: hsFade var(--dur-base) var(--ease-out) backwards;
}
@keyframes hsFade { from { opacity: 0; } to { opacity: 1; } }
.hs-panel {
  width: min(94vw, 460px); max-height: min(72vh, 560px);
  display: flex; flex-direction: column; overflow: hidden;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
  animation: hsGrow var(--dur-base) var(--ease-out) backwards;
}
@keyframes hsGrow { from { opacity: 0; transform: translateY(-8px) scale(.96); } to { opacity: 1; transform: none; } }
.hs-head { display: flex; align-items: center; gap: var(--sp-2); padding: var(--sp-2) var(--sp-3); border-bottom: 1px solid var(--border); }
.hs-icon { flex: none; color: var(--text-3); }
.hs-input { flex: 1; min-width: 0; border: 0; background: none; outline: none; font: inherit; font-size: var(--fs-body); color: var(--text); }
.hs-close { display: grid; place-items: center; width: 32px; height: 32px; border: 0; border-radius: 50%; background: var(--fill); color: var(--text-2); }
.hs-close:active { background: var(--fill-press); }
.hs-empty { margin: var(--sp-3); font-size: var(--fs-sub); color: var(--text-3); }
.hs-list { overflow-y: auto; padding: var(--sp-1) var(--sp-2) var(--sp-2); }
.hs-row { display: flex; align-items: flex-start; gap: var(--sp-2); width: 100%; padding: 9px var(--sp-2); border: 0; border-radius: var(--r-md); background: none; text-align: left; }
.hs-row:active { background: var(--fill-press); }
.hs-kind { flex: none; padding: 1px 6px; border-radius: var(--r-pill); background: var(--fill); color: var(--text-3); font-size: var(--fs-caption); font-weight: 600; }
.hs-kind.user { background: var(--blue-soft); color: var(--blue); }
.hs-text { flex: 1; min-width: 0; font-size: var(--fs-sub); line-height: 1.6; color: var(--text-2); overflow-wrap: anywhere; }
@media (prefers-reduced-motion: reduce) { .hs-mask, .hs-panel { animation: none; } }
</style>
