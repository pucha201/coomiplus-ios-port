<script lang="ts">
import { ref } from 'vue'

/**
 * AI 原生状态语言（手机端）——纯 CSS 点阵指示器。
 *
 * 与桌面 apps/desktop-ui-react/src/components/ai/AgentState.tsx **同名同义**的 11 个语义态，
 * 但实现完全自研、零依赖：桌面那套靠 thinking-orbs（canvas）或 base.css 的全局点阵，
 * 手机端外壳（App.vue / styles/）正在被并行修改，所以这里把 DOM、关键帧、降级规则
 * **全部收在本文件的 <style scoped> 里**，不往 styles/ 塞任何东西，避免和外壳冲突。
 *
 * 三条约束（低端机友好）：
 *   1. 点数固定 8（≤9），每个点只做 transform + opacity，没有一条动画碰布局属性；
 *   2. 一个状态 = 一条 [data-state] 规则 + 一段 @keyframes，加状态不用改模板；
 *   3. 减动效 / 后台不可见都只停动画，不停功能：静态帧仍然按状态各停一处，
 *      「有状态」这个信息不丢（详见文件末尾的降级段）。
 *
 * 状态推导（谁该显示哪个态）在这里导出成纯函数：调用方只负责把信号填进来，
 * 不在各自的组件里各写一份 switch —— 否则 5 个挂载点早就会漂移出 5 个版本。
 */

/** 11 个语义状态：出现时机与形态，逐条对应桌面 AgentState.tsx 上方的表。 */
export type AgentStateKind =
  | 'thinking'      // 已发请求、还没出 token：点阵整团向心呼吸（0.9s）
  | 'reasoning'     // 收到推理增量：环匀速转 + 相位尾迹
  | 'searching'     // 检索 / 抓取工具在跑：快速环绕 + 半径向外荡开
  | 'reading'       // 读文件 / 读上下文：亮点顺着点阵扫过一遍
  | 'writing'       // 写 / 改文件：点被逐个「写」出来
  | 'running'       // 通用工具执行：环快转 + 点阵收紧再放开
  | 'awaiting'      // 等你授权 / 回答：静止 + 慢心跳（刻意区别于「在跑」）
  | 'compacting'    // 压缩上下文：向心收拢再弹开
  | 'subagents'     // 子代理在跑：内外两层反向绕行
  | 'reconnecting'  // 断线 / 引擎重启：断续闪烁，带停顿（读作「在重试」而不是「卡住」）
  | 'idle'          // 空闲：静置暗点阵

export type AgentStateSize = 'xs' | 'sm' | 'md'
export type AgentStateTone = 'inherit' | 'primary' | 'ok' | 'warn' | 'danger' | 'muted'

/** 状态中文名：aria-label 与并排文案都取这里，避免各处各写一份。 */
export const AGENT_STATE_LABELS: Record<AgentStateKind, string> = {
  thinking: '思考中', reasoning: '推理中', searching: '检索中', reading: '读取中', writing: '写入中', running: '执行中', awaiting: '等待你的确认', compacting: '正在压缩上下文', subagents: '子智能体运行中', reconnecting: '正在重新连接引擎', idle: '空闲',
}

/** 推导输入：调用方从各自的 store / props 里把这几项挑出来，不传就是「无此信号」。 */
export interface AgentSignals {
  /** 会话 runState：idle / syncing / thinking / executing / awaiting_approval / awaiting_question。用 string 收口，避免这里反向依赖 store 类型。 */
  runState?: string | null
  /** 连接层是否在重连（优先于一切会话态：连不上时「在跑」是假的）。 */
  reconnecting?: boolean
  /** 明确「正在等用户」——授权弹层 / 提问卡。 */
  awaiting?: boolean
  /** 助手消息是否在流式产出（消息末尾挂点用）。 */
  streaming?: boolean
  /** 推理块是否是「当前正在长的那条」。 */
  reasoning?: boolean
  /** 工具类别（由 toolActivityOf 得到）。 */
  tool?: AgentStateKind | null
  /** 协作 / 子代理是否在跑。 */
  subagents?: boolean
  /** 上下文压缩中（协议侧暂无事件，留给将来）。 */
  compacting?: boolean
}

