<script setup lang="ts">
/**
 * 工具调用卡片。
 *
 * 折叠态一行说清「谁 / 对什么 / 结果如何」，展开态才给参数、内容、diff、输出。
 * 状态是有语义色的：运行中蓝 + 左侧流光，成功绿勾，失败红叉且输出染红，
 * 待授权橙（真正的确认交给底部 ApprovalSheet，卡片只说明原因），缓存命中灰闪电。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import { asText, toolMeta, toolTarget } from '@/utils/toolMeta'
import { useSessionStore } from '@/stores/session'
import { toolCardOpenState } from '@/utils/processState'
import { apiGet } from '@/bridge/http'
import CoomiIcon from './CoomiIcon.vue'
import AgentState, { toolActivityOf } from './ai/AgentState.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const props = defineProps<{ card: ToolCard }>()
const session = useSessionStore()

/** 大字段单独成块，不塞进参数表。 */
const BIG = new Set(['content', 'old_string', 'new_string', 'prompt'])

const sheetKey = computed(() => `${session.sessionId}:${props.card.callId}`)
const full = ref(false)
const copied = ref(false)
/** 超过 64KB 时从会话接口按需取全文，避免实时事件塞满 WS。 */
const fullOutput = ref('')
const fullOpen = ref(false)
const fullLoading = ref(false)
const fullError = ref('')

// ── 图片瀑布流 + 全屏预览（点击放大 / 另存为）──
const previewSrc = ref('')
const previewName = ref('coomi-image.png')
const previewStage = ref<HTMLElement | null>(null)
const previewImage = ref<HTMLImageElement | null>(null)
const previewScale = ref(1)
const previewX = ref(0)
const previewY = ref(0)
const pointers = new Map<number, { x: number; y: number }>()
let gestureScale = 1
let gestureX = 0
let gestureY = 0
let gestureDistance = 0
let gestureMidX = 0
let gestureMidY = 0

const previewTransform = computed(() => ({
  transform: `translate3d(${previewX.value}px, ${previewY.value}px, 0) scale(${previewScale.value})`,
}))

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value))
}

function clampPreviewPosition() {
  const stage = previewStage.value
  const image = previewImage.value
  if (!stage || !image) return
  const maxX = Math.max(0, (image.offsetWidth * previewScale.value - stage.clientWidth) / 2)
  const maxY = Math.max(0, (image.offsetHeight * previewScale.value - stage.clientHeight) / 2)
  previewX.value = clamp(previewX.value, -maxX, maxX)
  previewY.value = clamp(previewY.value, -maxY, maxY)
}

function resetPreviewTransform() {
  previewScale.value = 1
  previewX.value = 0
  previewY.value = 0
  pointers.clear()
}

function closePreview() {
  unregisterOverlay(`image-preview:${props.card.callId}`)
  previewSrc.value = ''
  resetPreviewTransform()
}

function pointerDistance(points: Array<{ x: number; y: number }>) {
  return Math.hypot(points[1].x - points[0].x, points[1].y - points[0].y)
}

function pointerMidpoint(points: Array<{ x: number; y: number }>) {
  return { x: (points[0].x + points[1].x) / 2, y: (points[0].y + points[1].y) / 2 }
}

function startGesture() {
  const points = [...pointers.values()]
  gestureScale = previewScale.value
  gestureX = previewX.value
  gestureY = previewY.value
  if (points.length >= 2) {
    gestureDistance = Math.max(1, pointerDistance(points))
    const midpoint = pointerMidpoint(points)
    gestureMidX = midpoint.x
    gestureMidY = midpoint.y
  } else if (points.length === 1) {
    gestureMidX = points[0].x
    gestureMidY = points[0].y
  }
}

function onPreviewPointerDown(event: PointerEvent) {
  previewStage.value?.setPointerCapture(event.pointerId)
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  startGesture()
}

