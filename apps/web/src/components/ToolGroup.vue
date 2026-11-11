<script setup lang="ts">
/**
 * 连续工具调用的分组容器。
 * 单个调用不套壳；两个以上折成一组，跑的时候自动展开、全部结束后自动收起，
 * 用户手动点过之后就听用户的。长任务几十次调用不会把时间线冲成卡片墙。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import type { ToolCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'
import { toolGroupOpenState } from '@/utils/processState'
import { useSessionStore } from '@/stores/session'
import ToolCardItem from './ToolCardItem.vue'

const props = defineProps<{ cards: ToolCard[]; noEnter?: boolean }>()
const session = useSessionStore()

/**
 * 用户手动开合的结果按「组」记，不按组件实例记：
 * vue-virtual-scroller 会把滚出视口的行销毁、滚回来再重建，本地 ref 一滚就丢。
 * 组键 = 会话 + 第一张卡的 callId（组只会往尾部追加调用，首卡是稳定标识）。
 * 带上会话：不同会话的 callId 可能重复，旧开合态不能串进新会话。
 */
const groupKey = computed(() => `${session.sessionId}:${props.cards[0]?.callId ?? ''}`)
const manual = computed<boolean | null>(() => (props.cards[0] ? toolGroupOpenState.get(groupKey.value) ?? null : null))

const active = computed(() =>
  props.cards.some(c => c.status === 'running' || c.status === 'starting' || c.status === 'awaiting_approval'),
)
/** 只在用户主动打开时展示详情；运行中不再自动撑高时间线。 */
const open = computed(() => manual.value === true)
const finished = computed(() => props.cards.filter(c => c.status !== 'running' && c.status !== 'starting' && c.status !== 'awaiting_approval').length)
const failed = computed(() => props.cards.filter(c => c.status === 'error').length)
const elapsed = computed(() => props.cards.reduce((s, c) => s + (c.elapsed ?? 0), 0))

const summary = computed(() => {
  if (active.value) return `进行中 ${finished.value}/${props.cards.length}`
  if (failed.value) return `${failed.value} 个失败`
  return '全部完成'
})

/** 打开瞬间冻结列表：流式期间 tool 状态继续变，但弹层不跟着重渲染。 */
const sheetSnapshot = ref(0)
watch(open, (value) => { if (value) sheetSnapshot.value += 1 })

function onHeadToggle() {
  toolGroupOpenState.set(groupKey.value, !open.value)
}

/**
 * 分组详情也是 body 级浮层：系统返回必须先收起它。
 * 以前它没登记返回栈，展开工具分组后按返回键会直接走「退出应用」那条路。
 */
const overlayId = computed(() => `tool-group:${groupKey.value}`)
let registeredOverlayId = ''
watch(open, isOpen => {
  if (isOpen) {
    registeredOverlayId = overlayId.value
    registerOverlay(registeredOverlayId, onHeadToggle)
  } else if (registeredOverlayId) {
    unregisterOverlay(registeredOverlayId)
    registeredOverlayId = ''
  }
}, { immediate: true })
onBeforeUnmount(() => {
  if (registeredOverlayId) unregisterOverlay(registeredOverlayId)
})

const cls = computed(() => (active.value ? 'run' : failed.value ? 'err' : 'ok'))
</script>

