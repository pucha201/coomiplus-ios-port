<script setup lang="ts">
/**
 * 分组卡片：小标题 + 一张卡。
 * 组内行之间靠 2px 空隙分组，不画分割线（与对话页折叠块一致）。
 */
withDefaults(defineProps<{
  title?: string
  /** 组标题右侧的补充说明（右对齐小字）。 */
  note?: string
}>(), {})
</script>

<template>
  <section class="sec">
    <h2 v-if="title" class="sec-title">
      <span>{{ title }}</span>
      <span v-if="note" class="sec-note">{{ note }}</span>
    </h2>
    <div class="card"><slot /></div>
  </section>
</template>

<style scoped>
.sec { margin-top: var(--sp-6); }
.sec:first-of-type { margin-top: var(--sp-2); }
.sec-title {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2);
  margin: 0 0 var(--sp-2); padding: 0 var(--sp-1);
  font-size: var(--fs-label); font-weight: 600; letter-spacing: .02em; color: var(--text-3);
}
.sec-note { font-weight: 500; letter-spacing: 0; }
.card {
  border-radius: var(--r-sheet); background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .04), 0 6px 18px rgba(23, 32, 54, .05);
  overflow: hidden;
}
.card > :deep(* + *) { margin-top: 2px; }
</style>
