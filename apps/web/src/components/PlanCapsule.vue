<script setup lang="ts">
/**
 * 计划胶囊：输入栏上方**唯一**的计划状态。
 *
 * · 有计划（update_plan 出来了）：左侧转圈 → 全部完成打勾；中间「已完成 / 总数」；
 *   点击向上展开任务清单，再点收起（收起也有动画）。
 * · 只有计划模式、还没有计划：显示「计划模式」+ 退出入口，替代以前那条大方框。
 * 功能托盘（+ 面板）展开时整条隐藏：由父组件控制 `hidden`。
 */
import { computed, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { PlanStepItem } from '@/protocol/events'

const props = withDefaults(defineProps<{
  steps: PlanStepItem[]
  completed: number
  total: number
  /** 父级要它让位（例如功能面板已展开）。 */
  hidden?: boolean
  /** 计划模式开着：没有计划时也要给一个可见的退出入口。 */
  modeOn?: boolean
}>(), { modeOn: false })

const emit = defineEmits<{ exit: [] }>()

const open = ref(false)

const hasPlan = computed(() => props.total > 0)
const allDone = computed(() => hasPlan.value && props.completed >= props.total)
const label = computed(() => (hasPlan.value ? `${props.completed} / ${props.total}` : '计划模式'))
const visible = computed(() => !props.hidden && (hasPlan.value || props.modeOn))

function toggle() {
  if (!hasPlan.value) { emit('exit'); return }
  open.value = !open.value
}
</script>

<template>
  <div v-if="visible" class="wrap">
    <!-- 清单在胶囊**上方**展开：输入栏贴底，向上长不会把它顶出屏幕。 -->
    <Transition name="plan-list">
      <ul v-if="open && hasPlan" class="list">
        <li
          v-for="(s, i) in steps"
          :key="i"
          class="item"
          :class="s.status"
        >
          <span class="bullet" aria-hidden="true">
            <CoomiIcon v-if="s.status === 'completed'" name="check" :size="10" />
            <span v-else-if="s.status === 'in_progress'" class="dot" />
          </span>
          <span class="item-text">{{ s.text }}</span>
        </li>
      </ul>
    </Transition>

    <button
      class="pill"
      :class="{ 'mode-only': !hasPlan }"
      type="button"
      :aria-expanded="hasPlan ? open : undefined"
      :aria-label="hasPlan ? `计划进度 ${label}` : '退出计划模式'"
      @click="toggle"
    >
      <span v-if="hasPlan" class="mark" :class="{ done: allDone }">
        <span v-if="!allDone" class="ring" aria-hidden="true" />
        <CoomiIcon v-else name="check" :size="11" />
      </span>
      <CoomiIcon v-else name="target" :size="13" class="mode-ico" />
      <span class="text">{{ label }}</span>
      <CoomiIcon v-if="hasPlan" name="chevronDown" :size="13" class="chev" :class="{ up: open }" />
      <span v-else class="exit">退出</span>
    </button>
  </div>
</template>

<style scoped>
.wrap { margin: 0 var(--sp-3) var(--sp-2); }

.pill {
  display: inline-flex; align-items: center; gap: var(--sp-2);
  min-height: 30px; padding: 0 var(--sp-2) 0 9px;
  border-radius: var(--r-pill);
  background: var(--fill);
  color: var(--text-2);
  font-size: var(--fs-label); font-weight: 500;
  transition: background var(--dur-fast) var(--ease-out);
}
.pill:active { background: var(--fill-strong); }
.pill.mode-only { color: var(--blue); background: var(--blue-soft); }
.mode-ico { flex: none; color: var(--blue); }

.mark {
  display: grid; place-items: center; flex: none;
  width: 16px; height: 16px; border-radius: 50%;
  color: var(--blue);
}
.mark.done { background: var(--blue-soft); }
/* 细圆弧：1.5px、每秒一圈，和 dsh-go 的 QuietArc 同速 */
.ring {
  width: 13px; height: 13px; border-radius: 50%;
  border: 1.5px solid color-mix(in srgb, var(--blue) 26%, transparent);
  border-top-color: var(--blue);
  animation: plan-spin 1s linear infinite;
}
@keyframes plan-spin { to { transform: rotate(360deg); } }

.text { font-variant-numeric: tabular-nums; }
.exit {
  flex: none; padding: 0 var(--sp-2); border-radius: var(--r-pill);
  background: var(--bg); color: var(--blue);
  font-size: var(--fs-caption); font-weight: 600; line-height: var(--lh-body);
}
.chev { flex: none; color: var(--text-3); transition: transform var(--dur-fast) var(--ease-out); }
.chev.up { transform: rotate(180deg); }

.list {
  margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3);
  list-style: none; border-radius: var(--r-md);
  background: var(--bg); border: 1px solid var(--border);
  max-height: 40vh; overflow-y: auto;
  transform-origin: bottom left;
}
.item {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: 5px 0; font-size: var(--fs-label); line-height: 1.5;
}
.bullet {
  display: grid; place-items: center; flex: none;
  width: 16px; height: 16px; margin-top: 1px; border-radius: 50%;
  border: 1px solid var(--border-strong); color: var(--blue);
}
.item.completed .bullet { border-color: transparent; background: var(--blue-soft); }
.item.in_progress .bullet { border-color: var(--blue); }
.dot { width: 5px; height: 5px; border-radius: 50%; background: var(--blue); }
.item-text { flex: 1; min-width: 0; color: var(--text-2); }
.item.completed .item-text { color: var(--text-3); }
.item.in_progress .item-text { color: var(--text); font-weight: 500; }

/* 展开/收起都有动画：从胶囊底边向上长出来（transform-origin 在 .list 上）。 */
.plan-list-enter-active, .plan-list-leave-active {
  transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out);
}
.plan-list-enter-from, .plan-list-leave-to { opacity: 0; transform: translateY(6px) scale(.98); }

@media (prefers-reduced-motion: reduce) {
  .ring { animation: none; }
  .plan-list-enter-active, .plan-list-leave-active { transition: none; }
}
</style>
