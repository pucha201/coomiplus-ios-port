<script setup lang="ts">
/**
 * 过程块里的一段叙述正文（ProcessBlock 的 text stage）。
 *
 * 与答案同一条口径：生成中纯文本逐字（useStreamReveal 按内容长度差推进），
 * 过程结束 / 本轮结束后保持纯文本 —— 它是折叠起来的过程记录，
 * 不该在收起来之后再变成富文本打扰阅读（与桌面端 ProcessBlock 的处理一致）。
 */
import { computed } from 'vue'
import type { AssistantMessage } from '@/stores/viewModel'
import { useStreamReveal } from '@/composables/useStreamReveal'

const props = defineProps<{ item: AssistantMessage }>()
const reveal = useStreamReveal(props.item)
const text = computed(() => reveal.text.value ?? props.item.content)
</script>

<template>
  <div class="narr">{{ text }}</div>
</template>

<style scoped>
.narr {
  font-size: var(--fs-sub); line-height: 1.7; color: var(--text-3);
  white-space: pre-wrap; word-break: break-word;
}
</style>