function onPreviewPointerMove(event: PointerEvent) {
  if (!pointers.has(event.pointerId)) return
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY })
  const points = [...pointers.values()]
  if (points.length >= 2) {
    const midpoint = pointerMidpoint(points)
    previewScale.value = clamp(gestureScale * pointerDistance(points) / gestureDistance, 1, 5)
    previewX.value = gestureX + midpoint.x - gestureMidX
    previewY.value = gestureY + midpoint.y - gestureMidY
  } else if (points.length === 1 && previewScale.value > 1) {
    previewX.value = gestureX + points[0].x - gestureMidX
    previewY.value = gestureY + points[0].y - gestureMidY
  }
  clampPreviewPosition()
}

function onPreviewPointerEnd(event: PointerEvent) {
  pointers.delete(event.pointerId)
  startGesture()
}

function togglePreviewZoom(event: MouseEvent) {
  if (previewScale.value > 1) {
    resetPreviewTransform()
    return
  }
  const stage = previewStage.value
  if (!stage) return
  const rect = stage.getBoundingClientRect()
  previewScale.value = 2.5
  previewX.value = (rect.width / 2 - (event.clientX - rect.left)) * 1.5
  previewY.value = (rect.height / 2 - (event.clientY - rect.top)) * 1.5
  clampPreviewPosition()
}

function openPreview(src: string) {
  resetPreviewTransform()
  previewSrc.value = src
  registerOverlay(`image-preview:${props.card.callId}`, closePreview)
  const mime = src.match(/^data:([^;]+)/)?.[1] ?? 'image/png'
  const ext = (mime.split('/')[1] ?? 'png').replace('jpeg', 'jpg')
  previewName.value = `coomi-${Date.now()}.${ext}`
}

onBeforeUnmount(() => {
  unregisterOverlay(`image-preview:${props.card.callId}`)
  unregisterOverlay(`tool-output:${props.card.callId}`)
  unregisterOverlay(`tool-detail:${props.card.callId}`)
})

function savePreview() {
  if (!previewSrc.value) return
  if (window.CoomiAndroid?.saveImageData) {
    window.CoomiAndroid.saveImageData(previewSrc.value, previewName.value)
  } else {
    // 浏览器兜底：直接下载
    const a = document.createElement('a')
    a.href = previewSrc.value
    a.download = previewName.value
    a.click()
  }
}

const meta = computed(() => toolMeta(props.card.toolName))
const target = computed(() => toolTarget(props.card.arguments))
const isShowImage = computed(() => props.card.toolName === 'show_image')
const imgPath = computed(() => asStr(props.card.arguments?.path))
const asStr = asText

const st = computed(() => {
  switch (props.card.status) {
    case 'success': return { label: '', cls: 'ok', icon: 'check' }
    case 'error': return { label: '失败', cls: 'err', icon: 'close' }
    case 'cancelled': return { label: '已取消', cls: 'cancelled', icon: 'close' }
    case 'awaiting_approval': return { label: '待授权', cls: 'wait', icon: 'shield' }
    case 'cache_hit': return { label: '缓存', cls: 'cache', icon: 'bolt' }
    case 'starting': return { label: '准备', cls: 'run', icon: '' }
    default: return { label: '运行中', cls: 'run', icon: '' }
  }
})

/**
 * 工具卡头部的状态点阵：按工具类型给 running / reading / writing / searching，
 * 待授权时给 awaiting（点阵是静态慢心跳，和「在跑」明确区分）。
 * 已经结束（成功 / 失败 / 取消 / 缓存命中）不再显示点阵 —— 停下来就别再动。
 */
const toolState = computed(() => {
  if (props.card.status === 'awaiting_approval') return 'awaiting'
  if (props.card.status !== 'starting' && props.card.status !== 'running') return null
  return toolActivityOf(props.card.toolName)
})

const argRows = computed(() =>
  Object.entries(props.card.arguments ?? {})
    .filter(([k, v]) => !BIG.has(k) && v != null && v !== '')
    .map(([k, v]) => ({ k, v: asStr(v) })),
)

const contentArg = computed(() => asStr(props.card.arguments?.content) || asStr(props.card.arguments?.prompt))
const oldStr = computed(() => asStr(props.card.arguments?.old_string))
const newStr = computed(() => asStr(props.card.arguments?.new_string))
const isDiff = computed(() => Boolean(oldStr.value || newStr.value))
const output = computed(() => fullOutput.value || props.card.resultFull || props.card.resultPreview || '')

