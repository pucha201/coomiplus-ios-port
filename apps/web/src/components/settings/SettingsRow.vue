<script setup lang="ts">
/**
 * 设置行：图标 + 标题 + 副标题 + 右侧值/开关/箭头。
 * 单行 56、两行 68；右侧值最多占 45%，超长省略。
 */
import CoomiIcon from '@/components/CoomiIcon.vue'
import SettingsSwitch from './SettingsSwitch.vue'

const props = withDefaults(defineProps<{
  icon?: string
  /** 首字母圆牌（渠道行用）：给了就替代 icon。 */
  letter?: string
  title: string
  subtitle?: string
  /** 行尾状态点。 */
  dot?: 'ok' | 'warn' | 'error' | 'idle'
  /** 右侧当前值文字。 */
  value?: string | number
  /** 值的语义色。 */
  tone?: 'default' | 'accent' | 'ok' | 'warn' | 'danger'
  /**
   * 开关状态。用字符串而不是 boolean：Vue 会把缺省的 Boolean prop 强制转成 false，
   * 那样每个纯入口行都会长出一个关闭态开关。
   */
  switchState?: 'on' | 'off'
  /** 显示右箭头。 */
  chevron?: boolean
  disabled?: boolean
  /** 副标题使用危险色（错误提示就地显示）。 */
  subtitleDanger?: boolean
}>(), { tone: 'default' })

const emit = defineEmits<{
  click: []
  'update:switch': [value: 'on' | 'off']
}>()

function onRow(e: Event) {
  if (props.disabled) return
  // 点在开关上由开关自己处理，避免重复触发。
  if ((e.target as HTMLElement).closest('.sw-hit')) return
  emit('click')
}

</script>

<template>
  <div
    class="row"
    :class="{ disabled }"
    role="button"
    :tabindex="disabled ? -1 : 0"
    :aria-disabled="disabled || undefined"
    @click="onRow"
    @keydown.enter="onRow"
  >
    <span v-if="letter" class="mono">{{ letter }}</span>
    <span v-else-if="icon" class="ico"><CoomiIcon :name="icon" :size="18" /></span>
    <span class="rt">
      <span class="rmain">{{ title }}</span>
      <span v-if="subtitle" class="rsub" :class="{ danger: subtitleDanger }">{{ subtitle }}</span>
    </span>
    <span v-if="value !== undefined && value !== ''" class="rval" :class="tone">{{ value }}</span>
    <span v-if="dot" class="dot" :class="dot" />
    <span v-if="switchState" class="sw-hit">
      <SettingsSwitch :model-value="switchState === 'on'" :disabled="disabled" @update:model-value="v => emit('update:switch', v ? 'on' : 'off')" />
    </span>
    <CoomiIcon v-else-if="chevron" name="chevronRight" :size="15" class="arw" />
  </div>
</template>

<style scoped>
.row {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; min-height: 56px; padding: 10px var(--sp-3) 10px var(--sp-4);
  text-align: left; background: transparent; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.row:active { background: var(--fill); }
.row.disabled { opacity: .45; cursor: default; }
.row.disabled:active { background: transparent; }
.ico {
  display: grid; place-items: center; flex: none;
  width: 32px; height: 32px; border-radius: var(--r-sm);
  background: var(--fill-strong); color: var(--text-2);
}
.rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.rmain { font-size: var(--fs-body-lg); font-weight: 500; line-height: 1.4; color: var(--text); }
.rsub { font-size: var(--fs-label); line-height: 1.5; color: var(--text-3); }
.rsub.danger { color: var(--danger); }
.rval {
  flex: none; max-width: 45%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-sub); color: var(--text-3); font-variant-numeric: tabular-nums;
}
.rval.accent { color: var(--blue); font-weight: 600; }
.rval.ok { color: var(--ok); }
.rval.warn { color: var(--warn); }
.rval.danger { color: var(--danger); }
.sw-hit { flex: none; display: flex; }
.arw { flex: none; color: var(--text-3); }
/* 渠道行首字母圆牌：中性圆底，不用品牌色（与 dsh-go Monogram 同口径）。 */
.mono {
  display: grid; place-items: center; flex: none;
  width: 32px; min-height: 32px; aspect-ratio: 1; border-radius: 50%;
  background: var(--fill-strong);
  font-size: var(--fs-body); font-weight: 600; line-height: 1; color: var(--text-2);
}
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--text-3); }
.dot.ok { background: var(--ok); }
.dot.warn { background: var(--warn); }
.dot.error { background: var(--danger); }
.dot.idle { background: var(--text-3); }
</style>
