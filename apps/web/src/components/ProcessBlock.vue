<script setup lang="ts">
/**
 * 轮过程块（对标桌面端 ProcessBlock.tsx）。
 *
 * 布局与桌面一致：折叠头在最上，过程成员（思考 / 工具组 / 叙述正文）按事件先后
 * 折在它下面，答案画在这一整块之后、永不参与折叠（splitProcessAnswer 语义）。
 * 思考与工具之间还有「继续思考」：各段独立成 stage 顺序渲染，不重排。
 *
 * 各段独立折叠：思考段复用 ReasoningBlock（展开态写在条目上、流式摘要行都在），
 * 工具段复用 ToolGroup（连续工具自动成组、跑时展开停时收起）。
 *
 * 本块自身的开合：跑的时候强制展开（免得用户以为卡住），停下来收起；
 * 用户点过之后就听用户的。展开状态记在模块级 processState 里 ——
 * vue-virtual-scroller 滚出视口会销毁行组件，本地 ref 滚回来会丢。
 *
 * 「停下来」＝本轮结束（turn_end / 末位助手消息 streaming 变 false，见 TimelineBlock 的
 * turnLive 证据链）：live 与 open 同一帧翻面，折叠栏直接收起。
 *
 * 开合走 180ms 的 0fr → 1fr 网格高度过渡；滚动位置交给
 * keepAnchor（撤掉自动贴底）+ 虚拟列表自身的尺寸补偿，见 utils/anchorScroll.ts。
 */
import { computed, ref, watch } from 'vue'
import type { TimelineBlockItem } from '@/utils/chatTimeline'
import { processOpenState } from '@/utils/processState'
import { keepAnchor } from '@/utils/anchorScroll'
import { useSessionStore } from '@/stores/session'
import ReasoningBlock from '@/components/ReasoningBlock.vue'
import ToolGroup from '@/components/ToolGroup.vue'
import MessageBubble from '@/components/MessageBubble.vue'
import NarrationLine from '@/components/NarrationLine.vue'
import AgentState from '@/components/ai/AgentState.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

type TurnBlock = Extract<TimelineBlockItem, { t: 'turn' }>
const props = defineProps<{ block: TurnBlock; live: boolean; noEnter?: boolean }>()
const session = useSessionStore()

/** 块 key 只保证会话内稳定；带上会话 id，避免旧会话的折叠态串进新会话。 */
const stateKey = computed(() => `${session.sessionId}:${props.block.key}`)

const stages = computed(() => props.block.stages)
const answer = computed(() => props.block.answer)

const reasoningCount = computed(() => stages.value.filter(stage => stage.s === 'reasoning').length)
const allCards = computed(() => stages.value.flatMap(stage => (stage.s === 'tools' ? stage.cards : [])))
const inFlight = computed(() =>
  allCards.value.filter(card => card.status === 'running' || card.status === 'starting' || card.status === 'awaiting_approval').length)
const doneCount = computed(() =>
  allCards.value.filter(card => card.status === 'success' || card.status === 'cache_hit').length)
const failCount = computed(() =>
  allCards.value.filter(card => card.status === 'error' || card.status === 'cancelled').length)

const open = computed(() => props.live ? !userClosed.value : processOpenState.get(stateKey.value) === true)

/** 生成中用户点了折叠：以用户为准，不再被 live 强制展开。 */
const userClosed = ref(false)
watch(stateKey, () => { userClosed.value = false })

/** 展开过一次后成员保持挂载，折叠态仍可被页内搜索命中。 */
const hasOpened = ref(false)
watch(open, value => { if (value) hasOpened.value = true }, { immediate: true })

/**
 * 折叠/展开：CSS 用 grid-template-rows 0fr → 1fr 做 180ms 过渡。
 * 开合前 keepAnchor 撤掉自动贴底，位置交给虚拟列表自己的条目补偿，
 * 不再有「贴底 rAF + 补偿 + 动画」三套滚动权威互相拉扯。
 */
function toggle() {
  keepAnchor(() => {
    if (props.live) userClosed.value = open.value
    else processOpenState.set(stateKey.value, !open.value)
  })
}

const summary = computed(() => {
  const parts: string[] = []
  parts.push(reasoningCount.value > 0 ? `已思考 ${reasoningCount.value} 段` : '已思考')
  if (allCards.value.length > 0) parts.push(`使用工具 ${allCards.value.length} 次`)
  if (props.live && inFlight.value > 0) parts.push(`进行中 ${inFlight.value}`)
  if (!props.live && doneCount.value > 0) parts.push(`成功 ${doneCount.value}`)
  if (!props.live && failCount.value > 0) parts.push(`失败 ${failCount.value}`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="pblock">
    <button type="button" class="phead" :aria-expanded="open" @click="toggle">
      <span class="picon">
        <AgentState v-if="live" state="reasoning" size="xs" tone="primary" />
        <CoomiIcon v-else name="sparkle" :size="14" />
      </span>
      <span class="psum">{{ summary }}</span>
      <CoomiIcon name="chevronRight" :size="13" class="chev" :class="{ open }" />
    </button>
    <div class="pwrap" :class="{ open }">
      <div class="pinner">
        <div v-if="hasOpened" class="pbody">
          <template v-for="(stage, index) in stages" :key="index">
        <ReasoningBlock v-if="stage.s === 'reasoning'" :block="stage.item" />
        <ToolGroup v-else-if="stage.s === 'tools'" :cards="stage.cards" />
        <NarrationLine v-else-if="stage.s === 'text' && stage.item.content" :item="stage.item" />
          </template>
        </div>
      </div>
    </div>
    <!-- 答案独立在过程块之后、永不参与折叠；它自己按 streaming 决定逐字还是 markdown。 -->
    <MessageBubble v-if="answer && answer.content" :msg="answer" />
  </div>
</template>

<style scoped>
.pblock { display: flex; flex-direction: column; gap: var(--sp-2); }
.phead {
  display: flex; align-items: center; gap: 7px;
  width: 100%; min-height: 32px; padding: var(--sp-1) 2px;
  border: 0; background: none; text-align: left;
  font-size: var(--fs-sub); color: var(--text-3);
}
.phead:active { background: var(--fill); border-radius: var(--r-md); }
.picon { display: inline-flex; align-items: center; min-width: 16px; }
.psum { flex: 1; min-width: 0; font-weight: 600; }
.chev { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.chev.open { transform: rotate(90deg); }
/* 间距唯一来源：段与段之间只有这里的 gap，成员组件自己不带外边距。 */
/* 开合用 0fr → 1fr 的网格高度过渡（180ms）。滚动权威已经收敛，
   开合前 keepAnchor 会撤掉自动贴底，不会和虚拟列表补偿互相拉扯。 */
.pwrap {
  display: grid; grid-template-rows: 0fr;
  overflow: hidden; opacity: 0;
  transition: grid-template-rows 180ms var(--ease-out), opacity 140ms var(--ease-out);
}
.pwrap.open { grid-template-rows: 1fr; opacity: 1; }
.pinner { overflow: hidden; min-height: 0; }
/* 过程体不再限高：长内容由页面滚动，输出区自己再按 40vh 限高。 */
.pbody {
  display: flex; flex-direction: column; gap: var(--sp-2);
  margin-left: 6px; padding-left: 10px;
  border-left: 2px solid var(--border);
}
@media (prefers-reduced-motion: reduce) { .pwrap { transition: none; } }
</style>