const diffLines = computed(() => {
  const out: { sign: '-' | '+'; text: string }[] = []
  if (oldStr.value) for (const t of oldStr.value.split('\n')) out.push({ sign: '-', text: t })
  if (newStr.value) for (const t of newStr.value.split('\n')) out.push({ sign: '+', text: t })
  return out
})

const hasBody = computed(() => argRows.value.length > 0 || Boolean(contentArg.value) || isDiff.value || Boolean(output.value) || Boolean(props.card.riskSummary) || (props.card.images?.length ?? 0) > 0 || Boolean(props.card.imageMissing))
/** 详情改走独立 sheet：不再在消息流里撑高，避免 DynamicScroller 重排与掉帧。
 *  开合状态按 callId 记在模块表里：生成中卡片从单卡块并入过程块会重建实例，
 *  本地 ref 会在这时被顺手关掉（用户看到的「详情自己关了」）。 */
const open = computed(() => toolCardOpenState.get(sheetKey.value) === true)
const long = computed(() => output.value.length > 700 || output.value.split('\n').length > 14)

/** 打开瞬间冻结内容：流式期间正文继续增长，但不让弹层跟着重渲染。 */
const sheetSnapshot = ref(0)
function toggle() {
  if (!hasBody.value) return
  if (!open.value) sheetSnapshot.value += 1
  toolCardOpenState.set(sheetKey.value, !open.value)
}

/**
 * 详情 sheet 也是一层浮层：系统返回必须先关它，而不是直接退出应用。
 * 以前只有「完整输出」和图片预览登记了 overlay，详情本身没登记 ——
 * 展开工具详情后按返回键，closeTopOverlay() 返回 false，对话页直接 exit。
 */
watch(open, isOpen => {
  if (isOpen) registerOverlay(`tool-detail:${props.card.callId}`, () => toggle())
  else unregisterOverlay(`tool-detail:${props.card.callId}`)
}, { immediate: true })

/** 完整输出 >64KB 时按需拉取：只读展示，不修改会话。 */
async function openFullOutput() {
  fullOpen.value = true
  registerOverlay(`tool-output:${props.card.callId}`, closeFullOutput)
  if (fullOutput.value) return
  fullLoading.value = true
  fullError.value = ''
  try {
    const data = await apiGet<{ content?: string }>(
      `/api/sessions/${encodeURIComponent(session.sessionId)}/tool-output/${encodeURIComponent(props.card.callId)}`,
    )
    fullOutput.value = data.content ?? ''
    if (!fullOutput.value) fullError.value = '没有找到这条工具调用的完整输出'
  } catch (error) {
    fullError.value = error instanceof Error ? error.message : String(error)
  } finally {
    fullLoading.value = false
  }
}

function closeFullOutput() {
  unregisterOverlay(`tool-output:${props.card.callId}`)
  fullOpen.value = false
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    // WebView 里 clipboard API 偶尔不可用，退回老办法
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    try { document.execCommand('copy') } catch { /* 放弃 */ }
    document.body.removeChild(ta)
  }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1400)
}
</script>

