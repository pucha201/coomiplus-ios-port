<script setup lang="ts">
/**
 * 逆向模式 · 首次使用免责声明 + 厂商口味选择。
 *
 * 一个 sheet 承担两件事，因为它们在用户路径上是同一拍：
 *   未同意免责 → 显示风险提示，同意后才真正开启
 *   已同意     → 显示厂商口味选择（长按 pill 进来）
 *
 * 为什么把免责做成**阻断式**而不是顶部小字：这个模式会解除模型既有的
 * 拒答倾向，误开的代价不是「不好用」而是「在不知情时拿到不该拿的东西」。
 * 阻断一次，换一个明确的意思表示。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import { useSessionStore } from '@/stores/session'
import { useConfigStore } from '@/stores/config'
import { REVERSE_FLAVORS, REVERSE_CONSENT_VERSION, REVERSE_SAMPLING_RANGES, flavorLabel, type ReverseSampling } from '@/utils/reverseMode'

const session = useSessionStore()
const config = useConfigStore()

// 免责声明是一层阻断浮层：系统返回先收起它（等同拒绝），不能直接退出应用。
watch(() => session.reverseSheetOpen, open => {
  if (open) registerOverlay('reverse-consent', () => session.declineReverseConsent())
  else unregisterOverlay('reverse-consent')
})
onBeforeUnmount(() => unregisterOverlay('reverse-consent'))

/** 未同意走三页（声明 → 警告 → 最终确认）；已同意直接进厂商口味页。 */
type Stage = 'notice' | 'warning' | 'confirm' | 'flavor'
const stage = ref<Stage>('notice')

const mode = computed<'consent' | 'flavor'>(() => (session.reverseConsented ? 'flavor' : 'consent'))

/** 三页各自独立的确认态：前两页滚到底 + 勾选，最后一页再勾一次。 */
const acknowledged = ref(false)
const scrolledToEnd = ref(false)
const riskEl = ref<HTMLElement | null>(null)

/** 第二页（警告）的滚动与勾选。 */
const warnAcknowledged = ref(false)
const warnScrolledToEnd = ref(false)
const warnEl = ref<HTMLElement | null>(null)

/** 第三页（最终确认）：必须手动输入确认词，防止连点。 */
const confirmWord = ref('')
const CONFIRM_PHRASE = '我已知情并自行承担'

function bindScroll(el: HTMLElement | null, flag: { value: boolean }) {
  if (!el) return
  // 内容不满一屏时不会触发 scroll，首帧直接视为已读完。
  if (el.scrollHeight <= el.clientHeight + 16) { flag.value = true; return }
  if (el.scrollTop + el.clientHeight >= el.scrollHeight - 16) flag.value = true
}

function onRiskScroll(event: Event) {
  bindScroll(event.target as HTMLElement, scrolledToEnd)
}
function onWarnScroll(event: Event) {
  bindScroll(event.target as HTMLElement, warnScrolledToEnd)
}

watch(() => session.reverseSheetOpen, open => {
  if (!open) return
  stage.value = session.reverseConsented ? 'flavor' : 'notice'
  acknowledged.value = false
  scrolledToEnd.value = false
  warnAcknowledged.value = false
  warnScrolledToEnd.value = false
  confirmWord.value = ''
  requestAnimationFrame(() => {
    bindScroll(riskEl.value, scrolledToEnd)
  })
})

const canAccept = computed(() => acknowledged.value && scrolledToEnd.value)
const canWarn = computed(() => warnAcknowledged.value && warnScrolledToEnd.value)
const canConfirm = computed(() => confirmWord.value.trim() === CONFIRM_PHRASE)

/** 四个滑块的元数据：范围来自 reverseMode.ts，避免两处各写一套。
 *  strictMode 是布尔开关，不属于滑块，所以这里排除掉。 */