/**
 * 纯函数：把信号收敛成一个状态。
 *
 * 优先级不是随手排的：
 *   断线 > 等你 > 压缩 > 工具 > 子代理 > 推理 > 执行 > 思考 > 同步 > 空闲。
 * 「等你」要压过工具：工具卡正卡在授权上，界面必须说「等你」而不是「在跑」；
 * 「执行」排在「思考」之前，是因为工具跑完 runState 会先回 thinking，别被误读成 running。
 */
export function resolveAgentState(s: AgentSignals): AgentStateKind {
  if (s.reconnecting) return 'reconnecting'
  if (s.awaiting || s.runState === 'awaiting_approval' || s.runState === 'awaiting_question') return 'awaiting'
  if (s.compacting) return 'compacting'
  if (s.tool) return s.tool
  if (s.subagents) return 'subagents'
  if (s.reasoning) return 'reasoning'
  if (s.runState === 'executing') return 'running'
  if (s.runState === 'thinking' || s.streaming) return 'thinking'
  if (s.runState === 'syncing') return 'reading' // 同步会话 = 读上下文，用「读」的语义最贴
  return 'idle'
}

/** 精确命中表：工具名大多是固定串，先查表再退回关键字，避免正则误伤。 */
const SEARCH_TOOLS = new Set([
  'grep', 'glob', 'search', 'find', 'webfetch', 'websearch', 'web_search', 'fetch', 'request_web_search',
])
const READ_TOOLS = new Set([
  'read', 'cat', 'view', 'ls', 'list', 'list_dir', 'open', 'notebookread', 'request_file_import',
])
const WRITE_TOOLS = new Set([
  'write', 'edit', 'multiedit', 'notebookedit', 'patch', 'apply_patch', 'create', 'mkdir', 'save', 'request_file_export',
])
const SUBAGENT_TOOLS = new Set(['task', 'subagent', 'delegate', 'agent'])

/**
 * 纯函数：工具名 → 工具卡头部该显示的状态（searching / reading / writing / running）。
 * task（子代理）给 subagents：它确实是「派出去的分支」，比笼统的 running 更准确。
 */
export function toolActivityOf(toolName: string): AgentStateKind {
  const n = (toolName || '').trim().toLowerCase()
  if (!n) return 'running'
  if (SUBAGENT_TOOLS.has(n) || n.includes('subagent') || /(?:^|__)task$/.test(n)) return 'subagents'
  if (WRITE_TOOLS.has(n) || /(?:^|_)(write|edit|patch|create|mkdir|save|export)(?:$|_)/.test(n)) return 'writing'
  if (READ_TOOLS.has(n) || /(?:^|_)(read|cat|view|ls|list|open)(?:$|_)/.test(n)) return 'reading'
  if (SEARCH_TOOLS.has(n) || /search|grep|glob|fetch|web|find|query|retriev/.test(n)) return 'searching'
  return 'running'
}

/** 纯函数：时间线最后一项是不是推理块（＝推理正在长）。传给 resolveAgentState 的 reasoning 用。 */
export function isReasoningTail(items: readonly unknown[] | null | undefined): boolean {
  if (!items || items.length === 0) return false
  const last = items[items.length - 1] as { kind?: string } | null | undefined
  return !!last && last.kind === 'reasoning'
}

/**
 * 纯函数：消息气泡末尾「生成中」该显示什么。
 * 推理尾巴刻意返回 null —— 那一段由 TimelineBlock 在推理块旁边渲染，
 * 两个挂点各显示同一件事会变成两个点阵在闪，反而更吵。
 */
