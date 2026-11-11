<script setup lang="ts">
/** 统一卡片组件 */
withDefaults(defineProps<{
  padding?: 'none' | 'sm' | 'md' | 'lg'
  hover?: boolean
  clickable?: boolean
}>(), {
  padding: 'md', hover: false, clickable: false,
})
</script>

<template>
  <div :class="['ui-card', `ui-card--${padding}`, { 'ui-card--hover': hover, 'ui-card--clickable': clickable }]">
    <slot />
  </div>
</template>

<style scoped>
.ui-card {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--r-card); /* 原 --r-lg 未定义，改用既有圆角令牌 */
  /* 原 var(--shadow-xs) 是未定义令牌（全局只有 --shadow-1/-2），
     声明整体失效 = 这张卡片一直没有阴影；统一改用 --shadow-1。 */
  box-shadow: var(--shadow-1);
  /* 不用 transition: all：卡片内容变化会连带过渡 width/height/margin，
     白白触发重排，还容易和卡片内部的入场动画抢 transform。 */
  transition:
    border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}

.ui-card--none { padding: 0; }
.ui-card--sm { padding: var(--sp-3); }
.ui-card--md { padding: var(--sp-4); }
.ui-card--lg { padding: var(--sp-6); }

.ui-card--hover:hover {
  /* --shadow-md 同样未定义 → 悬停时阴影没有加深，只有描边变了。改用 --shadow-2。 */
  box-shadow: var(--shadow-2);
  border-color: var(--border-strong);
}

.ui-card--clickable {
  cursor: pointer;
}
.ui-card--clickable:active {
  /* 按下时压掉阴影（离页面更近），不是再加一层 —— 加深会读成「浮起来了」。 */
  transform: scale(var(--press-scale));
  box-shadow: none;
}
</style>
