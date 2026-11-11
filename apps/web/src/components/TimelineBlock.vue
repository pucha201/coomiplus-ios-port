<script setup lang="ts">
/**
 * 时间线块组装层：把 store 的扁平时间线条目分发成「过程块 / 工具组 / 单条气泡」。
 *
 * 「哪一条正在生成」的判定全部走证据链，不单靠 isBusy（真机上它偶尔不置位）：
 *   · session.activeAssistantId —— store 正在收字的那个指针，最权威；
 *   · session.streamActive —— runState 非 idle，或末位助手消息还没收尾；
 *   · 时间线里最后一个「过程条目」落在本块里（不是「最后一项」：turn 中途插进来的
 *     notice / question / jump_in 用户消息不该让正在跑的那一轮被误判成结束）。
 */
import { computed } from 'vue'
import type { TimelineBlockItem } from '@/utils/chatTimeline'
import type { Timelineitem, ToolCard } from '@/stores/viewModel'
import { useSessionStore } from '@/stores/session'
import MessageBubble from '@/components/MessageBubble.vue'
import ToolGroup from '@/components/ToolGroup.vue'
import ProcessBlock from '@/components/ProcessBlock.vue'
import ReasoningBlock from '@/components/ReasoningBlock.vue'
import NoticeItem from '@/components/NoticeItem.vue'
import AgentState from '@/components/ai/AgentState.vue'

const props = defineProps<{ block: TimelineBlockItem; noEnter?: boolean; readonly?: boolean }>()
const session = useSessionStore()

/**
 * 时间线里最后一个「过程条目」（思考 / 工具 / 助手正文）。
 * 用它而不是最后一项：notice / question / jump_in 会在轮次中途插队，
 * 只看「最后一项」会把还在跑的那一轮判成已结束 → 过程栏提前收起。
 */
function lastProcessItem(): Timelineitem | null {
  const items = session.timeline
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i]
    if (it.kind === 'reasoning' || it.kind === 'tool' || it.kind === 'assistant') return it
  }
  return null
}

/**
 * 这一块是不是「正在跑的那一轮」：跑动中强制展开（免得用户以为卡住），
 * 本轮结束（turn_end / 末位助手消息 streaming 变 false）才收起并播折叠过渡。
 * 历史轮一律不 live。
 */
const turnLive = computed(() => {
  if (props.block.t !== 'turn') return false
  // ① 这条块里的答案正是引擎还在收字的那条 → 一定在跑
  if (props.block.answer && props.block.answer.id === session.activeAssistantId) return true
  const last = lastProcessItem()
  if (!last) return false
  const mine = (props.block.answer && props.block.answer === last)
    || props.block.stages.some(stage =>
      stage.s === 'tools' ? stage.cards.includes(last as ToolCard) : stage.item === last)
  return mine && session.streamActive
})

/**
 * 推理尾巴：这条推理块正是时间线里最后一个过程条目、且这一轮还在跑 ——
 * 只有这时它才是「正在长的那条」。初始推理阶段还没有助手消息，正文那条挂点接不上，
 * 所以推理的「生成中」指示落在这里，和推理块并排。
 */
const reasoningTail = computed(() => {
  if (props.block.t !== 'one') return false
  const item = props.block.item
  if (!item || item.kind !== 'reasoning') return false
  return lastProcessItem() === item && session.streamActive
})
</script>

<template>
  <!-- noEnter：这行不需要播放入场动画（虚拟列表里恒定传入）。
       虚拟列表滚出/滚回视口会销毁重建行组件，任何入场动画都会在重建时重播，
       看起来就是「闪一下」；所以在组件边界传下去，让各子组件不挂动画类。 -->
  <ProcessBlock v-if="block.t === 'turn'" :block="block" :live="turnLive" :no-enter="noEnter" />
  <ToolGroup v-else-if="block.t === 'tools'" :cards="block.cards" :no-enter="noEnter" />
  <template v-else>
    <MessageBubble
      v-if="block.item.kind === 'user' || block.item.kind === 'assistant'"
      :msg="block.item"
      :no-enter="noEnter"
      :readonly="readonly"
    />
    <ReasoningBlock v-else-if="block.item.kind === 'reasoning'" :block="block.item" />
    <NoticeItem v-else-if="block.item.kind === 'notice'" :notice="block.item" />
    <div
      v-else-if="block.item.kind === 'question' && block.item.answered"
      class="q-answered"
      :class="{ cascade: !noEnter }"
    >
      <span class="q-label">已回答</span>
      {{ Object.values(block.item.answers ?? {}).filter(Boolean).join('；') || '已跳过' }}
    </div>
  </template>
  <!-- 正在产出的推理：点阵与推理块并排（reasoning = 环匀速转 + 相位尾迹） -->
  <AgentState v-if="reasoningTail" state="reasoning" size="xs" tone="primary" class="tail-state" />
</template>

<style scoped>
.q-answered {
  align-self: flex-end;
  max-width: 84%;
  padding: 7px 13px;
  border-radius: var(--r-pill);
  background: var(--fill);
  color: var(--text-2);
  font-size: var(--fs-label);
  /* 入场动画已按反馈移除（重建 DOM 时重播 = 闪）。 */
}
.q-label { color: var(--blue); font-weight: 600; }
/* 与推理块首行文字对齐（图标 14 + 间距 7 + 左侧 padding 2），不缩进会顶着最左边 */
.tail-state { display: block; margin: 2px 0 0 23px; }
</style>