export function messageTailState(s: { streaming?: boolean; reasoning?: boolean }): AgentStateKind | null {
  if (!s.streaming) return null
  if (s.reasoning) return null
  return 'thinking'
}

/* ── 降级探测：单例故意挂在**普通 <script>**里 ──
   <script setup> 的顶层声明属于每个实例的 setup() 作用域，写在那边的话，
   几十张工具卡同时渲染点阵就会挂出几十个 MutationObserver。
   两个来源合并成根元素上的一个 data-motion 属性：
     · 系统 prefers-reduced-motion（用户在系统设置里改）
     · 应用内 html[data-motion='off']（桌面端已有这套约定；手机端目前只有前者，
       这里把同名属性一起接上，将来外壳加开关时本组件自动跟随，不必回来改） */
const motionState = { reduced: ref(false), hidden: ref(false) }
let subscribers = 0
let observer: MutationObserver | null = null
let media: MediaQueryList | null = null

function readDoc(): void {
  if (typeof document === 'undefined') return
  const systemReduced = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches
  motionState.reduced.value = document.documentElement.dataset.motion === 'off' || systemReduced
  motionState.hidden.value = document.visibilityState === 'hidden'
}

/** 引用计数式订阅：第一个实例挂监听，最后一个卸载时摘掉。 */
function subscribeDoc(): () => void {
  if (typeof document === 'undefined') return () => {}
  subscribers += 1
  if (subscribers === 1) {
    readDoc()
    observer = new MutationObserver(readDoc)
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-motion'] })
    if (typeof matchMedia === 'function') {
      media = matchMedia('(prefers-reduced-motion: reduce)')
      media.addEventListener('change', readDoc)
    }
    document.addEventListener('visibilitychange', readDoc)
  }
  return () => {
    subscribers -= 1
    if (subscribers > 0) return
    observer?.disconnect()
    observer = null
    media?.removeEventListener('change', readDoc)
    media = null
    document.removeEventListener('visibilitychange', readDoc)
  }
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount } from 'vue'

const props = withDefaults(defineProps<{
  state?: AgentStateKind
  size?: AgentStateSize
  /** 语气色：inherit 吃父级 currentColor，其余映射到设计令牌。 */
  tone?: AgentStateTone
  /** 覆盖默认中文状态名（同一状态在不同语境下说法可能不同）。 */
  label?: string
}>(), {
  state: 'idle', size: 'sm', tone: 'inherit', label: '',
})

/** 点数固定 8：环上 45° 一个，够画出内外两层，又在低端机的预算内（≤9）。 */
const DOTS = 8

/** 给每个点一个序号，CSS 里用它算角度（--a）和错峰相位（animation-delay）。 */
function dotStyle(index: number): Record<string, string> {
  return { '--i': String(index) }
}

const unsubscribe = subscribeDoc()
onBeforeUnmount(unsubscribe)

/* 模板只绑组件内的 computed：模块级 Ref 在这里解包一次，
   不依赖编译器对「普通 <script> 里声明的 ref」的自动解包行为。 */
const motionOff = computed(() => motionState.reduced.value)
const paused = computed(() => motionState.hidden.value)

const ariaLabel = computed(() => props.label || AGENT_STATE_LABELS[props.state])
</script>

<template>
  <!-- role=img 而不是 status：点阵本身是装饰，状态文字通常就在旁边；
       挂成 live region 会让读屏在流式期间不停打断用户。 -->
  <span
    class="as"
    :class="'tone-' + tone"
    role="img"
    :aria-label="ariaLabel"
    :data-state="state"
    :data-size="size"
    :data-motion="motionOff ? 'off' : undefined"
    :data-paused="paused ? 'true' : undefined"
  >
    <span class="as-ring" aria-hidden="true">
      <!-- v-for 从 1 起，dotStyle(i-1) 让 --i 从 0 开始：0 号点在正上方偏 0° -->
      <i v-for="i in DOTS" :key="i" class="as-dot" :style="dotStyle(i - 1)" />
    </span>
  </span>
