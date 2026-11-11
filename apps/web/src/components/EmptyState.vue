<script setup lang="ts">
/**
 * 新会话空态：品牌标记 + 格言 + 一句副文案。
 * 结构与文案对齐 Comax（姊妹 App）：图标用 CoomiMark，主文案是格言，
 * 副文案只说一句「准备好了，就告诉我想做什么」。
 *
 * 动效不用 GSAP：入场是三段错开的 CSS 动画，呼吸只动 transform / opacity，
 * 避免每帧重绘（低端机上 box-shadow 动画是明显的掉帧源）。
 */

/** 卸载前一帧：把 logo 位置交出去，好让生成态的 logo 从这里飞过去。 */
const emit = defineEmits<{ (e: 'before-leave', el: Element): void }>()
import { useConnectionStore } from '@/stores/connection'
import CoomiIcon from './CoomiIcon.vue'
import CoomiMark from './CoomiMark.vue'
import { reportFlyTo } from './logoFly'

/** 卸载前把 logo 的屏幕坐标交出去，供生成态的 logo 做飞移起点。 */
function onEmptyLeave(el: Element): void {
  reportFlyTo(el.querySelector('.logo-orbit') ?? el)
  emit('before-leave', el)
}

const connection = useConnectionStore()

// 引擎就绪后收到存储权限强弹事件：无权限则引导授权。
window.addEventListener('coomi:ensure-storage', () => {
  const bridge = (window as any).CoomiAndroid
  bridge?.ensureStoragePermission?.()
})
</script>

<template>
  <div class="empty-sm">
    <div class="brand-aura logo-orbit"><CoomiMark :size="64" class="logo" /></div>
    <p class="motto">海内存知己，天涯若比邻</p>
    <p class="sub">准备好了，就告诉我想做什么</p>

    <p v-if="connection.demo" class="demobar">
      <CoomiIcon name="alert" :size="14" />
      <span>演示模式：对话由脚本驱动，只用来预览界面，不会真的执行任何命令。</span>
    </p>
  </div>
</template>

<style scoped>
.empty-sm {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 34px var(--sp-1) 18px;
}

.brand-aura {
  display: grid;
  place-items: center;
  padding: var(--sp-4);
  border-radius: 50%;
  will-change: transform;
  animation: aura-breath 4.8s var(--ease-in-out) 1.1s infinite;
}
.logo { display: block; animation: logo-in .55s var(--ease-out) both; }

.motto {
  margin: var(--sp-3) 0 0;
  color: var(--text);
  font-size: 17px;
  line-height: 1.6;
  font-weight: 750;
  letter-spacing: .04em;
  animation: rise-in .45s var(--ease-out) .2s both;
}
.sub {
  margin: var(--sp-2) 0 0;
  color: var(--text-3);
  font-size: var(--fs-sub);
  animation: rise-in .4s var(--ease-out) .35s both;
}
.demobar {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  max-width: 320px;
  margin-top: var(--sp-4);
  padding: 9px var(--sp-3);
  border-radius: var(--r-md);
  background: var(--orange-soft);
  color: var(--orange);
  font-size: 12.5px;
  line-height: 1.55;
  text-align: left;
  animation: rise-in .35s var(--ease-out) .5s both;
}
.demobar :deep(svg) { flex-shrink: 0; margin-top: 1px; }

@keyframes logo-in {
  from { opacity: 0; transform: scale(.86); }
  to { opacity: 1; transform: scale(1); }
}
@keyframes rise-in {
  from { opacity: 0; transform: translateY(9px); }
  to { opacity: 1; transform: translateY(0); }
}
/* 呼吸只动 translateY，和入场动画的 scale 互不覆盖。 */
@keyframes aura-breath {
  0%, 100% { transform: translateY(0); }
  50% { transform: translateY(-6px); }
}
@media (prefers-reduced-motion: reduce) {
  .brand-aura, .logo, .motto, .sub, .demobar { animation: none; }
}
</style>