<template>
  <div class="tool" :class="[st.cls, { open }]">
    <button class="head" :class="{ tapable: hasBody }" @click="toggle">
      <span class="tile" :class="st.cls">
        <CoomiIcon :name="meta.icon" :size="17" />
      </span>

      <span class="txt">
        <span class="verb">{{ meta.verb }}</span>
        <code v-if="target" class="target">{{ target }}</code>
      </span>

      <span class="st" :class="st.cls">
        <AgentState v-if="toolState" :state="toolState" size="xs" class="st-state" />
        <CoomiIcon v-if="st.icon" :name="st.icon" :size="14" />
        <span v-if="st.label">{{ st.label }}</span>
        <span v-if="card.elapsed != null" class="ms">{{ card.elapsed.toFixed(1) }}s</span>
      </span>

      <CoomiIcon v-if="hasBody" name="chevronRight" :size="14" class="chev" :class="{ open }" />
    </button>

    <div v-if="card.status === 'awaiting_approval'" class="risk">
      <CoomiIcon name="alert" :size="15" />
      <span>{{ card.riskSummary || '需要你授权后才会执行' }}<template v-if="card.access"> · {{ card.access }}</template></span>
    </div>

    <div v-if="!open && card.images && card.images.length" class="inline-thumbs">
      <img
        v-for="(src, i) in card.images.slice(0, 3)"
        :key="i"
        :src="src"
        :alt="`图片 ${i + 1}`"
        loading="lazy"
        decoding="async"
        @click.stop="openPreview(src)"
      />
      <span v-if="card.images.length > 3" class="thumb-more">+{{ card.images.length - 3 }}</span>
    </div>

    <Teleport to="body">
      <Transition name="sheet-pop">
      <div v-if="open && hasBody" class="tool-sheet-mask" @click.self="toggle">
        <section class="tool-sheet" role="dialog" aria-modal="true" :aria-label="`${meta.verb} 详情`">
          <div class="grip" />
          <header class="ts-head">
            <span class="ts-title">{{ meta.verb }}<code v-if="target" class="ts-target">{{ target }}</code></span>
            <span v-if="st.label" class="ts-state" :class="st.cls">{{ st.label }}</span>
            <button class="ts-close" aria-label="关闭" @click="toggle"><CoomiIcon name="close" :size="16" /></button>
          </header>
          <div class="body" v-memo="[sheetSnapshot]">
      <!-- 图片瀑布流：工具产生的图片平铺展示，点击全屏预览 -->
      <div v-if="card.images && card.images.length" class="sec" :class="{ showimg: isShowImage }">
        <p class="slabel">图片</p>
        <div class="imgs" :class="{ showimg: isShowImage }">
          <img
            v-for="(src, i) in card.images"
            :key="i"
            class="thumb"
            :class="{ showimg: isShowImage }"
            :src="src"
            :alt="`图片 ${i + 1}`"
            loading="lazy"
            decoding="async"
            @click.stop="openPreview(src)"
          />
        </div>
        <p v-if="isShowImage && imgPath" class="ipath">{{ imgPath }}</p>
      </div>
      <div v-else-if="card.imageMissing" class="sec">
        <p class="slabel">图片</p>
        <p class="inone">找不到图片：图片数据不可用（可能已被上下文压缩清理）</p>
      </div>

      <div v-if="argRows.length" class="sec">
        <p class="slabel">参数</p>
        <div class="args">
          <div v-for="r in argRows" :key="r.k" class="arg">
            <span class="ak">{{ r.k }}</span>
            <code class="av">{{ r.v }}</code>
          </div>
        </div>
      </div>

      <div v-if="isDiff" class="sec">
        <p class="slabel">改动</p>
        <div class="diff">
          <div v-for="(l, i) in diffLines" :key="i" class="dl" :class="l.sign === '+' ? 'add' : 'del'">
            <span class="dsign">{{ l.sign }}</span><span class="dtext">{{ l.text || ' ' }}</span>
          </div>
        </div>
      </div>

      <div v-if="contentArg && !isDiff" class="sec">
        <div class="sbar">
          <p class="slabel">内容</p>
          <button class="mini" aria-label="复制参数" title="复制参数" @click.stop="copy(contentArg)"><CoomiIcon :name="copied ? 'check' : 'copy'" :size="14" /></button>
        </div>
        <pre class="mono">{{ contentArg }}</pre>
      </div>

      <div v-if="output" class="sec">
        <div class="sbar">
          <p class="slabel">{{ card.isError ? '错误输出' : '输出' }}</p>
          <button class="mini" aria-label="复制结果" title="复制结果" @click.stop="copy(output)"><CoomiIcon :name="copied ? 'check' : 'copy'" :size="14" /></button>
        </div>
        <pre class="mono out" :class="{ err: card.isError, clip: long && !full, full: long && full }">{{ output }}</pre>
        <div class="out-actions">
          <button v-if="long" class="more" @click.stop="full = !full">
            {{ full ? '收起' : '展开全部' }}
          </button>
          <button v-if="card.resultTruncated" class="more" @click.stop="openFullOutput">
            查看完整输出
          </button>
        </div>
      </div>
          </div>
        </section>
      </div>
      </Transition>
    </Teleport>

    <!-- 超长工具输出的全文查看：实时事件只带 64KB，全文从会话接口按需拉取 -->
    <Teleport to="body">
      <div v-if="fullOpen" class="out-mask">
        <header class="out-head">
          <span>工具输出</span>
          <button class="out-close" @click="closeFullOutput">关闭</button>
        </header>
        <pre class="out-full">{{ fullLoading ? '正在读取完整输出…' : (fullError || fullOutput) }}</pre>
      </div>
    </Teleport>

    <!-- 全屏图片预览：点击放大 / 另存为 -->
    <Teleport to="body">
      <div v-if="previewSrc" class="iv-mask enter-flat">
        <div
          ref="previewStage"
          class="iv-stage"
          @pointerdown="onPreviewPointerDown"
          @pointermove="onPreviewPointerMove"
          @pointerup="onPreviewPointerEnd"
          @pointercancel="onPreviewPointerEnd"
          @dblclick.prevent="togglePreviewZoom"
        >
          <img ref="previewImage" :src="previewSrc" class="iv-img" :style="previewTransform" decoding="async" draggable="false" />
        </div>
        <div class="iv-bar">
          <button class="iv-btn primary" @click.stop="savePreview">另存为</button>
          <button class="iv-btn" @click.stop="closePreview">关闭</button>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.tool {
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); overflow: hidden;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.tool.run { border-color: var(--blue-border); }
.tool.err { border-color: var(--danger-border); }
.tool.wait { border-color: var(--orange-border); background: var(--orange-soft); }

