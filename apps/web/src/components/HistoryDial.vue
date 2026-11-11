<script setup lang="ts">
/**
 * 历史选择：长按底部圆钮 → 全屏模糊 + 右侧竖向轮盘 + 左侧预览卡。
 * 打开期间圆钮不参与任何操作（pointer-events: none，层级在遮罩下）。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

export interface DialTarget {
  blockIndex: number
  /** 用户消息 id：块序号会随流式重组变化，跳转时按 id 重新定位。 */
  messageId?: string
  /** 用户消息（卡片标题） */
  title: string
  /** 用户消息全文 */
  text: string
  /** AI 回复（卡片副标题），可空 */
  reply?: string
  /** 发送时间戳（ms） */
  at?: number
}

const props = defineProps<{ targets: DialTarget[] }>()
const emit = defineEmits<{ jump: [index: number]; latest: [] }>()

const open = ref(false)
const wheelEl = ref<HTMLElement | null>(null)
const index = ref(0)
const ITEM_H = 56

const count = computed(() => props.targets.length)
const current = computed(() => props.targets[index.value])
const pad = (n: number) => String(n + 1).padStart(2, '0')
/** 时间格式：10/21 16:40（日期/时间都带分隔符）。 */
function fmtTime(at?: number): string {
  if (!at) return ''
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

let holdTimer: number | null = null
let pressStart: { x: number; y: number } | null = null
let moved = false

function onFabDown(e: PointerEvent) {
  if (count.value < 2) return
  e.preventDefault()
  try { (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId) } catch { /* ignore */ }
  pressStart = { x: e.clientX, y: e.clientY }
  moved = false
  if (holdTimer) window.clearTimeout(holdTimer)
  holdTimer = window.setTimeout(() => { holdTimer = null; openWheel() }, 240)
}

function onFabMove(e: PointerEvent) {
  if (!pressStart) return
  if (Math.abs(e.clientX - pressStart.x) + Math.abs(e.clientY - pressStart.y) > 10) {
    moved = true
    if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null }
  }
}

function onFabUp() {
  if (holdTimer) { window.clearTimeout(holdTimer); holdTimer = null }
  const tapped = !moved && pressStart
  pressStart = null
  if (open.value) return            // 打开期间圆钮不触发任何动作
  if (tapped) emit('latest')
}

function openWheel() {
  if (count.value < 2) return
  index.value = count.value - 1
  open.value = true
  void nextTick(() => {
    const el = wheelEl.value
    if (el) el.scrollTop = index.value * ITEM_H
  })
}

function close() { open.value = false }
/** 轮盘是一层全屏浮层：系统返回先关它，不能直接退出应用。 */
watch(open, isOpen => {
  if (isOpen) registerOverlay('history-dial', close)
  else unregisterOverlay('history-dial')
})
onBeforeUnmount(() => unregisterOverlay('history-dial'))

function onWheel() {
  const el = wheelEl.value
  if (!el) return
  const next = Math.round(el.scrollTop / ITEM_H)
  index.value = Math.max(0, Math.min(count.value - 1, next))
}

/** 点预览卡：先跳转，再让模糊层淡出（保证"模糊消失前已经跳过去"）。 */
function jumpNow() {
  const target = current.value
  if (!target) return
  // 发**目标数组下标**，不是 blockIndex：ChatView 用它索引 historyTargets。
  // 以前发 blockIndex，块序号恒 ≥ 下标，越往后越容易越界 → 返回 undefined → 静默不动，
  // 表现为「只能往上跳、往下跳失灵」。
  emit('jump', index.value)
  window.setTimeout(() => { open.value = false }, 80)
}

watch(open, (on) => {
  if (!on) return
  document.documentElement.style.overflow = 'hidden'
}, { immediate: true })
watch(open, (on) => {
  if (on) return
  document.documentElement.style.overflow = ''
})
onBeforeUnmount(() => { document.documentElement.style.overflow = '' })
</script>