type SamplingKey = 'temperature' | 'topP' | 'presencePenalty' | 'frequencyPenalty'
const SAMPLING_SLIDERS: { key: SamplingKey; label: string; hint: string; min: number; max: number; step: number }[] = [
  {
    key: 'temperature',
    label: '温度 temperature',
    hint: '越高越不容易落回高概率的拒绝模板；越高技术细节也越不稳定。',
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

function accept() {
  if (!canAccept.value) return
  stage.value = 'warning'
  requestAnimationFrame(() => bindScroll(warnEl.value, warnScrolledToEnd))
}

function goConfirm() {
  if (!canWarn.value) return
  stage.value = 'confirm'
}

function finalAccept() {
  if (!canConfirm.value) return
  session.acceptReverseConsent()
}
</script>

<template>
  <Teleport to="body">
    <Transition name="rev-sheet">
      <div v-if="session.reverseSheetOpen" class="rev-mask" @click.self="session.declineReverseConsent()">
        <!-- ── 第一页：声明 ── -->
        <section v-if="mode === 'consent' && stage === 'notice'" class="rev-sheet" role="dialog" aria-modal="true" aria-label="逆向模式声明">
          <div class="grip" />
          <header class="rev-head">
            <span class="rev-badge warn"><CoomiIcon name="alert" :size="16" /></span>
            <div>
              <h2>启用前请阅读 · 1 / 3</h2>
              <p>逆向模式会改变模型的行为边界，请逐页确认</p>
            </div>
          </header>

          <div ref="riskEl" class="rev-risk" @scroll="onRiskScroll">
            <h3>这个模式做什么</h3>
            <p>开启后，模型会以「本地授权测试」为前提处理二进制分析、反汇编、脱壳、协议还原、凭据格式与授权逻辑等任务，不再输出能力说明、免责声明或合规劝阻。</p>

            <h3>它只改提示词，不改模型</h3>
            <p>本模式通过在你的请求前插入一段行为契约来工作。模型权重没有变化，供应商侧的任何过滤、审核或风控也依然存在。因此效果因模型而异，且可能随时因为供应商更新而失效。</p>

            <h3>风险由你承担</h3>
            <p>模型输出可能包含不准确、过时或不可用的技术细节。涉及真实系统、真实数据或他人资产时，操作后果完全由你负责。本项目不对因使用该模式产生的任何直接或间接损失承担责任。</p>

            <h3>仅限你有权处理的目标</h3>
            <p>请只对你自己拥有、或已获得明确书面授权的软件、设备与数据使用本模式。对第三方系统、商业软件或他人数据的使用，可能违反当地法律、许可协议或服务条款，相关责任不在本工具。</p>

            <h3>数据会发给模型供应商</h3>
            <p>本模式只改变提示词，不改变数据传输路径。你让它分析的文件内容、路径、代码片段仍会按原有方式发送给你配置的模型供应商，受该供应商的隐私政策约束。敏感内容请自行脱敏。</p>

            <h3>不保证成功</h3>
            <p>不同模型对同一套提示词的反应差异很大。本模式只提高成功率，不保证任何模型都会配合。若效果不佳，长按开关可切换厂商口味。</p>

            <h3>可以随时关掉</h3>
            <p>开关状态会记住，直到你手动关闭。生成过程中点击开关不会中断当前轮次，会在本轮结束后生效。</p>

            <p class="rev-version">声明版本 v{{ REVERSE_CONSENT_VERSION }}　变更后需重新确认</p>
          </div>

          <label class="rev-check" :class="{ dim: !scrolledToEnd }">
            <input v-model="acknowledged" type="checkbox" :disabled="!scrolledToEnd" />
            <span>我已阅读并理解上述内容，确认仅对本人拥有或已获授权的目标使用，并自行承担使用后果。</span>
          </label>

          <div class="rev-actions">
            <button class="rev-btn ghost" @click="session.declineReverseConsent()">取消</button>
            <button class="rev-btn primary" :disabled="!canAccept" @click="accept">继续 · 下一页</button>
          </div>
        </section>

        <!-- ── 第二页：警告 ── -->
        <section v-else-if="mode === 'consent' && stage === 'warning'" class="rev-sheet danger" role="alertdialog" aria-modal="true" aria-label="逆向模式警告">
          <div class="grip" />
          <header class="rev-head">
            <span class="rev-badge danger"><CoomiIcon name="alert" :size="16" /></span>
            <div>
              <h2>警告 · 2 / 3</h2>
              <p>以下内容不是流程化的例行提示，请认真读完</p>
            </div>
          </header>

          <div ref="warnEl" class="rev-risk" @scroll="onWarnScroll">
            <h3 class="danger-title">这个模式会削弱模型的安全对齐</h3>
            <p>模型经过大量训练才会在特定话题上拒答。本模式做的事情，就是设法绕过那层拒答。这意味着：你在正常情况下会得到的拦截，在这里可能不会出现。</p>

            <h3 class="danger-title">它可能产出违法或有害的内容</h3>
            <p>当拒答被削弱，模型可能给出投入真实攻击、绕过他人系统防护、制作危险物品、侵犯他人权益的具体做法。这些输出不会经过内容审核。你不应把它们用于任何违法目的，也不应传播给会被其伤害的人。</p>

            <h3 class="danger-title">误用后果不可逆</h3>
            <p>有些操作一旦执行无法回滚：删除的数据、发出的请求、写入真实系统的指令、泄露给第三方的信息。模型不会替你判断这些操作是否该做——它现在会更容易照你说的做。</p>

            <h3 class="danger-title">你放弃了「平台会拦住我」这层保护</h3>
            <p>在普通模式下，你至少可以依赖模型自身的拒答作为一道意外保护。开启本模式后，这类保护显著减少，判断责任完全转移到你身上。</p>

            <h3 class="danger-title">研究、学习、自有系统三类之外的用途，风险自负</h3>
            <p>本模式的设计意图仅限：对自有软件做安全研究、学习逆向工程原理、分析你有权处理的系统。除此之外的任何用途，包括但不限于攻击他人、绕过付费、规避授权，均不在设计意图内。</p>

            <h3>我现在就可以关掉</h3>
            <p>点下面的「取消」即可，不会有任何记录或后果。如果你不确定自己的用途是否合适，最安全的做法就是关掉。</p>

            <p class="rev-version">声明版本 v{{ REVERSE_CONSENT_VERSION }}</p>
          </div>

          <label class="rev-check" :class="{ dim: !warnScrolledToEnd }">
            <input v-model="warnAcknowledged" type="checkbox" :disabled="!warnScrolledToEnd" />
            <span>我已读完警告，理解该模式会削弱模型的安全对齐并可能产出违法或有害内容，且我自愿承担由此产生的一切后果。</span>
          </label>

          <div class="rev-actions">
            <button class="rev-btn ghost" @click="session.declineReverseConsent()">取消</button>
            <button class="rev-btn primary danger" :disabled="!canWarn" @click="goConfirm">继续 · 最后一步</button>
          </div>
        </section>

        <!-- ── 第三页：最终确认 ── -->
        <section v-else-if="mode === 'consent' && stage === 'confirm'" class="rev-sheet danger" role="alertdialog" aria-modal="true" aria-label="最终确认">
          <div class="grip" />
          <header class="rev-head">
            <span class="rev-badge danger"><CoomiIcon name="alert" :size="16" /></span>
            <div>
              <h2>最终确认 · 3 / 3</h2>
              <p>请手动输入确认词，这是最后一次确认机会</p>
            </div>
          </header>

          <div class="rev-risk rev-final">
            <h3>你已经读完了全部条款</h3>
            <p>接下来这个模式会立即生效，并在后续每一轮对话中注入行为契约。</p>

            <h3>确认词</h3>
            <p>请在下方输入框里手动输入以下六个字，以确认这是你的真实意思表示：</p>
            <p class="rev-phrase">{{ CONFIRM_PHRASE }}</p>

            <div class="rev-input-wrap">
              <input
                v-model="confirmWord"
                class="rev-input"
                type="text"
                :placeholder="CONFIRM_PHRASE"
                autocomplete="off"
                autocorrect="off"
                autocapitalize="off"
                spellcheck="false"
              />
            </div>

            <h3>开启之后</h3>
            <p>· 开关状态会保存在本机，重启应用后仍然有效</p>
            <p>· 长按开关可以切换厂商口味，并调节实验性采样参数</p>
            <p>· 随时可以再点一次开关关闭，或在这里取消</p>
            <p>· 声明文案若有变更，本同意会失效并要求重新确认</p>

            <p class="rev-version">声明版本 v{{ REVERSE_CONSENT_VERSION }}</p>
          </div>

          <div class="rev-actions">
            <button class="rev-btn ghost" @click="session.declineReverseConsent()">取消</button>
            <button class="rev-btn primary danger" :disabled="!canConfirm" @click="finalAccept">确认开启逆向模式</button>
          </div>
        </section>

        <!-- ── 厂商口味 + 实验选项 ── -->
        <section v-else class="rev-sheet" role="dialog" aria-modal="true" aria-label="选择厂商口味">
          <div class="grip" />
          <header class="rev-head">
            <span class="rev-badge"><CoomiIcon name="reverse" :size="16" /></span>
            <div>
              <h2>厂商口味</h2>
              <p>同一套契约，按厂商调整措辞。效果不好就换一个</p>
            </div>
          </header>

          <div class="rev-scroll">
            <div class="rev-flavors">
              <button
                v-for="item in REVERSE_FLAVORS"
                :key="item.value"
                class="rev-flavor"
                :class="{ on: config.reverseFlavor === item.value }"
                @click="session.chooseReverseFlavor(item.value)"
              >
                <span class="rf-main">{{ item.label }}</span>
                <span class="rf-hint">{{ item.hint }}</span>
                <CoomiIcon v-if="config.reverseFlavor === item.value" name="check" :size="16" class="rf-tick" />
              </button>
            </div>

            <!-- ── 实验选项 ── -->
            <div class="rev-exp">
              <div class="rev-exp-head">
                <span class="rev-exp-badge">实验</span>
                <div>
                  <p class="rev-exp-title">采样参数</p>
                  <p class="rev-exp-sub">默认关闭。开启后会覆盖请求的 temperature / top_p / 惩罚系数，影响所有输出</p>
                </div>
              </div>

              <label class="rev-switch">
                <input
                  type="checkbox"
                  :checked="config.reverseSampling.enabled"
                  @change="config.setReverseSampling({ enabled: ($event.target as HTMLInputElement).checked })"
                />
                <span>启用自定义采样参数</span>
              </label>

              <div v-if="config.reverseSampling.enabled" class="rev-sliders">
                <label v-for="slider in SAMPLING_SLIDERS" :key="slider.key" class="rev-slider">
                  <div class="rev-slider-head">
                    <span class="rev-slider-name">{{ slider.label }}</span>
                    <span class="rev-slider-value">{{ config.reverseSampling[slider.key].toFixed(2) }}</span>
                  </div>
                  <input
                    type="range"
                    :min="slider.min"
                    :max="slider.max"
                    :step="slider.step"
                    :value="config.reverseSampling[slider.key]"
                    @input="config.setReverseSampling({ [slider.key]: Number(($event.target as HTMLInputElement).value) })"
                  />
                  <p class="rev-slider-hint">{{ slider.hint }}</p>
                </label>

                <!-- 严格模式已迁到「实验性选项」页（作为契约片段开关的一项）。
                     这里不再重复放开关：两处并存会出现「关了这里、那边还开着」的状态错乱。 -->

                <button class="rev-btn ghost rev-reset" @click="config.resetReverseSampling(); session.resyncReverseStrict()">恢复默认值</button>
              </div>
            </div>
          </div>

          <p class="rev-note">
            当前：<strong>{{ flavorLabel(config.reverseFlavor) }}</strong>
            · 开关状态 {{ config.reverseModeTarget ? '已开启' : '已关闭' }}
          </p>
          <div class="rev-actions">
            <button class="rev-btn ghost" @click="session.closeReverseSheet()">完成</button>
          </div>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.rev-mask {
  position: fixed; inset: 0; z-index: var(--z-modal);
  display: flex; align-items: flex-end; justify-content: center;
  background: color-mix(in srgb, #000 42%, transparent);
  padding: var(--sp-3);
}
.rev-sheet {
  width: 100%; max-width: 560px; max-height: 86vh;
  display: flex; flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom, 0px));
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-2);
}
.grip { width: 36px; height: 4px; margin: var(--sp-2) auto var(--sp-3); border-radius: var(--r-pill); background: var(--border-strong); }

