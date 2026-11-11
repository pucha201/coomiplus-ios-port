<script setup lang="ts">
/**
 * 概览卡：这一页最重要的状态。
 * 左圆位 + 标题 + 副标题，可选底部状态条（发丝线 + 状态点 + 尾巴值）。
 */
import CoomiIcon from '@/components/CoomiIcon.vue'

withDefaults(defineProps<{
  icon?: string
  title: string
  subtitle?: string
  /** 底部状态条文字；不传则不显示状态条。 */
  footer?: string
  /** 状态点是否点亮。 */
  online?: boolean
  /** 状态条右侧的补充值。 */
  footerTail?: string
  chevron?: boolean
}>(), { chevron: true })

const emit = defineEmits<{ click: [] }>()
</script>

<template>
  <div class="ov" role="button" tabindex="0" @click="emit('click')" @keydown.enter="emit('click')">
    <div class="head">
      <span class="avatar"><CoomiIcon :name="icon || 'sparkle'" :size="24" /></span>
      <div class="text">
        <p class="title">{{ title }}</p>
        <p v-if="subtitle" class="sub">{{ subtitle }}</p>
      </div>
      <CoomiIcon v-if="chevron" name="chevronRight" :size="16" class="chev" />
    </div>
    <div v-if="footer" class="foot">
      <span class="dot" :class="{ on: online }" />
      <span class="foot-text">{{ footer }}</span>
      <span v-if="footerTail" class="foot-tail">{{ footerTail }}</span>
    </div>
  </div>
</template>

<style scoped>
.ov {
  margin-bottom: var(--sp-2);
  border-radius: var(--r-sheet); background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .04), 0 6px 18px rgba(23, 32, 54, .05);
  overflow: hidden; cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-out);
}
.ov:active { transform: scale(var(--press-scale)); }
.head { display: flex; align-items: center; gap: var(--sp-3); padding: var(--sp-4) var(--sp-3) var(--sp-4) var(--sp-4); }
.avatar {
  display: grid; place-items: center; flex: none;
  width: 52px; height: 52px; border-radius: 50%;
  background: var(--blue-soft); color: var(--blue);
}
.text { flex: 1; min-width: 0; }
.title {
  margin: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-strong); font-weight: 600; color: var(--text);
}
.sub {
  margin: var(--sp-1) 0 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-sub); color: var(--text-3); font-variant-numeric: tabular-nums;
}
.chev { flex: none; color: var(--text-3); }
.foot {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: 44px; padding: 0 var(--sp-4);
  border-top: .5px solid color-mix(in srgb, var(--text) 8%, transparent);
  font-size: var(--fs-label); color: var(--text-3);
}
.dot { width: 6px; height: 6px; border-radius: 50%; background: var(--text-3); flex: none; }
.dot.on { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.foot-text { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.foot-tail { flex: none; font-variant-numeric: tabular-nums; }
</style>