<template>
  <button
    class="hist-fab"
    :class="{ active: open }"
    :style="open ? 'pointer-events:none;z-index:0' : ''"
    aria-label="历史消息（长按打开）"
    @pointerdown="onFabDown"
    @pointermove="onFabMove"
    @pointerup="onFabUp"
    @pointercancel="onFabUp"
  >
    <CoomiIcon :name="open ? 'close' : 'arrowDown'" :size="19" />
  </button>

  <Transition name="hist">
    <div v-if="open" class="hist-mask" @click.self="close">
      <div class="hist-body" @click.self="close">
        <!-- 左：预览卡（点击跳转） -->
        <button class="preview" @click="jumpNow">
          <div class="pv-head">
            <span class="pv-idx">{{ pad(index) }}</span>
            <span class="pv-time">{{ fmtTime(current?.at) }}</span>
          </div>
          <p class="pv-title">{{ current?.title || '（无标题）' }}</p>
          <p class="pv-text">{{ current?.reply ? 'AI：' + current.reply : '（暂无回复）' }}</p>
          <span class="pv-jump">轻点跳转到这条 <CoomiIcon name="chevronRight" :size="12" /></span>
        </button>

        <!-- 右：竖向轮盘（手指上下滑，自动吸附） -->
        <div ref="wheelEl" class="wheel" @scroll.passive="onWheel">
          <div class="wheel-pad" />
          <button
            v-for="(item, i) in targets"
            :key="item.blockIndex + ':' + i"
            class="wheel-item"
            :class="{ cur: i === index }"
            @click="index = i; (wheelEl as HTMLElement).scrollTo({ top: i * 56, behavior: 'smooth' })"
          >
            <span class="wi-idx">{{ pad(i) }}</span>
            <span class="wi-text">{{ item.title }}</span>
          </button>
          <div class="wheel-pad" />
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.hist-fab {
  position: fixed; right: 12px; bottom: calc(env(safe-area-inset-bottom, 0px) + var(--composer-h, 96px) + 8px);
  /* 与输入栏 `.act` / `.send` 同尺寸（44px），避免圆钮比功能键小一圈。 */
  width: 36px; height: 36px; border-radius: 50%; border: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg) 82%, transparent);
  backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px);
  color: var(--text-2); display: flex; align-items: center; justify-content: center;
  z-index: var(--z-overlay-2);
  /* bottom 也进过渡：键盘升起/收起时 --composer-h 是连续变化的，
     不加过渡按钮会逐帧跳动；加了之后是一条平滑跟随，观感上不再"忽高忽低"。 */
  transition: transform var(--dur-fast) var(--ease-out), bottom 120ms var(--ease-out);
}
.hist-fab:active { transform: scale(.94); }
.hist-fab.active { opacity: 0; }

.hist-mask {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; flex-direction: column; justify-content: center;
  background: color-mix(in srgb, var(--bg) 62%, transparent);
  backdrop-filter: blur(28px); -webkit-backdrop-filter: blur(28px);
}
.hist-body { display: flex; gap: var(--sp-3); padding: 0 var(--sp-4); align-items: stretch; height: 60vh; }
.preview {
  flex: 1; min-width: 0; text-align: left;
  display: flex; flex-direction: column; gap: var(--sp-2);
  padding: var(--sp-4); border-radius: var(--r-card);
  border: 1px solid var(--border); background: var(--bg);
  color: var(--text);
}
.pv-head { display: flex; align-items: center; justify-content: space-between; }
.pv-idx { font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-3); }
.pv-time { font-size: var(--fs-caption); color: var(--text-3); }
/* 标题单行截断：以前没限制，用户发一条很长、无空格的消息标题会把卡片撑破。
   word-break 是必须的 —— 中文没有空格，只靠 overflow 不会在字间断行。 */
.pv-title {
  max-width: 100%;
  font-size: var(--fs-title); font-weight: 700;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  word-break: break-word;
}
.pv-text {
  flex: 1; min-height: 0; overflow: hidden;
  font-size: var(--fs-label); color: var(--text-2);
  display: -webkit-box; -webkit-line-clamp: 8; -webkit-box-orient: vertical;
  /* 同上：长串无空格（base64、路径、一长串数字）必须能断，否则横向溢出卡片。 */
  word-break: break-word;
  overflow-wrap: anywhere;
}
.pv-jump { display: inline-flex; align-items: center; gap: 2px; font-size: var(--fs-caption); color: var(--blue); }

.wheel {
  width: 116px; flex: none; overflow-y: auto; scroll-snap-type: y mandatory;
  scrollbar-width: none; border-radius: var(--r-card);
  background: color-mix(in srgb, var(--bg) 70%, transparent);
  border: 1px solid var(--border);
}
.wheel::-webkit-scrollbar { display: none; }
.wheel-pad { height: calc(50% - 28px); }
.wheel-item {min-height: 56px; width: 100%; scroll-snap-align: center;
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 0 var(--sp-3); border: 0; background: transparent;
  color: var(--text-3); font-size: var(--fs-label);
  opacity: .55; transform: scale(.9);
  transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out);
}
.wheel-item.cur { opacity: 1; transform: scale(1); color: var(--text); font-weight: 700; }
.wi-idx { font-family: var(--font-mono); font-size: var(--fs-caption); }
.wi-text { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.hist-tip {
  margin: var(--sp-3) auto 0; font-size: var(--fs-caption); color: var(--text-3);
}
.hist-enter-active, .hist-leave-active { transition: opacity 160ms var(--ease-out), backdrop-filter 160ms var(--ease-out); }
.hist-enter-from, .hist-leave-to { opacity: 0; }
</style>
