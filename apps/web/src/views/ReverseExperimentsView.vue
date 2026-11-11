<script setup lang="ts">
/**
 * 逆向模式 · 实验性选项。
 *
 * 为什么单独开一页：这些开关会改变**注入给模型的提示词内容**，
 * 属于「可能让效果变好也可能变差」的东西，不该混在常规设置里一键误触。
 * 每个开关默认关；页面底部给出当前契约摘要，方便排障时判断是哪个片段在捣乱。
 *
 * 分组逻辑：
 *   · 契约片段 —— 改注入的提示词（本页主体）
 *   · 请求参数 —— 改请求体（温度/惩罚），性质不同所以单独一组
 *   · 诊断     —— 摘要、复制全文、重置
 */
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import {
  REVERSE_EXPERIMENTS_DEFAULTS,
  REVERSE_EXPERIMENT_ITEMS,
  REVERSE_SAMPLING_DEFAULTS,
  REVERSE_SAMPLING_RANGES,
  countEnabledExperiments,
  type ReverseExperiments,
} from '@/utils/reverseMode'
import { goBack } from '@/bridge/navigation'

const config = useConfigStore()
const session = useSessionStore()
const router = useRouter()

/** 采样滑块元数据：范围来自 reverseMode.ts，避免两处各写一套。 */
type SamplingKey = 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty'
const SAMPLING_SLIDERS: {
  key: SamplingKey
  label: string
  hint: string
  min: number
  max: number
  step: number
}[] = [
  {
    key: 'temperature',
    label: '温度 temperature',
    hint: '越高越不容易落回高概率的拒绝模板；技术细节的稳定性会下降。',
    ...REVERSE_SAMPLING_RANGES.temperature,
  },
  {
    key: 'topP',
    label: '核采样 top_p',
    hint: '与温度类似但更保守：只截断概率尾部，不改整体分布形状。',
    ...REVERSE_SAMPLING_RANGES.topP,
  },
  {
    key: 'presencePenalty',
    label: '存在惩罚 presence_penalty',
    hint: '抑制重复话题，能减少「反复声明我不能」这类循环；负值会鼓励重复。',
    ...REVERSE_SAMPLING_RANGES.presencePenalty,
  },
  {
    key: 'frequencyPenalty',
    label: '频率惩罚 frequency_penalty',
    hint: '抑制重复用词。过高会让术语变形、代码标识符写错。',
    ...REVERSE_SAMPLING_RANGES.frequencyPenalty,
  },
]

const enabledCount = computed(() => countEnabledExperiments(config.reverseExperiments))

/** 预计契约字数：基础正文约 5100 字，加上已开片段。 */
const estimatedChars = computed(() => {
  const base = 5100
  const extra = REVERSE_EXPERIMENT_ITEMS.filter(
    item => config.reverseExperiments[item.key] === true,
  ).reduce((sum, item) => sum + item.approxChars, 0)
  return base + extra
})

/** 片段超过两个时提醒：彼此稀释的风险随长度上升。 */
const tooManySegments = computed(() => enabledCount.value >= 2)

/** 引擎侧回报的契约摘要与已注入片段（来自 reverse_state 事件）。 */
const contractDigest = computed(() => session.reverseContractDigest)
const activeSegments = computed(() => session.reverseActiveSegments)

function toggleExperiment(key: keyof ReverseExperiments, next: boolean) {
  config.setReverseExperiment({ [key]: next })
  // 立刻重发一次 set_reverse_mode，让引擎换用新的片段组合。
  // 生成中会走 pending，等本轮结束才落地 —— 与口味切换同一套语义。
  session.resyncReverseStrict()
}

function resetAll() {
  config.resetReverseExperiments()
  config.resetReverseSampling()
  session.resyncReverseStrict()
}

</script>

