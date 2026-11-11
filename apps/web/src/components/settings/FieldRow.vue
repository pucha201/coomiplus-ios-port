<script setup lang="ts">
/** 表单字段行：标签在上、控件在下，窄屏和大字号都不挤压。 */
withDefaults(defineProps<{ label: string; hint?: string; error?: string }>(), {})
</script>

<template>
  <label class="field">
    <span class="label">{{ label }}</span>
    <slot />
    <span v-if="error" class="err">{{ error }}</span>
    <span v-else-if="hint" class="hint">{{ hint }}</span>
  </label>
</template>

<style scoped>
.field { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); }
.label { font-size: var(--fs-label); color: var(--text-3); }
.field :deep(input), .field :deep(select), .field :deep(textarea) {
  width: 100%; min-height: 44px; padding: 11px var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text);
  font: inherit; font-size: var(--fs-body);
}
.field :deep(textarea) { resize: vertical; line-height: 1.55; min-height: 88px; }
.field :deep(input:focus), .field :deep(select:focus), .field :deep(textarea:focus) {
  border-color: var(--blue); outline: none;
}
.hint { font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }
.err { font-size: var(--fs-caption); line-height: 1.5; color: var(--danger); }
</style>
