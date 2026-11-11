<script setup lang="ts">
/** 44×26 胶囊开关；圆点 20，`--dur-base` 过渡，按下不缩放（行负责按压反馈）。 */
withDefaults(defineProps<{ modelValue: boolean; disabled?: boolean }>(), {})
const emit = defineEmits<{ 'update:modelValue': [value: boolean] }>()
</script>

<template>
  <button
    class="sw"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :disabled="disabled"
    :class="{ on: modelValue }"
    @click="emit('update:modelValue', !modelValue)"
  >
    <i />
  </button>
</template>

<style scoped>
.sw {
  position: relative; flex: none;
  width: 44px; height: 26px; padding: 0;
  border-radius: var(--r-pill); background: var(--border-strong);
  transition: background var(--dur-base) var(--ease-out);
}
.sw i {
  position: absolute; top: 3px; left: 3px; display: block;
  width: 20px; height: 20px; border-radius: 50%; background: #fff;
  box-shadow: 0 1px 2px rgba(23, 32, 54, .18);
  transition: transform var(--dur-base) var(--ease-out);
}
.sw.on { background: var(--blue); }
.sw.on i { transform: translateX(18px); }
.sw:disabled { opacity: .45; }
</style>
