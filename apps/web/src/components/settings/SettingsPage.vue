<script setup lang="ts">
/**
 * 设置类页面外壳：大标题 + 返回键 + 可滚动正文。
 *
 * 大标题（26/600）跟着内容滚走；完全滑出后由顶栏小标题接住 ——
 * 阈值与 dsh-go AppPage 一致（标题淡出 60%，顶栏标题从 40% 处 20px 内渐显）。
 * 返回时把滚动位置记在会话里，回到同一页能接着上次的位置。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const props = withDefaults(defineProps<{
  title: string
  subtitle?: string
  back?: () => void
}>(), {})

const emit = defineEmits<{ back: [] }>()

const scroller = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLElement | null>(null)
const headerHeight = ref(84)
const headerOpacity = ref(1)
const barTitleOpacity = ref(0)

/** 同一会话内记住各页滚动位置：从二级页返回再进来，不应回到顶端。 */
const SCROLL_KEY = 'coomi.settings.scroll'
function savedScroll(): number {
  try {
    const all = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '{}') as Record<string, number>
    return all[props.title] ?? 0
  } catch { return 0 }
}
function saveScroll(top: number) {
  try {
    const all = JSON.parse(sessionStorage.getItem(SCROLL_KEY) ?? '{}') as Record<string, number>
    all[props.title] = top
    sessionStorage.setItem(SCROLL_KEY, JSON.stringify(all))
  } catch { /* 隐私模式 */ }
}

/** 写 sessionStorage 是同步 IO：逐帧写会拖低滚动帧率，停手 200ms 落一次即可。 */
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null
function onScroll() {
  const top = scroller.value?.scrollTop ?? 0
  const h = Math.max(1, headerHeight.value)
  headerOpacity.value = Math.max(0, Math.min(1, 1 - top / (h * 0.6)))
  barTitleOpacity.value = Math.max(0, Math.min(1, (top - h * 0.4) / 20))
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(() => saveScroll(scroller.value?.scrollTop ?? top), 200)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  if (scroller.value) scroller.value.scrollTop = savedScroll()
  if (titleEl.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      const h = titleEl.value?.offsetHeight ?? 0
      if (h) headerHeight.value = h + 6
    })
    observer.observe(titleEl.value)
  }
})
onBeforeUnmount(() => { observer?.disconnect() })

function goBack() {
  if (props.back) props.back()
  else emit('back')
}
</script>

<template>
  <div class="sp">
    <header class="bar">
      <!-- 与设置首页同一套毛玻璃顶栏：二级页滚动时也有底。 -->
      <span class="bar-bg" aria-hidden="true" />
      <button class="back" type="button" aria-label="返回" @click="goBack">
        <CoomiIcon name="back" :size="20" />
      </button>
      <span
        class="bar-title"
        :style="{ opacity: barTitleOpacity, transform: `translateY(${6 * (1 - barTitleOpacity)}px)` }"
      >{{ title }}</span>
      <div class="actions"><slot name="actions" /></div>
    </header>

    <main ref="scroller" class="body" @scroll.passive="onScroll">
      <div ref="titleEl" class="hero" :style="{ opacity: headerOpacity }">
        <h1 class="hero-title">{{ title }}</h1>
        <p v-if="subtitle" class="hero-sub">{{ subtitle }}</p>
      </div>
      <slot />
    </main>
  </div>
</template>

<style scoped>
.sp { position: relative; display: flex; flex-direction: column; height: 100%; background: var(--page); }

.bar {
  position: absolute; left: 0; right: 0; top: 0; z-index: var(--z-header);
  display: flex; align-items: center; gap: var(--sp-1);
  padding: calc(var(--safe-top) + var(--sp-2)) var(--sp-2) var(--sp-2);
  pointer-events: none;
}
.bar > * { pointer-events: auto; }
.bar-bg {
  position: absolute; inset: 0; pointer-events: none;
  background: color-mix(in srgb, var(--page) 76%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  backdrop-filter: blur(18px) saturate(1.25);
}
.back {
  display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 72%, transparent); color: var(--text);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .06);
}
.bar-title {
  flex: 1; text-align: center; font-size: var(--fs-strong); font-weight: 600; color: var(--text);
  transition: opacity var(--dur-fast) var(--ease-out);
}
.actions { display: flex; align-items: center; gap: var(--sp-2); min-width: 40px; justify-content: flex-end; }

.body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: calc(var(--safe-top) + 52px) var(--sp-4) calc(var(--safe-bottom) + var(--sp-7));
  scrollbar-width: none;
}
.body::-webkit-scrollbar { display: none; }

.hero { padding: var(--sp-2) var(--sp-1) var(--sp-4); }
.hero-title { margin: 0; font-size: 26px; line-height: 1.3; font-weight: 600; letter-spacing: -.02em; color: var(--text); }
.hero-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sub); color: var(--text-3); }
</style>
