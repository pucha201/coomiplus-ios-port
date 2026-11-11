<script setup lang="ts">
/** 统一弹层组件：居中/底部/侧滑 */
withDefaults(defineProps<{
  open: boolean
  variant?: 'center' | 'bottom' | 'right' | 'left'
  width?: string
}>(), {
  variant: 'center', width: '',
})

const emit = defineEmits<{ close: [] }>()
</script>

<template>
  <Teleport to="body">
    <Transition name="mask">
      <div v-if="open" class="ui-modal-mask" :class="`ui-modal-mask--${variant}`" @click="emit('close')" />
    </Transition>
    <Transition :name="`panel-${variant}`">
      <div v-if="open" class="ui-modal" :class="`ui-modal--${variant}`" :style="{ width }" @click.stop>
        <slot />
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.ui-modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(10, 15, 24, .45);
  z-index: calc(var(--z-modal) - 1); /* 原 --z-overlay 未定义（死令牌），改用既有层级 */
}

.ui-modal {
  position: fixed;
  z-index: var(--z-modal);
  background: var(--bg);
  box-shadow: var(--shadow-2); /* 原 --shadow-lg 未定义，改用既有阴影令牌 */
}

.ui-modal--center {
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  border-radius: var(--r-card);
  max-width: 92vw;
  max-height: 85vh;
  overflow-y: auto;
  /* 入场/退场交给下方 <Transition> 的 .panel-center-* 类驱动：
     原 animation 引用了未定义变量（--dur-normal/--ease）从不生效，打开等于硬切。 */
}

.ui-modal--bottom {
  bottom: 0;
  left: 0;
  right: 0;
  border-radius: var(--r-card) var(--r-card) 0 0;
  max-height: 85vh;
  overflow-y: auto;
  /* 同 center：滑入/滑出由 .panel-bottom-* 过渡类负责 */
  padding-bottom: env(safe-area-inset-bottom, 0);
}

.ui-modal--right {
  top: 0;
  right: 0;
  bottom: 0;
  width: min(90vw, 340px);
  border-radius: 0;
  display: flex;
  flex-direction: column;
  /* 同 center：滑入/滑出由 .panel-right-* 过渡类负责 */
}

.ui-modal--left {
  top: 0;
  left: 0;
  bottom: 0;
  width: min(90vw, 340px);
  border-radius: 0;
  display: flex;
  flex-direction: column;
  /* 同 center：滑入/滑出由 .panel-left-* 过渡类负责 */
}

/* 过渡：时长/缓动只取既有令牌（--dur-base 220ms + --ease-out）。
   位移语义：居中 = enter-pop（scale 弹入）、底部 = slideUp、左右 = 抽屉滑入。 */
.mask-enter-active, .mask-leave-active { transition: opacity var(--dur-base) var(--ease-out); }
.mask-enter-from, .mask-leave-to { opacity: 0; }

.panel-center-enter-active, .panel-center-leave-active {
  transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}
.panel-center-enter-from, .panel-center-leave-to { opacity: 0; transform: translate(-50%, -50%) scale(.95); }

.panel-bottom-enter-active, .panel-bottom-leave-active { transition: transform var(--dur-base) var(--ease-out); }
.panel-bottom-enter-from, .panel-bottom-leave-to { transform: translateY(100%); }

.panel-right-enter-active, .panel-right-leave-active { transition: transform var(--dur-base) var(--ease-out); }
.panel-right-enter-from, .panel-right-leave-to { transform: translateX(100%); }

.panel-left-enter-active, .panel-left-leave-active { transition: transform var(--dur-base) var(--ease-out); }
.panel-left-enter-from, .panel-left-leave-to { transform: translateX(-100%); }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关两入口一致） */
@media (prefers-reduced-motion: reduce) {
  .mask-enter-active, .mask-leave-active,
  .panel-center-enter-active, .panel-center-leave-active,
  .panel-bottom-enter-active, .panel-bottom-leave-active,
  .panel-right-enter-active, .panel-right-leave-active,
  .panel-left-enter-active, .panel-left-leave-active { transition: none; }
  /* 起始/结束态压到最终态，保证关闭时也不回弹 */
  .mask-enter-from, .mask-leave-to { opacity: 1; }
  .panel-center-enter-from, .panel-center-leave-to { opacity: 1; transform: translate(-50%, -50%); }
  .panel-bottom-enter-from, .panel-bottom-leave-to { transform: none; }
  .panel-right-enter-from, .panel-right-leave-to { transform: none; }
  .panel-left-enter-from, .panel-left-leave-to { transform: none; }
}
:root[data-motion='off'] .mask-enter-active, :root[data-motion='off'] .mask-leave-active,
:root[data-motion='off'] .panel-center-enter-active, :root[data-motion='off'] .panel-center-leave-active,
:root[data-motion='off'] .panel-bottom-enter-active, :root[data-motion='off'] .panel-bottom-leave-active,
:root[data-motion='off'] .panel-right-enter-active, :root[data-motion='off'] .panel-right-leave-active,
:root[data-motion='off'] .panel-left-enter-active, :root[data-motion='off'] .panel-left-leave-active {
  transition: none;
}
</style>
