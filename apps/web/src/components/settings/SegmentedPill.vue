<script setup lang="ts">
/** 分段选择：等高 38，选中态白底蓝字；放进分组行内使用。 */

withDefaults(defineProps<{
  options: Array<{ value: string | number; label: string }>
  modelValue: string | number
  disabled?: boolean
}>(), {})

const emit = defineEmits<{ 'update:modelValue': [value: string | number] }>()
</script>

<template>
  <div class="seg" role="tablist">
    <button
      v-for="o in options"
      :key="o.value"
      type="button"
      role="tab"
      :aria-selected="o.value === modelValue"
      :disabled="disabled"
      :class="{ on: o.value === modelValue }"
      @click="emit('update:modelValue', o.value)"
    >{{ o.label }}</button>
  </div>
</template>

<style scoped>
.seg {
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: var(--sp-1); margin-top: var(--sp-3); padding: var(--sp-1);
  border-radius: var(--r-md); background: var(--fill);
}
.seg button {
  min-height: 38px; padding: 0 var(--sp-1);
  border-radius: var(--r-sm); background: transparent;
  color: var(--text-2); font-size: var(--fs-sub); font-weight: 500;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.seg button.on {
  background: var(--bg); color: var(--blue); font-weight: 600;
  box-shadow: 0 1px 3px rgba(23, 32, 54, .08);
}
.seg button:disabled { opacity: .45; }
</style>
