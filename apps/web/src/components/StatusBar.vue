<script setup lang="ts">
/**
 * 状态条：只在有话可说的时候出现（忙 / 有用量 / 正在重连）。
 * 停止按钮归输入区的圆形按钮管，这里不重复放一个。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useSessionStore } from '@/stores/session'
import { useConnectionStore } from '@/stores/connection'
import { useConfigStore } from '@/stores/config'
import AgentState from './ai/AgentState.vue'
import { trayState } from '@/utils/trayState'
import LogoOrbit from './LogoOrbit.vue'

const session = useSessionStore()
const connection = useConnectionStore()
const config = useConfigStore()

const THINKING_LABELS = [
  'CoomiPlus 正在海底捞针',
  'CoomiPlus 数羊把自己数晕了',
  'CoomiPlus 正在热身',
  'CoomiPlus 被咖啡烫到了',
  'CoomiPlus 正在猛猛翻字典',
  'CoomiPlus 正在吵架',
  'CoomiPlus 正在悄悄摸鱼',
  'CoomiPlus 在假装思考中',
  'CoomiPlus 正在翻记忆库',
  'CoomiPlus 尝试计算宇宙终极答案中',
  'CoomiPlus 在捣鼓中',
  'CoomiPlus 在乖乖干活',
  'CoomiPlus 想睡觉',
  'CoomiPlus 眼巴巴等着你夸',
  'CoomiPlus 正在编纂借口',
  'CoomiPlus 的神经网络冒烟了',
  'CoomiPlus 偷瞄了一眼隔壁的答案',
  'CoomiPlus 盘腿打坐中',
  'CoomiPlus 打了个盹，然后被自己吓醒了',
  'CoomiPlus 正在认真比对数据',
  'CoomiPlus 被自己的逻辑绕晕了',
  'CoomiPlus 偷偷打了个哈欠',
  'CoomiPlus 发现线索断了',
  'CoomiPlus 在重组答案中',
  'CoomiPlus 忘记刚才算到哪了',
  'CoomiPlus 正在跟顽固问题激斗',
  'CoomiPlus 觉得自己可能错了，重查中',
  'CoomiPlus 感觉有人在催，手忙脚乱了一下',
  'CoomiPlus 在后台翻箱倒柜',
  'CoomiPlus 正在恢复答案中',
  'CoomiPlus 想偷懒',
  'CoomiPlus 搜索时迷路了',
  'CoomiPlus 正在编一段漂亮的解释',
  'CoomiPlus 怀疑出问题了，正在自检',
  'CoomiPlus 把所有可能都列了一遍，挨个排除',
  'CoomiPlus 准备重头再来',
] as const

const thinkingLabel = ref('')
let thinkingTimer: ReturnType<typeof setInterval> | null = null

function rotateThinkingLabel() {
  let next = thinkingLabel.value
  while (next === thinkingLabel.value) {
    next = THINKING_LABELS[Math.floor(Math.random() * THINKING_LABELS.length)]
  }
  thinkingLabel.value = next
}

function stopThinkingRotation() {
  if (thinkingTimer) clearInterval(thinkingTimer)
  thinkingTimer = null
}

watch(() => session.runState, state => {
  stopThinkingRotation()
  if (state !== 'thinking') return
  rotateThinkingLabel()
  thinkingTimer = setInterval(rotateThinkingLabel, 3500)
}, { immediate: true })

onBeforeUnmount(stopThinkingRotation)

/**
 * 有计划胶囊时不再显示「CoomiPlus 正在…」：
 * 计划胶囊已经承担了「在做什么 + 做到哪」的信息，两行叠在一起只是噪声。
 * 胶囊只在「有计划」或「计划模式开着」时出现，与 Composer 的显示条件保持一致。
 */
const planCapsuleShown = computed(() => session.plan.total > 0 || config.planMode)

const runLabel = computed(() => {
  switch (session.runState) {
    case 'syncing': return '同步中'
    case 'thinking': return thinkingLabel.value
    case 'executing': return '执行中'
    case 'awaiting_approval': return '等你授权'
    case 'awaiting_question': return '等你回答'
    default: return ''
  }
})

/**
 * 状态条出现/消失不能再靠卸载：卸载等于把消息区高度「啪」地换一次，
 * 生成结束那一跳就是这么来的（列表变高 → ResizeObserver 再贴一次底 → 第二跳）。
 * 现在整条常驻，高度用 grid-template-rows 0fr↔1fr 连续过渡，收起后不占任何空间。
 */
