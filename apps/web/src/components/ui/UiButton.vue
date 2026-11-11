<script setup lang="ts">
/** 统一按钮组件：动效令牌 + spring 按压 */
withDefaults(defineProps<{
  variant?: 'primary' | 'ghost' | 'danger' | 'outline' | 'blue-soft'
  size?: 'sm' | 'md' | 'lg'
  disabled?: boolean
  block?: boolean
}>(), {
  variant: 'primary', size: 'md', disabled: false, block: false,
})
</script>

<template>
  <button
    :class="[
      'ui-btn',
      `ui-btn--${variant}`,
      `ui-btn--${size}`,
      { 'ui-btn--block': block, 'ui-btn--disabled': disabled },
    ]"
    :disabled="disabled"
  >
    <slot />
  </button>
</template>

<style scoped>
.ui-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  border: none;
  border-radius: var(--r-md);
  font-weight: 600;
  white-space: nowrap;
  transition:
    background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out), opacity var(--dur-fast) var(--ease-out);
  cursor: pointer;
}
.ui-btn:active:not(:disabled) {
  transform: scale(var(--press-scale));
}
.ui-btn:focus-visible {
  outline: 2px solid var(--blue);
  outline-offset: 2px;
}
.ui-btn--block { width: 100%; }

.ui-btn--sm {  min-height: 32px; padding: 0 var(--sp-3); font-size: var(--fs-sub); }
.ui-btn--md {  min-height: 40px; padding: 0 var(--sp-4); font-size: var(--fs-body); }
.ui-btn--lg {  min-height: 48px; padding: 0 var(--sp-6); font-size: var(--fs-body-lg); }

.ui-btn--primary {
  background: var(--blue);
  color: #fff;
  box-shadow: 0 1px 2px color-mix(in srgb, var(--blue) 30%, transparent);
}
.ui-btn--primary:hover:not(:disabled) { background: color-mix(in srgb, var(--blue) 92%, #000); }
.ui-btn--primary:active:not(:disabled) {
  background: var(--blue-press);
  transform: scale(var(--press-scale));
  box-shadow: none;
}

.ui-btn--ghost {
  background: var(--fill);
  color: var(--text);
}
.ui-btn--ghost:hover:not(:disabled) { background: var(--fill-strong); }

.ui-btn--danger {
  background: var(--danger);
  color: #fff;
}
.ui-btn--danger:hover:not(:disabled) { background: color-mix(in srgb, var(--danger) 90%, #000); }
.ui-btn--danger:active:not(:disabled) {
  transform: scale(var(--press-scale));
  background: color-mix(in srgb, var(--danger) 85%, #000);
}

.ui-btn--outline {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text);
}
.ui-btn--outline:hover:not(:disabled) {
  background: var(--fill);
  border-color: var(--border-strong);
}

.ui-btn--blue-soft {
  background: var(--blue-soft);
  color: var(--blue);
}
.ui-btn--blue-soft:hover:not(:disabled) {
  background: var(--blue-soft-2);
}

.ui-btn--disabled {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
  box-shadow: none;
}
</style>