</template>

<style scoped>
/* ── 容器与点 ──
   尺寸全部从 --as-size 推出来：改一档尺寸只改一个变量，点径/半径/间距跟着走。
   点的定位只用 transform（先转到自己的角度，再沿 Y 轴外推半径），不产生任何布局。 */
.as {
  --as-size: 20px;
  --as-r: calc(var(--as-size) * 0.32);          /* 点阵半径 */
  --as-dot: calc(var(--as-size) * 0.16);        /* 点直径 */
  --as-speed: 1600ms;                           /* 单点动画周期（各状态自己覆盖） */
  --as-stagger: 0ms;                            /* 点与点的相位差 */
  position: relative;
  display: inline-block;
  flex: none;
  width: var(--as-size);
  height: var(--as-size);
  vertical-align: -0.16em;
  color: inherit;
}
.as[data-size='xs'] { --as-size: 14px; }
.as[data-size='sm'] { --as-size: 20px; }
.as[data-size='md'] { --as-size: 28px; }

/* 环单独一层：需要整团自转的状态（reasoning / searching / running）只转它，
   点自己在环内做形态变化，两层互不覆盖 transform。 */
.as-ring { position: absolute; inset: 0; transform-origin: 50% 50%; }

.as-dot {
  --a: calc(var(--i, 0) * 45deg);
  position: absolute;
  left: 50%;
  top: 50%;
  width: var(--as-dot);
  height: var(--as-dot);
  margin-left: calc(var(--as-dot) / -2);
  margin-top: calc(var(--as-dot) / -2);
  border-radius: 50%;
  background: currentColor;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1));
  animation-duration: var(--as-speed);
  animation-timing-function: var(--ease-in-out);
  animation-iteration-count: infinite;
  /* 负延迟：错峰从第一帧就成立，不会先僵住半拍再开始动 */
  animation-delay: calc(var(--i, 0) * var(--as-stagger) * -1);
}

/* ── 语气色 ──
   inherit 不改 color：吃父级当前色，落在任何文字上都跟主题走。 */
.as.tone-primary { color: var(--blue); }
.as.tone-ok { color: var(--ok); }
.as.tone-warn { color: var(--orange); }
.as.tone-danger { color: var(--danger); }
.as.tone-muted { color: var(--text-3); }

/* ── idle：静置的暗点阵。不转、不闪，只是「在那儿」——空闲态不该抢注意力。 ── */
.as[data-state='idle'] { --as-r: calc(var(--as-size) * 0.24); }
.as[data-state='idle'] .as-dot { animation: none; opacity: 0.35; }

/* ── thinking：整团向心呼吸 0.9s（不转，半径与明暗一起收放） ── */
.as[data-state='thinking'] { --as-speed: 900ms; --as-stagger: 0ms; }
.as[data-state='thinking'] .as-dot { animation-name: as-breathe; }
@keyframes as-breathe {
  0%, 100% { opacity: 0.32; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.68)) scale(0.72); }
  50% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.08)) scale(1); }
}

/* ── reasoning：三点错峰呼吸（不再整圈自转）──
   正文下方那个转圈读起来是「四瓣在转」，与同屏的 thinking 三点重复表达「在忙」；
   改成三点即可，与 thinking 同族但慢一档，状态语义靠文案区分而不是靠形状。 */
.as[data-state='reasoning'] { --as-speed: 1500ms; --as-stagger: 180ms; }
.as[data-state='reasoning'] .as-ring { animation: none; }
.as[data-state='reasoning'] .as-dot { animation-name: as-breathe; }
@keyframes as-spin { to { transform: rotate(360deg); } }
/* ── searching：环快速自转，点从中心向外荡开（声呐一圈圈推出去） ── */
.as[data-state='searching'] { --as-speed: 700ms; --as-stagger: 0ms; --as-ring: 900ms; }
.as[data-state='searching'] .as-ring { animation: as-spin var(--as-ring) linear infinite; }
.as[data-state='searching'] .as-dot { animation-name: as-ping; animation-timing-function: var(--ease-out); }
@keyframes as-ping {
  0%, 100% { opacity: 0.9; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.3)) scale(0.45); }
  70% { opacity: 0.25; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.35)) scale(1); }
}