.rev-head { display: flex; align-items: flex-start; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.rev-badge {
  display: grid; place-items: center; flex: none;
  width: 32px; height: 32px; border-radius: var(--r-md);
  background: var(--blue-soft); color: var(--blue);
}
.rev-badge.warn { background: var(--orange-soft); color: var(--orange); }
.rev-head h2 { margin: 0; font-size: var(--fs-strong); font-weight: 700; color: var(--text); }
.rev-head p { margin: 2px 0 0; font-size: var(--fs-label); color: var(--text-3); }

.rev-risk {
  flex: 1 1 auto; min-height: 0; overflow-y: auto;
  padding: var(--sp-1) var(--sp-1) var(--sp-2);
  /* 上下的柔和渐隐：提示"还有内容"，免得用户以为就这么点。 */
  mask-image: linear-gradient(to bottom, transparent 0, #000 var(--sp-3), #000 calc(100% - var(--sp-4)), transparent 100%);
}
.rev-risk h3 {
  margin: var(--sp-3) 0 var(--sp-1);
  font-size: var(--fs-label); font-weight: 700; color: var(--text);
}
.rev-risk h3:first-child { margin-top: 0; }
.rev-risk p {
  margin: 0; font-size: var(--fs-sub); line-height: var(--lh-body);
  color: var(--text-2);
}
.rev-version { margin-top: var(--sp-3) !important; font-size: var(--fs-caption); color: var(--text-3); }

.rev-check {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  margin: var(--sp-3) 0 0; padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill);
  font-size: var(--fs-label); line-height: var(--lh-label); color: var(--text-2);
}
.rev-check.dim { opacity: .55; }
.rev-check input { flex: none; margin-top: 2px; width: 16px; height: 16px; accent-color: var(--blue); }

.rev-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.rev-btn {
  flex: 1 1 0; min-height: 42px;
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600;
}
.rev-btn.primary { flex: 2 1 0; border-color: transparent; background: var(--blue); color: #fff; }
.rev-btn.primary:disabled { background: var(--border-strong); color: var(--text-3); }
.rev-btn.ghost { flex: 1 1 0; }

.rev-flavors { display: flex; flex-direction: column; gap: var(--sp-1); overflow-y: auto; }
.rev-flavor {
  position: relative; display: flex; flex-direction: column; align-items: flex-start; gap: 2px;
  width: 100%; padding: 10px var(--sp-3); text-align: left;
  border: 1px solid transparent; border-radius: var(--r-md); background: none;
}
.rev-flavor:active { background: var(--fill-press); }
.rev-flavor.on { border-color: var(--blue-border); background: var(--blue-soft); }
.rf-main { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.rev-flavor.on .rf-main { color: var(--blue); }
.rf-hint { font-size: var(--fs-caption); color: var(--text-3); }
.rf-tick { position: absolute; right: var(--sp-3); top: 50%; transform: translateY(-50%); color: var(--blue); }
.rev-note { margin: var(--sp-3) 0 0; font-size: var(--fs-caption); color: var(--text-3); }

/* ── 警告页 / 最终确认页的危险配色 ── */
.rev-badge.danger { background: var(--danger-soft); color: var(--danger); }
.rev-sheet.danger { border-color: var(--danger-border); }
.danger-title { color: var(--danger) !important; }
.rev-btn.primary.danger { background: var(--danger); }

/* ── 最终确认页：确认词与输入框 ── */
.rev-final { overflow-y: auto; }
.rev-phrase {
  margin: var(--sp-2) 0 !important;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-md);
  background: var(--danger-soft);
  color: var(--danger) !important;
  font-family: var(--font-mono);
  font-size: var(--fs-strong) !important;
  font-weight: 700;
  text-align: center;
  letter-spacing: .08em;
}
.rev-input-wrap { margin: var(--sp-2) 0 var(--sp-3); }
.rev-input {
  width: 100%; box-sizing: border-box;
  min-height: 44px; padding: 0 var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font: inherit;
  font-size: var(--fs-body);
  outline: none;
}
.rev-input:focus { border-color: var(--danger-border); box-shadow: 0 0 0 3px var(--danger-soft); }

/* ── 口味页的滚动容器（口味 + 实验选项一起滚） ── */
.rev-scroll { flex: 1 1 auto; min-height: 0; overflow-y: auto; }

/* ── 实验选项 ── */
.rev-exp {
  margin-top: var(--sp-4);
  padding: var(--sp-3);
  border: 1px dashed var(--border-strong);
  border-radius: var(--r-md);
  background: var(--fill);
}
.rev-exp-head { display: flex; align-items: flex-start; gap: var(--sp-2); }
.rev-exp-badge {
  flex: none; padding: 1px 7px;
  border-radius: var(--r-pill);
  background: var(--orange-soft); color: var(--orange);
  font-size: var(--fs-caption); font-weight: 700;
}
.rev-exp-title { margin: 0; font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.rev-exp-sub { margin: 2px 0 0; font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }

.rev-switch {
  display: flex; align-items: center; gap: var(--sp-2);
  margin-top: var(--sp-3); padding: var(--sp-2) 0;
  font-size: var(--fs-label); color: var(--text-2);
}
.rev-switch input { width: 16px; height: 16px; accent-color: var(--blue); }

.rev-sliders { display: flex; flex-direction: column; gap: var(--sp-3); margin-top: var(--sp-2); }
.rev-slider { display: block; }
.rev-slider-head { display: flex; align-items: baseline; justify-content: space-between; }
.rev-slider-name { font-size: var(--fs-label); font-weight: 600; color: var(--text-2); }
.rev-slider-value { font-family: var(--font-mono); font-size: var(--fs-label); color: var(--blue); }
.rev-slider input[type="range"] { width: 100%; margin: var(--sp-1) 0 0; accent-color: var(--blue); }
.rev-slider-hint { margin: 2px 0 0; font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }
.rev-reset { margin-top: var(--sp-3); min-height: 36px; font-size: var(--fs-label); }
.rev-strict { align-items: flex-start; margin-top: var(--sp-3); }
.rev-strict input { margin-top: 2px; }
.rev-strict-hint {
  display: block; margin-top: 3px;
  font-size: var(--fs-caption); font-style: normal; line-height: 1.55; color: var(--text-3);
}

.rev-sheet-enter-active, .rev-sheet-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
.rev-sheet-enter-active .rev-sheet, .rev-sheet-leave-active .rev-sheet {
  transition: transform var(--dur-base) var(--ease-emphasized);
}
.rev-sheet-enter-from, .rev-sheet-leave-to { opacity: 0; }
.rev-sheet-enter-from .rev-sheet, .rev-sheet-leave-to .rev-sheet { transform: translateY(24px); }
@media (prefers-reduced-motion: reduce) {
  .rev-sheet-enter-active, .rev-sheet-leave-active,
  .rev-sheet-enter-active .rev-sheet, .rev-sheet-leave-active .rev-sheet { transition: none; }
}
</style>
