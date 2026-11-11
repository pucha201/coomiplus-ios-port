<script setup lang="ts">
/**
 * 思考过程块（timeline 里 kind === 'reasoning' 的独立条目）。
 *
 * 为什么它是「独立块」而不是正文的一部分：
 * - 数据层（stores/session.ts appendReasoning）已经把 reasoning_chunk 写成
 *   timeline 上的独立 { kind:'reasoning' } 条目，这里只负责把它画成一个
 *   与正文明确区分的可折叠思考块，绝不拼进 MessageBubble 的正文。
 * - 流式期间未展开只显示一行摘要（最后一句 + 流光跑马灯），停下来折成
 *   「已思考 · N 字」；点标题展开/收起，全文按 pre-wrap 正常排。
 *
 * 折叠状态写在 timeline 条目的 expanded 字段上（读写都在条目上）：
 * vue-virtual-scroller 会把滚出视口的条目销毁、滚回来再重建，若状态存在
 * 组件本地 ref，滚走再滚回来展开状态会莫名丢失；写回条目本身，展开状态
 * 与数据同生共死，且与 viewModel.ReasoningBlock.expanded 的契约一致。
 *
 * 流式判定：协议没有 reasoning 的 streaming 标记，所以用「最近 900ms 内
 * 还在长」推断活跃（保持既有实现）。
 */
import { computed, ref, watch, onBeforeUnmount } from 'vue'
import type { ReasoningBlock } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ block: ReasoningBlock }>()

/** 展开状态写在条目上，滚出视口重建后不丢；详情用独立 sheet，不撑高时间线。 */
const open = computed({
  get: () => props.block.expanded, set: (v: boolean) => { props.block.expanded = v },
})

const live = ref(false)
let timer: ReturnType<typeof setTimeout> | null = null

watch(() => props.block.content, () => {
  live.value = true
  if (timer) clearTimeout(timer)
  timer = setTimeout(() => { live.value = false }, 900)
})
onBeforeUnmount(() => { if (timer) clearTimeout(timer) })

/** 打开瞬间冻结思考文本：生成中内容还在增长，但弹层只显示打开时的快照。 */
const sheetSnapshot = ref(0)
watch(() => open.value, (value) => { if (value) sheetSnapshot.value += 1 })

function onToggle() {
  open.value = !open.value
}

const chars = computed(() => props.block.content.replace(/\s+/g, '').length)
/** 摘要行：流式时取最后一行（过长截尾），这就是「已思考」的一行摘要。 */
const tick = computed(() => {
  const lines = props.block.content.split('\n').map(s => s.trim()).filter(Boolean)
  const t = lines[lines.length - 1] ?? ''
  return t.length > 46 ? '…' + t.slice(-46) : t
})
</script>

<template>
  <div class="reasoning">
    <button
      type="button"
      class="toggle"
      :aria-expanded="open"
      @click="onToggle"
    >
      <CoomiIcon name="sparkle" :size="14" class="spark" :class="{ live }" />
      <span v-if="live" class="ticker shimmer-text">{{ tick || '正在思考…' }}</span>
      <template v-else>
        <span class="label">已思考</span>
        <span class="count">{{ chars }} 字</span>
      </template>
      <CoomiIcon name="chevronRight" :size="13" class="chev" :class="{ open }" />
    </button>
    <Teleport to="body">
      <Transition name="sheet-pop">
      <div v-if="open" class="r-mask" @click.self="onToggle">
        <section class="r-sheet" role="dialog" aria-modal="true" aria-label="思考过程">
          <div class="r-grip" />
          <header class="r-head">
            <CoomiIcon name="sparkle" :size="16" class="r-spark" />
            <span>思考过程</span>
            <span class="r-count">{{ chars }} 字</span>
            <button class="r-close" aria-label="关闭" @click="onToggle"><CoomiIcon name="close" :size="16" /></button>
          </header>
          <div class="r-body" v-memo="[sheetSnapshot]">{{ block.content }}</div>
        </section>
      </div>
      </Transition>
    </Teleport>
  </div>
</template>

<style scoped>
/* 常规文档流，间距由外层 .virtual-item 的 padding-bottom: var(--sp-3) 承担；
   不用负 margin / 绝对定位叠压，天然不与相邻正文块重叠。 */
.reasoning { padding: 0; }
.toggle {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 32px; padding: var(--sp-1) 2px;
  border: 0; background: none; text-align: left;
  font-size: var(--fs-sub); color: var(--text-3); /* 弱化墨色：思考在层级上压过正文 */
}
.spark { flex-shrink: 0; color: var(--text-3); }
.spark.live { color: var(--blue); animation: coomi-blink var(--dur-loop) var(--ease-in-out) infinite; }
.ticker {
  flex: 1; min-width: 0; font-size: var(--fs-label); font-style: italic; /* 斜体 = 思考语气的视觉签名 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.label { font-weight: 600; }
.count { flex: 1; font-size: var(--fs-caption); color: var(--text-3); }
.chev { flex-shrink: 0; transition: transform var(--dur-base) var(--ease-out); }
.chev.open { transform: rotate(90deg); }

/* 思考详情 sheet：只做透明度/位移，绝不改变时间线高度。 */
.r-mask {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .42);
}
.r-sheet {
  width: 100%; max-width: 620px; max-height: 84vh;
  display: flex; flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); box-shadow: var(--shadow-sheet);
  will-change: transform;
}
.r-grip {
  width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-2);
  border-radius: var(--r-pill); background: var(--fill-strong); flex-shrink: 0;
}
.r-head {
  display: flex; align-items: center; gap: 7px;
  padding-bottom: var(--sp-2); flex-shrink: 0;
  color: var(--text); font-size: var(--fs-sub); font-weight: 600;
}
.r-spark { color: var(--blue); }
.r-count { flex: 1; color: var(--text-3); font-size: var(--fs-caption); font-weight: 400; }
.r-close {
  display: grid; place-items: center; width: var(--sp-8); height: var(--sp-8);
  border: 0; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
}
.r-body {
  flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain;
  padding: 10px 13px; border-radius: var(--r-md);
  background: var(--fill);
  font-size: var(--fs-sub); line-height: 1.7; color: var(--text-2);
  font-style: italic;
  white-space: pre-wrap; word-break: break-word;
}
</style>

<style scoped>
.sheet-pop-enter-active { transition: opacity 200ms var(--ease-out); }
.sheet-pop-leave-active { transition: opacity 160ms var(--ease-in); }
.sheet-pop-enter-from, .sheet-pop-leave-to { opacity: 0; }
.sheet-pop-enter-active .r-sheet { transition: transform 260ms cubic-bezier(.22,.68,.19,1); }
.sheet-pop-leave-active .r-sheet { transition: transform 180ms var(--ease-in); }
.sheet-pop-enter-from .r-sheet, .sheet-pop-leave-to .r-sheet { transform: translateY(28px); }
@media (prefers-reduced-motion: reduce) {
  .sheet-pop-enter-active, .sheet-pop-leave-active,
  .sheet-pop-enter-active .r-sheet, .sheet-pop-leave-active .r-sheet { transition: none; }
}
</style>
