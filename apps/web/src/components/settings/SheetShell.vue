<script setup lang="ts">
/**
 * 底部弹层外壳：拖把手 + 标题行（左标题右关闭）+ 内容 + 至多一个主按钮。
 * 圆角 28，内容左右 16。
 */
import CoomiIcon from '@/components/CoomiIcon.vue'

withDefaults(defineProps<{
  title: string
  /** 主按钮文字；不传则不显示。 */
  action?: string
  actionDisabled?: boolean
}>(), {})

const emit = defineEmits<{ close: []; action: [] }>()

function onMask(e: MouseEvent) {
  if (e.target === e.currentTarget) emit('close')
}
</script>

<template>
  <div class="mask" @click="onMask">
    <section class="sheet" role="dialog" aria-modal="true" :aria-label="title">
      <div class="grab" />
      <header class="head">
        <span class="title">{{ title }}</span>
        <button class="x" type="button" aria-label="关闭" @click="emit('close')">
          <CoomiIcon name="close" :size="17" />
        </button>
      </header>
      <div class="body"><slot /></div>
      <footer v-if="action" class="foot">
        <button class="primary" type="button" :disabled="actionDisabled" @click="emit('action')">{{ action }}</button>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-sheet);
  display: flex; align-items: flex-end; background: rgba(17, 22, 31, .4);
}
.sheet {
  width: 100%; max-height: 82vh; display: flex; flex-direction: column;
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); overflow: hidden;
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grab {
  width: 36px; height: 4px; margin: var(--sp-2) auto 0;
  border-radius: var(--r-pill); background: var(--border-strong);
}
.head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4); border-bottom: .5px solid color-mix(in srgb, var(--text) 8%, transparent);
}
.title { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-strong); font-weight: 600; color: var(--text); }
.x { display: grid; place-items: center; flex: none; width: 32px; height: 32px; border-radius: 50%; background: var(--fill); color: var(--text-2); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom)); }
.foot { padding: 0 var(--sp-4) calc(var(--sp-3) + var(--safe-bottom)); border-top: .5px solid color-mix(in srgb, var(--text) 8%, transparent); }
.primary {
  width: 100%; min-height: 46px; margin-top: var(--sp-3);
  border-radius: var(--r-md); background: var(--blue); color: #fff;
  font-size: var(--fs-sub); font-weight: 600;
}
.primary:disabled { background: var(--fill-strong); color: var(--text-3); }
@media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }
:root[data-motion='off'] .sheet { animation: none; }
</style>