/* 运行中的提示统一由头部的 AgentState 点阵负责（按工具类型分 reading / writing /
   searching / running）。原来这里还有一条左侧呼吸光带（glow）——同一种「在跑」
   在一个 46px 高的卡片里出现两次只会互相抢注意力，已删，语义并入点阵。 */

.head {
  display: flex; align-items: center; gap: 10px;
  width: 100%; min-height: 48px; padding: var(--sp-2) var(--sp-3);
  border: 0; background: none; text-align: left;
}
.head.tapable:active { background: var(--fill); }

.tile {
  position: relative; display: grid; place-items: center; flex-shrink: 0;
  width: 32px; height: 32px; border-radius: var(--r-sm);
  background: var(--fill-strong); color: var(--text-2);
}
.tile.run { background: var(--blue-soft); color: var(--blue); }
.tile.ok { background: var(--ok-soft); color: var(--ok); }
.tile.err { background: var(--danger-soft); color: var(--danger); }
.tile.wait { background: var(--bg); color: var(--orange); }
.tile.cancelled { background: var(--fill-strong); color: var(--text-3); }
.txt { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.verb { font-size: var(--fs-body); font-weight: 600; color: var(--text); letter-spacing: -0.005em; }
.target {
  font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.st {
  display: inline-flex; align-items: center; gap: var(--sp-1); flex-shrink: 0;
  font-size: var(--fs-caption); font-weight: 600; color: var(--text-3);
}
.st-state { flex: none; margin-right: 1px; }
.st.run { color: var(--blue); }
.st.ok { color: var(--ok); }
.st.err { color: var(--danger); }
.st.wait { color: var(--orange); }
.st.cancelled { color: var(--text-3); }
.ms { font-weight: 400; color: var(--text-3); }
.chev { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.chev.open { transform: rotate(90deg); }

.risk {
  display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4); border-top: 1px solid var(--orange-border);
  font-size: var(--fs-label); line-height: 1.55; color: var(--orange);
}
.risk :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.body { border-top: 1px solid var(--border); padding: var(--sp-2) var(--sp-3) var(--sp-3); }
.sec { margin-top: 9px; }
.sbar { display: flex; align-items: center; justify-content: space-between; }
.slabel { font-size: var(--fs-caption); font-weight: 600; letter-spacing: .06em; color: var(--text-3); text-transform: uppercase; }
.mini {
  padding: 3px 9px; border: 0; border-radius: var(--r-sm);
  background: none; font-size: var(--fs-caption); font-weight: 600; color: var(--blue);
}
.mini:active { background: var(--blue-soft); }

.args { margin-top: 5px; display: flex; flex-direction: column; gap: var(--sp-1); }
.arg { display: flex; gap: var(--sp-2); font-size: var(--fs-label); line-height: 1.5; }
.ak { flex-shrink: 0; min-width: 68px; color: var(--text-3); }
.av {
  flex: 1; min-width: 0; font-family: var(--font-mono); font-size: var(--fs-caption);
  color: var(--code-text); word-break: break-all;
}

.mono {
  margin-top: 6px; padding: 9px 10px;
  border-radius: var(--r-sm); background: var(--code-bg);
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  overflow-x: auto;
}
.out.err { background: var(--danger-soft); color: #9b3a2c; }
/* 输出区默认限高、内部滚动；「展开全部」必须真的解除上限（以前 .out 与
   .out.clip 同为 240px，按钮点了等于没点）。 */
.out { max-height: 40vh; overflow: auto; overscroll-behavior: contain; }
.out.clip { max-height: 240px; }
.out.full { max-height: none; overflow: visible; }
.out-actions { display: flex; gap: 6px; margin-top: 6px; }
.more {
  flex: 1; width: 100%; padding: 7px 0;
  border: 0; border-radius: var(--r-sm); background: var(--fill);
  font-size: var(--fs-label); font-weight: 600; color: var(--text-2);
}
.more:active { background: var(--fill-press); }

/* ── 超长输出全文 ── */
.out-mask {
  position: fixed; inset: 0; z-index: 210;
  display: flex; flex-direction: column;
  padding: calc(var(--safe-top, 0px) + var(--sp-3)) var(--sp-3) calc(var(--safe-bottom, 0px) + var(--sp-3));
  background: var(--bg);
}
.out-head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  padding-bottom: var(--sp-2); font-size: var(--fs-strong); font-weight: 600; color: var(--text);
}
.out-close {
  min-height: 32px; padding: 0 var(--sp-3); border: 1px solid var(--border);
  border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
  font-size: var(--fs-label);
}
.out-full {
  flex: 1; min-height: 0; margin: 0; overflow: auto; overscroll-behavior: contain;
  padding: var(--sp-3); border-radius: var(--r-card); background: var(--code-bg);
  color: var(--code-text); font-family: var(--font-mono); font-size: var(--fs-caption);
  line-height: 1.65; white-space: pre-wrap; word-break: break-word;
}

.diff {
  margin-top: 6px; border-radius: var(--r-sm);
  background: var(--code-bg); overflow: hidden;
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.62;
}
.dl { display: flex; gap: 6px; padding: 0 var(--sp-2); }
.dl.del { background: #fdecea; color: #99392c; }
.dl.add { background: #e9f7ef; color: #1c7a52; }
/* 暗色下不能继续用浅色 diff 底：会是一条刺眼的白色块。
   改成「语义色 + 代码底」的深色混合，前景也换成同色系高亮。 */
:root[data-theme='dark'] .dl.del { background: color-mix(in srgb, var(--danger) 24%, var(--code-bg)); color: #ffb3a7; }
:root[data-theme='dark'] .dl.add { background: color-mix(in srgb, var(--ok) 22%, var(--code-bg)); color: #8fe3b6; }
:root[data-theme='dark'] .out.err { background: color-mix(in srgb, var(--danger) 20%, var(--code-bg)); color: #ffb3a7; }
.dsign { flex-shrink: 0; opacity: .55; }
.dtext { flex: 1; white-space: pre-wrap; word-break: break-word; }

/* ── 图片瀑布流（卡片内缩略图网格）── */
.inline-thumbs {
  display: flex; align-items: center; gap: 6px;
  padding: 0 11px 9px 44px;
}
.inline-thumbs img {
  width: 54px; height: 54px; object-fit: cover;
  border-radius: var(--r-sm); border: 1px solid var(--border);
  background: var(--fill);
}
.thumb-more {
  display: grid; place-items: center;
  width: 54px; height: 54px; border-radius: var(--r-sm);
  background: var(--fill); color: var(--text-3);
  font-size: var(--fs-caption); font-weight: 600;
}

/* ── 工具详情 sheet：脱离消息流，不再挤压时间线 ── */
.tool-sheet-mask {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .42);
}
.tool-sheet {
  width: 100%; max-width: 620px; max-height: 86vh;
  display: flex; flex-direction: column;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); box-shadow: var(--shadow-sheet);
  will-change: transform;
}
.grip {
  width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-2);
  border-radius: var(--r-pill); background: var(--fill-strong); flex-shrink: 0;
}
.ts-head { display: flex; align-items: center; gap: var(--sp-2); flex-shrink: 0; padding-bottom: var(--sp-2); }
.ts-title { flex: 1; min-width: 0; display: flex; align-items: center; gap: 6px; color: var(--text); font-size: var(--fs-sub); font-weight: 600; }
.ts-target { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-3); font-family: var(--font-mono); font-size: var(--fs-caption); font-weight: 400; }
.ts-state { flex-shrink: 0; padding: 1px var(--sp-2); border-radius: var(--r-pill); font-size: var(--fs-caption); font-weight: 600; }
.ts-state.ok { background: var(--ok-soft); color: var(--ok); }
.ts-state.err { background: var(--danger-soft); color: var(--danger); }
.ts-state.wait { background: var(--orange-soft); color: var(--orange); }
.ts-state.run { background: var(--blue-soft); color: var(--blue); }
.ts-close {
  display: grid; place-items: center; width: var(--sp-8); height: var(--sp-8);
  border: 0; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
  flex-shrink: 0;
}
.tool-sheet .body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; }

/* ── 图片瀑布流（卡片内缩略图网格）── */
.imgs {
  display: flex; flex-wrap: wrap; gap: var(--sp-2); margin-top: 2px;
}
.thumb {
  width: 96px; height: 96px; object-fit: cover;
  border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--fill);
}
.thumb:active { opacity: .8; }

/* show_image：大图展示 + 底部路径 */
.imgs.showimg {
  flex-direction: column; align-items: stretch;
}
.thumb.showimg {
  width: 100%; max-width: 340px; height: auto; max-height: 340px;
  object-fit: contain; margin-inline: auto;
}
.ipath {
  margin-top: 6px; font-family: var(--font-mono); font-size: var(--fs-caption);
  color: var(--text-3); word-break: break-all;
}
.inone {
  margin-top: var(--sp-1); font-size: var(--fs-label); color: var(--text-3);
}

/* ── 全屏图片预览 ── */
.iv-mask {
  position: fixed; inset: 0; z-index: 200;
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: rgba(4, 6, 10, .92);
  padding: 18px 14px calc(var(--safe-bottom, 0px) + 18px);
}
.iv-stage {
  position: relative; flex: 1; align-self: stretch; min-height: 0;
  display: grid; place-items: center; overflow: hidden;
  touch-action: none; user-select: none;
}
.iv-img {
  max-width: 100%; max-height: 100%; object-fit: contain;
  transform-origin: center; will-change: transform;
}
.iv-bar {
  display: flex; align-items: center; gap: 10px; margin-top: 14px;
}
.iv-btn {
  min-width: 84px; min-height: 38px; padding: 0 var(--sp-4); border-radius: var(--r-pill);
  background: rgba(255, 255, 255, .12); color: #fff;
  font-size: var(--fs-sub); font-weight: 600;
}
.iv-btn:active { background: rgba(255, 255, 255, .2); }
.iv-btn.primary { background: var(--blue); }
</style>

<style scoped>
/* 弹层进出：遮罩淡入淡出，卡片上滑/下滑，配 spring 曲线，220~260ms。 */
.sheet-pop-enter-active { transition: opacity 200ms var(--ease-out); }
.sheet-pop-leave-active { transition: opacity 160ms var(--ease-in); }
.sheet-pop-enter-from, .sheet-pop-leave-to { opacity: 0; }
.sheet-pop-enter-active .tool-sheet { transition: transform 260ms cubic-bezier(.22,.68,.19,1); }
.sheet-pop-leave-active .tool-sheet { transition: transform 180ms var(--ease-in); }
.sheet-pop-enter-from .tool-sheet, .sheet-pop-leave-to .tool-sheet { transform: translateY(28px); }
@media (prefers-reduced-motion: reduce) {
  .sheet-pop-enter-active, .sheet-pop-leave-active,
  .sheet-pop-enter-active .tool-sheet, .sheet-pop-leave-active .tool-sheet { transition: none; }
}
</style>