/* ── reading：环静置，亮点顺着点阵一个挨一个扫过去（逐条读下去） ── */
.as[data-state='reading'] { --as-speed: 1200ms; --as-stagger: 120ms; }
.as[data-state='reading'] .as-dot { animation-name: as-scan; animation-timing-function: var(--ease-out); }
@keyframes as-scan {
  0%, 26%, 100% { opacity: 0.16; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.9)) scale(0.7); }
  8% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1.12); }
}

/* ── writing：点被一个个「写」出来并留在环上，一圈写完再整体重置 ── */
.as[data-state='writing'] { --as-speed: 1500ms; --as-stagger: 150ms; }
.as[data-state='writing'] .as-dot { animation-name: as-write; animation-timing-function: var(--ease-out); }
@keyframes as-write {
  0% { opacity: 0; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.7)) scale(0.2); }
  10%, 72% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1); }
  88%, 100% { opacity: 0; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.7)) scale(0.2); }
}

/* ── running：环高速自转 + 点阵收紧再放开（快节奏、实心的「在跑」） ── */
.as[data-state='running'] { --as-speed: 900ms; --as-stagger: 0ms; --as-ring: 1080ms; }
.as[data-state='running'] .as-ring { animation: as-spin var(--as-ring) linear infinite; }
.as[data-state='running'] .as-dot { animation-name: as-run; }
@keyframes as-run {
  0%, 100% { opacity: 0.6; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.82)) scale(0.84); }
  50% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.05)) scale(1); }
}

/* ── awaiting：完全静止 + 慢心跳（两下轻、随后长停顿），读作「在等你」而不是「在跑」
   周期直接用全局的 --dur-loop-slow：它本来就是为「等待心跳」留的那一档，
   和「运行中」的 --dur-loop 刻意差一档，扫一眼节奏就能分辨系统在跑还是在等你。 ── */
.as[data-state='awaiting'] { --as-speed: var(--dur-loop-slow); --as-stagger: 0ms; }
.as[data-state='awaiting'] .as-dot { animation-name: as-heartbeat; }
@keyframes as-heartbeat {
  0%, 46%, 100% { opacity: 0.28; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(0.86); }
  8% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.1)) scale(1.06); }
  18% { opacity: 0.34; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(0.9); }
  28% { opacity: 0.95; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.06)) scale(1); }
}

/* ── compacting：点阵向心收拢、触底再弹回（上下文被压进去又展开） ── */
.as[data-state='compacting'] { --as-speed: 1200ms; --as-stagger: 0ms; }
.as[data-state='compacting'] .as-dot { animation-name: as-converge; }
@keyframes as-converge {
  0%, 100% { opacity: 0.9; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1); }
  45% { opacity: 1; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.12)) scale(0.5); }
}

/* ── subagents：内外两层反向绕行——外圈顺时针慢、内圈逆时针快，像被派生出去的分支 ── */
.as[data-state='subagents'] { --as-speed: var(--dur-loop-slow); --as-stagger: 0ms; }
.as[data-state='subagents'] .as-dot:nth-child(even) { animation-name: as-orbit-out; }
.as[data-state='subagents'] .as-dot:nth-child(odd) {
  --as-r: calc(var(--as-size) * 0.15);
  --as-speed: 1100ms;
  animation-name: as-orbit-in;
}
@keyframes as-orbit-out {
  from { opacity: 0.95; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)); }
  to { opacity: 0.95; transform: rotate(calc(var(--a) + 360deg)) translateY(calc(var(--as-r) * -1)); }
}
@keyframes as-orbit-in {
  from { opacity: 0.8; transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(0.8); }
  to { opacity: 0.8; transform: rotate(calc(var(--a) - 360deg)) translateY(calc(var(--as-r) * -1)) scale(0.8); }
}