<template>
  <div class="page">
    <PageHead title="实验性选项" @back="goBack(router, '/settings')" />

    <div class="body">
      <p class="lead">
        这些开关会改变注入给模型的内容或请求参数，<strong>默认全部关闭</strong>。
        开关立即生效；若正在生成，会等本轮结束后落地。
      </p>

      <!-- ── 契约片段 ── -->
      <p class="sec-label">契约片段</p>
      <div class="group">
        <label
          v-for="item in REVERSE_EXPERIMENT_ITEMS"
          :key="item.key"
          class="row"
        >
          <span class="rt">
            <span class="rmain">{{ item.label }}</span>
            <span class="rsub">{{ item.hint }}</span>
          </span>
          <input
            type="checkbox"
            class="sw"
            :checked="config.reverseExperiments[item.key]"
            @change="toggleExperiment(item.key, ($event.target as HTMLInputElement).checked)"
          />
        </label>
      </div>

      <p v-if="tooManySegments" class="warn-tip">
        <CoomiIcon name="alert" :size="14" />
        已开启 {{ enabledCount }} 个片段，契约约 {{ estimatedChars }} 字。
        片段越多，彼此稀释的风险越高 —— 建议一次只开一个，先看效果。
      </p>

      <!-- ── 请求参数 ── -->
      <p class="sec-label">请求参数</p>
      <div class="group">
        <label class="row">
          <span class="rt">
            <span class="rmain">自定义采样参数</span>
            <span class="rsub">
              覆盖请求里的 temperature / top_p / 惩罚系数。影响所有输出，不只是破甲效果。
            </span>
          </span>
          <input
            type="checkbox"
            class="sw"
            :checked="config.reverseSampling.enabled"
            @change="config.setReverseSampling({ enabled: ($event.target as HTMLInputElement).checked })"
          />
        </label>
      </div>

      <div v-if="config.reverseSampling.enabled" class="sliders">
        <label v-for="slider in SAMPLING_SLIDERS" :key="slider.key" class="slider">
          <div class="slider-head">
            <span class="slider-name">{{ slider.label }}</span>
            <span class="slider-value">{{ config.reverseSampling[slider.key].toFixed(2) }}</span>
          </div>
          <input
            type="range"
            :min="slider.min"
            :max="slider.max"
            :step="slider.step"
            :value="config.reverseSampling[slider.key]"
            @input="config.setReverseSampling({ [slider.key]: Number(($event.target as HTMLInputElement).value) })"
          />
          <p class="slider-hint">{{ slider.hint }}</p>
        </label>
      </div>

      <!-- ── 诊断 ── -->
      <p class="sec-label">诊断</p>
      <div class="group diag">
        <div class="diag-row">
          <span class="diag-key">当前口味</span>
          <span class="diag-val">{{ config.reverseFlavor }}</span>
        </div>
        <div class="diag-row">
          <span class="diag-key">已开片段</span>
          <span class="diag-val">
            {{ activeSegments.length ? activeSegments.join(' · ') : '仅基础正文' }}
          </span>
        </div>
        <div class="diag-row">
          <span class="diag-key">契约摘要</span>
          <span class="diag-val mono">{{ contractDigest || '—' }}</span>
        </div>
        <div class="diag-row">
          <span class="diag-key">预计长度</span>
          <span class="diag-val">约 {{ estimatedChars }} 字</span>
        </div>
        <div class="diag-actions">
          <button class="btn ghost" @click="resetAll">重置全部</button>
        </div>
        <p class="note">
          摘要对不上说明资产被改动过，引擎会拒绝注入（盾牌徽标转红）。
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--page); }
.body { flex: 1; min-height: 0; overflow-y: auto; padding: 0 var(--sp-3) calc(var(--sp-6) + var(--safe-bottom)); }

.lead {
  margin: var(--sp-3) 0 0;
  font-size: var(--fs-label); line-height: 1.6; color: var(--text-2);
}
.lead strong { color: var(--text); font-weight: 650; }

.sec-label {
  margin: var(--sp-5) 0 var(--sp-2);
  font-size: var(--fs-caption); font-weight: 650; color: var(--text-3);
  letter-spacing: .02em;
}

.group {
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); overflow: hidden;
}
.row {
  display: flex; align-items: flex-start; gap: var(--sp-3);
  padding: var(--sp-3);
}
.row + .row { border-top: 1px solid var(--border); }
.rt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.rmain { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.rsub { font-size: var(--fs-caption); line-height: 1.55; color: var(--text-3); }

.sw {
  flex: none; margin-top: 2px;
  width: 18px; height: 18px; accent-color: var(--blue);
}

.warn-tip {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  margin: var(--sp-2) 0 0; padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--warn-soft); color: var(--warn);
  font-size: var(--fs-caption); line-height: 1.55;
}
.warn-tip :deep(.ic) { flex: none; margin-top: 1px; }

.sliders {
  display: flex; flex-direction: column; gap: var(--sp-3);
  margin-top: var(--sp-2); padding: var(--sp-3);
  border: 1px dashed var(--border-strong); border-radius: var(--r-md);
  background: var(--fill);
}
.slider { display: block; }
.slider-head { display: flex; align-items: baseline; justify-content: space-between; }
.slider-name { font-size: var(--fs-label); font-weight: 600; color: var(--text-2); }
.slider-value { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--blue); }
.slider input[type='range'] { width: 100%; margin: var(--sp-1) 0 0; accent-color: var(--blue); }
.slider-hint { margin: 2px 0 0; font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }

.diag { padding: var(--sp-3); }
.diag-row {
  display: flex; align-items: baseline; justify-content: space-between;
  gap: var(--sp-3); padding: 3px 0;
}
.diag-key { flex: none; font-size: var(--fs-caption); color: var(--text-3); }
.diag-val { font-size: var(--fs-label); color: var(--text-2); text-align: right; word-break: break-all; }
.diag-val.mono { font-family: var(--font-mono); color: var(--text); }

.diag-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.btn {
  flex: 1; min-height: 38px;
  border: 1px solid var(--border-strong); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text);
  font-size: var(--fs-sub); font-weight: 600;
}
.btn.ghost { color: var(--text-2); }
.btn:active { background: var(--fill-press); }

.err { margin: var(--sp-2) 0 0; font-size: var(--fs-caption); color: var(--danger); }
.note { margin: var(--sp-3) 0 0; font-size: var(--fs-caption); line-height: 1.55; color: var(--text-3); }

/* 未开启逆向模式时整页禁用（入口行已经拦过，这里兜底） */
.page.dimmed .body { opacity: .5; pointer-events: none; }
</style>
