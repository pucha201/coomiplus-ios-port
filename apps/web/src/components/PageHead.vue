<script setup lang="ts">
/**
 * 二级页头。返回箭头 + 标题，右侧留一个插槽给页面自己的动作。
 *
 * 视觉与设置页顶栏同一套：透明底、模糊圆形返回键、无分割线；
 * 页面正文自己滚，这里不抢滚动所有权。
 */
import CoomiIcon from './CoomiIcon.vue'

defineProps<{ title: string; subtitle?: string }>()
const emit = defineEmits<{ back: [] }>()
</script>

<template>
  <header class="bar">
    <button class="icon-btn" aria-label="返回" @click="emit('back')">
      <CoomiIcon name="back" :size="20" />
    </button>
    <div class="titles">
      <h1 class="title">{{ title }}</h1>
      <p v-if="subtitle" class="subtitle">{{ subtitle }}</p>
    </div>
    <div class="right"><slot name="right" /></div>
  </header>
</template>

<style scoped>
.bar {
  display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0;
  padding: calc(var(--safe-top) + var(--sp-2)) var(--sp-2) var(--sp-2);
  background: var(--page);
}
.icon-btn {
  display: grid; place-items: center; flex: none; width: 40px; height: 40px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 72%, transparent); color: var(--text);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .06);
}
.titles { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; padding-left: var(--sp-1); }
.title {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-title); font-weight: 600; line-height: 1.3;
  letter-spacing: -0.02em; color: var(--text);
}
.subtitle {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-label); line-height: 1.4; color: var(--text-3);
}
.right { display: flex; align-items: center; gap: var(--sp-1); min-width: 40px; justify-content: flex-end; }
</style>