/* ── reconnecting：断续闪烁（0.6s 亮 / 0.4s 暗，随后长停顿）。
     关键在**停顿**：连续闪读作「在忙」，亮一下停一拍才读作「没连上，正在重试」。
     steps(1, end) 让每次切换是硬切而不是淡入淡出，闪烁才干脆。 ── */
.as[data-state='reconnecting'] { --as-speed: 1800ms; --as-stagger: 80ms; }
.as[data-state='reconnecting'] .as-dot { animation-name: as-beacon; animation-timing-function: steps(1, end); }
@keyframes as-beacon {
  0% { opacity: 0; }
  4%, 37% { opacity: 1; }    /* ≈0.6s 亮 */
  41%, 100% { opacity: 0; }  /* ≈0.4s 暗 + 长停顿 */
}

/* ── 后台 / 不可见时停住（便宜的一档：只暂停动画，不卸节点、不改布局）── */
.as[data-paused='true'] .as-ring,
.as[data-paused='true'] .as-dot { animation-play-state: paused; }

/* ── 降级：静态点阵（系统 prefers-reduced-motion 或 html[data-motion='off']，由 JS 合并后写在根元素上）──
   注意不是「收成一个点」：不同状态各自停在一个**不同的代表帧**上，
   所以不动也仍然能一眼分辨「在想 / 在读 / 写了一半 / 在等你」。
   把状态信息一起丢掉就只是省了动画，不叫降级。 */
.as[data-motion='off'] .as-ring,
.as[data-motion='off'] .as-dot { animation: none !important; }

.as[data-motion='off'][data-state='idle'] .as-dot { opacity: 0.3; }
.as[data-motion='off'][data-state='thinking'] .as-dot {
  opacity: 0.6;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.82)) scale(0.86);
}
.as[data-motion='off'][data-state='reasoning'] .as-dot { opacity: 0.26; }
.as[data-motion='off'][data-state='reasoning'] .as-dot:nth-child(4n + 2) {
  opacity: 1;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1.05);
}
.as[data-motion='off'][data-state='searching'] .as-dot {
  opacity: 0.5;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.28)) scale(1);
}
.as[data-motion='off'][data-state='reading'] .as-dot { opacity: 0.2; }
.as[data-motion='off'][data-state='reading'] .as-dot:nth-child(3) {
  opacity: 1;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1.12);
}
.as[data-motion='off'][data-state='writing'] .as-dot { opacity: 0.18; }
.as[data-motion='off'][data-state='writing'] .as-dot:nth-child(-n + 5) {
  opacity: 1;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1)) scale(1);
}
.as[data-motion='off'][data-state='running'] .as-dot {
  opacity: 0.95;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.06)) scale(1);
}
.as[data-motion='off'][data-state='awaiting'] .as-dot { opacity: 0.36; }
.as[data-motion='off'][data-state='awaiting'] .as-dot:nth-child(odd) {
  opacity: 0.9;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -1.1)) scale(1.06);
}
.as[data-motion='off'][data-state='compacting'] .as-dot {
  opacity: 1;
  transform: rotate(var(--a)) translateY(calc(var(--as-r) * -0.28)) scale(0.52);
}
.as[data-motion='off'][data-state='subagents'] .as-dot:nth-child(even) { opacity: 0.9; }
.as[data-motion='off'][data-state='subagents'] .as-dot:nth-child(odd) {
  --as-r: calc(var(--as-size) * 0.15);
  opacity: 0.55;
}
.as[data-motion='off'][data-state='reconnecting'] .as-dot { opacity: 0.9; }
.as[data-motion='off'][data-state='reconnecting'] .as-dot:nth-child(even) { opacity: 0.18; }
</style>