<template>
  <ToolCardItem v-if="cards.length === 1" :card="cards[0]" :class="{ cascade: !noEnter }" />

  <div v-else class="group" :class="[cls, { cascade: !noEnter }]">
    <button class="ghead" @click="onHeadToggle">
      <span class="gicon" :class="cls"><CoomiIcon name="wrench" :size="16" /></span>
      <span class="gtitle">工具调用 · {{ cards.length }}</span>
      <span class="gsum" :class="cls">{{ summary }}</span>
      <span v-if="!active && elapsed > 0" class="gms">{{ elapsed.toFixed(1) }}s</span>
      <CoomiIcon name="chevronRight" :size="14" class="gchev" :class="{ open }" />
    </button>

    <div v-if="!open" class="peek">
      <code v-for="c in cards.slice(0, 3)" :key="c.callId" class="pchip">{{ c.toolName }}</code>
      <span v-if="cards.length > 3" class="pmore">+{{ cards.length - 3 }}</span>
    </div>

    <Teleport to="body">
      <Transition name="sheet-pop">
      <div v-if="open" class="g-sheet-mask" @click.self="onHeadToggle">
        <section class="g-sheet" role="dialog" aria-modal="true" aria-label="工具调用列表">
          <div class="g-grip" />
          <header class="g-sheet-head">
            <span class="gicon" :class="cls"><CoomiIcon name="wrench" :size="16" /></span>
            <span class="gtitle">工具调用 · {{ cards.length }}</span>
            <span class="gsum" :class="cls">{{ summary }}</span>
            <button class="g-close" aria-label="关闭" @click="onHeadToggle"><CoomiIcon name="close" :size="16" /></button>
          </header>
          <div class="g-sheet-body" v-memo="[sheetSnapshot]">
            <ToolCardItem v-for="c in cards" :key="c.callId" :card="c" />
          </div>
        </section>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
.group {
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); overflow: hidden;
}
.group.run { border-color: var(--blue-border); }
.group.err { border-color: var(--danger-border); }

.ghead {
  display: flex; align-items: center; gap: 9px;
  width: 100%; min-height: 44px; padding: 7px 11px;
  border: 0; background: none; text-align: left;
}
.ghead:active { background: var(--fill-press); }

.gicon {
  display: grid; place-items: center; flex-shrink: 0;
  width: 27px; height: 27px; border-radius: var(--r-sm);
  background: var(--bg); color: var(--text-2);
}
.gicon.run { color: var(--blue); }
.gicon.err { color: var(--danger); }
.gicon.ok { color: var(--ok); }

.gtitle { flex: 1; min-width: 0; font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.gsum { flex-shrink: 0; font-size: var(--fs-caption); font-weight: 600; color: var(--text-3); }
.gsum.run { color: var(--blue); }
.gsum.err { color: var(--danger); }
.gsum.ok { color: var(--ok); }
.gms { flex-shrink: 0; font-size: var(--fs-caption); color: var(--text-3); }
.gchev { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.gchev.open { transform: rotate(90deg); }

.peek { display: flex; align-items: center; gap: 5px; padding: 0 11px 10px; }
.pchip {
  padding: 2px var(--sp-2); border-radius: var(--r-pill);
  background: var(--bg); border: 1px solid var(--border);
  font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-2);
}
.pmore { font-size: var(--fs-caption); color: var(--text-3); }

/* 组详情也走独立 sheet：打开/关闭不再改变时间线高度。 */
.g-sheet-mask {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .42);
}
.g-sheet {
  width: 100%; max-width: 620px; max-height: 86vh;
  display: flex; flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); box-shadow: var(--shadow-sheet);
  will-change: transform;
}
.g-grip {
  width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-2);
  border-radius: var(--r-pill); background: var(--fill-strong); flex-shrink: 0;
}
.g-sheet-head {
  display: flex; align-items: center; gap: var(--sp-2);
  padding-bottom: var(--sp-2); flex-shrink: 0;
}
.g-close {
  display: grid; place-items: center; width: var(--sp-8); height: var(--sp-8);
  border: 0; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
  flex-shrink: 0;
}
.g-sheet-body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  display: flex; flex-direction: column; gap: 7px;
}
</style>


<style scoped>
.sheet-pop-enter-active { transition: opacity 200ms var(--ease-out); }
.sheet-pop-leave-active { transition: opacity 160ms var(--ease-in); }
.sheet-pop-enter-from, .sheet-pop-leave-to { opacity: 0; }
.sheet-pop-enter-active .g-sheet { transition: transform 260ms cubic-bezier(.22,.68,.19,1); }
.sheet-pop-leave-active .g-sheet { transition: transform 180ms var(--ease-in); }
.sheet-pop-enter-from .g-sheet, .sheet-pop-leave-to .g-sheet { transform: translateY(28px); }
@media (prefers-reduced-motion: reduce) {
  .sheet-pop-enter-active, .sheet-pop-leave-active,
  .sheet-pop-enter-active .g-sheet, .sheet-pop-leave-active .g-sheet { transition: none; }
}
</style>