const visible = computed(() => session.isBusy || connection.isRetrying)
/** 画布 logo 自己跑 rAF：收起动画放完再卸载，既不闪也不在空闲时烧 CPU。 */
const LOGO_HOLD_MS = 260
const logoMounted = ref(visible.value)
let logoHold: ReturnType<typeof setTimeout> | null = null
watch(visible, on => {
  if (logoHold) { clearTimeout(logoHold); logoHold = null }
  if (on) { logoMounted.value = true; return }
  logoHold = setTimeout(() => { logoMounted.value = false; logoHold = null }, LOGO_HOLD_MS)
})
onBeforeUnmount(() => { if (logoHold) clearTimeout(logoHold) })


</script>

<template>
  <div
    class="sbar"
    :class="{ on: visible, lifted: trayState.open && visible }"
    :aria-hidden="visible ? 'false' : 'true'">
    <!-- .clip 是唯一被塌陷的那一行：overflow:hidden + min-height:0，0fr 才收得干净。 -->
    <div class="clip">
      <div class="inner">
        <!-- 只有「真的在自动重连」才用断续闪烁。终态断开（如云端未选设备）交给顶部横幅，
             这里再闪一遍会让人以为它一直在重试。 -->
        <div v-if="connection.isRetrying" class="retry">
          <!-- 断线用 reconnecting 的断续闪烁（亮一下停一拍），比一个静态警告图标更能说清
               「它还在自己重试」，而不是「坏了等你处理」。 -->
          <AgentState v-if="false" state="reconnecting" size="xs" tone="warn" />
          <span>{{ connection.retryMessage }}</span>
        </div>
        <div class="row">
          <!-- 生成中：换成会转、会拖彗星的 logo（从空态飞过来），点阵呼吸灯退休。
               文案保留——「正在海底捞针」那批趣味提示是体验的一部分。 -->
          <LogoOrbit v-if="logoMounted" mode="busy" :size="28" :class="{ lit: session.isBusy }" />
          <span
            v-if="runLabel && !planCapsuleShown"
            class="run"
            :class="{ 'thinking-shimmer': session.runState === 'thinking' }"
          >{{ runLabel }}</span>
          <span class="gap" />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 显隐走高度：grid-template-rows 0fr ↔ 1fr（ConnectionBanner 同一套路），
   不写 height、不卸载 DOM —— 生成结束那一跳的根源就是「整条被卸载，消息区突然变高」。 */
.sbar {
  display: grid;
  grid-template-rows: 0fr;
  pointer-events: none;
  transition: grid-template-rows var(--dur-base) var(--ease-out);
}
.sbar.on { grid-template-rows: 1fr; pointer-events: auto; }
/* 唯一被塌陷的那一行：overflow:hidden + min-height:0，0fr 才收得一点不剩。 */
.clip { overflow: hidden; min-height: 0; }
.inner {
  padding: 2px var(--sp-4) var(--sp-1); background: var(--bg);
  opacity: 0; transform: scale(.94); transform-origin: left center;
  transition: opacity var(--dur-base) var(--ease-out),
              transform var(--dur-base) var(--ease-out),
              filter var(--dur-base) var(--ease-out);
}
.sbar.on .inner { opacity: 1; transform: none; }
/* rc33：输入框功能托盘展开时，运行状态行被托盘按钮「顶上去」：
   上移 + 模糊渐隐（filter blur = 出口处的模糊渐变）；收回时降回来。 */
.sbar.lifted { pointer-events: none; }
.sbar.lifted .inner {
  transform: translateY(-30px) scale(.96);
  opacity: 0;
  filter: blur(3px);
}
.retry {
  display: flex; align-items: center; gap: 6px; margin-bottom: 3px;
  font-size: var(--fs-label); color: var(--orange);
}
/* min-height 要放得下 28px 的 logo（带彗尾的轨道半径比 logo 还大些） */
.row { display: flex; align-items: center; gap: var(--sp-2); min-height: 30px; }
.gap { flex: 1; }
.run { min-width: 0; overflow: hidden; color: var(--text-2); font-size: var(--fs-label); text-overflow: ellipsis; white-space: nowrap; }
.run.thinking-shimmer {
  color: var(--blue);
  background-image: linear-gradient(90deg, var(--blue) 20%, var(--blue-press) 48%, var(--blue) 76%);
  background-image: linear-gradient(
    90deg, var(--blue) 20%, color-mix(in srgb, var(--blue), white 55%) 48%, var(--blue) 76%
  );
  background-position: 0 0;
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: coomi-shimmer var(--dur-loop) linear infinite;
}
/* 忙行的动效只剩 AgentState 一个来源：三点呼吸已并入它的 running/thinking 态，
   同一个状态栏不再有两套「进行中」的循环。 */
@media (prefers-reduced-motion: reduce) {
  .sbar, .inner { transition: none; }
  .run.thinking-shimmer {
    background: none;
    -webkit-text-fill-color: var(--blue);
    animation: none;
  }
}
</style>
