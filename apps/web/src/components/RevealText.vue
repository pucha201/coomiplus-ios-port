<script setup lang="ts">
/**
 * 逐字符渐出（精确还原 WorkBuddy applyRevealFade）：
 *   alpha = clamp((head - i) / 10, 0.125, 1.0)
 *   · 只有 head-8 ~ head+2 这 ~10 个字符参与计算，其余走「定型/未揭示」常量；
 *   · 仅透明度，无位移（逆向后确认没有 translate）；
 *   · head 由 useStreamReveal 单一驱动 —— 本组件不再维护第二份进度表/rAF。
 *
 * 以前这里自己按 id 记 head，和 useStreamReveal 各自推进；重挂时两边进度不一致，
 * 就会出现“快结束时突然重播”。现在进度只有一份，组件只是纯渲染。
 */
import { computed } from 'vue'
import { REVEAL_ALPHA_MIN, REVEAL_LEAD, REVEAL_TAIL, REVEAL_WINDOW, revealAlpha } from '@/utils/streamReveal'

const props = defineProps<{ text: string; head?: number }>()

const total = computed(() => props.text.length)
const head = computed(() => {
  const value = props.head ?? total.value
  return Math.max(0, Math.min(total.value, Number.isFinite(value) ? value : total.value))
})

/** 三段：定型（单文本节点）/ 渐出窗口（≤10 个 span）/ 未揭示（不渲染）。 */
const view = computed(() => {
  const text = props.text
  const h = head.value
  const settledEnd = Math.max(0, Math.min(text.length, Math.floor(h - REVEAL_TAIL)))
  const fadeEnd = Math.max(settledEnd, Math.min(text.length, Math.floor(h + REVEAL_LEAD) + 1))
  const settled = text.slice(0, settledEnd)
  const chars: Array<{ ch: string; alpha: number }> = []
  for (let i = settledEnd; i < fadeEnd; i++) {
    chars.push({ ch: text[i], alpha: Number(revealAlpha(h, i, REVEAL_WINDOW).toFixed(3)) })
  }
  return { settled, chars }
})
</script>

<template>
  <span class="reveal-text">
    <span class="rt-settled">{{ view.settled }}</span>
    <span
      v-for="(c, i) in view.chars"
      :key="i"
      class="rt-char"
      :style="{ opacity: c.alpha }"
    >{{ c.ch }}</span>
  </span>
</template>

<style scoped>
.reveal-text { white-space: pre-wrap; word-break: break-word; }
.rt-settled { white-space: pre-wrap; }
/* 透明度已在行内给出；这里只保证不变形（无位移、无间距变化）。 */
.rt-char { display: inline; white-space: pre-wrap; }
</style>
