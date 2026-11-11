<script setup lang="ts">
/**
 * 消息气泡。
 *
 * 正文渲染口径（照搬电脑端 desktop-ui-react/src/components/chat/streamText.ts）：
 *   · **流式中一律纯文本** —— 不解析 markdown、不高亮、不扫描分块；
 *   · 落定（streaming 变 false 且逐字追平）才整段按段落解析一次 markdown。
 *
 * 「不整段闪现」落在 useStreamReveal 上：正文按**内容长度差**用 rAF 推进，
 * 批量到达 / 单次整段到达都走同一条路径（差得少就逐字、积压越多越快，但一帧只出几字）。
 * 落定那一刻同时做三件事：正文切 markdown、过程栏收起、末尾点阵收束 ——
 * 同一个信号驱动，不会互相抢帧。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { AssistantMessage, UserMessage } from '@/stores/viewModel'
import { useSessionStore } from '@/stores/session'
import FileChangeSummary from '@/components/FileChangeSummary.vue'
import { useSessionsStore } from '@/stores/sessions'
import { clearMarkdownCache, renderMarkdown, setImageSrcResolver } from '@/utils/markdown'
import { engineToken, tokenRevision } from '@/bridge/http'
import { extractFilePaths, isImagePath, normalizeFilePath } from '@/utils/filePaths'
import { shouldUsePlainText } from '@/utils/streamReveal'
import { useStreamReveal } from '@/composables/useStreamReveal'
import CoomiIcon from './CoomiIcon.vue'
import RevealText from './RevealText.vue'
import FileInline from './FileInline.vue'
import AttachmentTile from './AttachmentTile.vue'
import MediaViewer from './MediaViewer.vue'
import AgentState, { isReasoningTail, messageTailState } from './ai/AgentState.vue'

const props = defineProps<{ msg: AssistantMessage | UserMessage; noEnter?: boolean; readonly?: boolean }>()
const session = useSessionStore()
const sessions = useSessionsStore()

/**
 * 正文图片：模型给的是本地路径（会话幕布里的 png/jpg），浏览器读不了。
 * 统一走 filePaths 的命名空间展开（guest 别名 / 相对路径 / 宿主绝对路径），
 * 再翻成引擎的只读文件端点并带上当前令牌；令牌晚到时靠 tokenRevision 重绘。
 */
setImageSrcResolver(raw => {
  const value = raw.trim()
  if (!value) return null
  if (value.startsWith('/api/fs/raw?')) return value
  if (/^https:\/\//i.test(value) || /^data:image\//i.test(value)) return value
  const roots = {
    ...sessions.enginePaths,
    workspace: session.cwd || sessions.currentCwd,
  }
  const absolute = normalizeFilePath(value, roots, session.cwd)
  if (!absolute) return null
  void tokenRevision.value
  return '/api/fs/raw?path=' + encodeURIComponent(absolute) + '&token=' + encodeURIComponent(engineToken())
})


/** 正文图片点开大图（第 9 项）：路径与窗口尺寸一起交给统一查看器。 */
const viewerSrc = ref('')
function openViewer(raw: string): void {
  const value = raw.trim()
  if (!value) return
  if (value.startsWith('/api/fs/raw?')) { viewerSrc.value = value; return }
  const roots = { ...sessions.enginePaths, workspace: session.cwd || sessions.currentCwd }
  const absolute = normalizeFilePath(value, roots, session.cwd)
  if (!absolute) return
  void tokenRevision.value
  viewerSrc.value = '/api/fs/raw?path=' + encodeURIComponent(absolute) + '&token=' + encodeURIComponent(engineToken())
}


/**
 * 逐字揭示器：流式期间唯一的内容推进源。
 * 历史消息不会被武装（没有「引擎正在追加」的证据）→ 直接整段渲染，绝不重播动画。
 */
const reveal = useStreamReveal(props.msg as AssistantMessage)

// 会话切换/恢复到自己的幕布目录后，旧缓存里的图片地址（按上一个 cwd 解析）必须作废。
watch(() => session.cwd, () => { clearMarkdownCache() })

const blocks = ref<string[]>([])
/** 各段原文（渲染路径的稳定 key：追加段落时老段落不会被重建）。 */
const rawKeys = ref<string[]>([])
const copied = ref(false)

const isUser = computed(() => props.msg.kind === 'user')
/** 超长用户消息：气泡限高 + 「查看更多」打开完整内容卡片。 */
const readerOpen = ref(false)
/** 编辑重发留下的历史版本：只有超过 1 个才显示切换。 */
const userMsg = computed(() => (props.msg.kind === 'user' ? props.msg : null))
const versionCount = computed(() => userMsg.value?.versions?.length ?? 0)
const versionIndex = computed(() => {
  const list = userMsg.value?.versions
  if (!list?.length) return 0
  const at = list.lastIndexOf(userMsg.value!.content)
  return at >= 0 ? at : list.length - 1
})
function stepVersion(delta: number) {
  const list = userMsg.value?.versions
  if (!list?.length) return
  const next = Math.max(0, Math.min(list.length - 1, versionIndex.value + delta))
  if (userMsg.value) userMsg.value.content = list[next]
}

const longUser = computed(() => isUser.value && (props.msg.content?.length ?? 0) > 600)
const isAssistant = computed(() => props.msg.kind === 'assistant')
/** 本轮改动的文件（turn_end 下发）。 */
const assistantFiles = computed(() => (props.msg.kind === 'assistant' ? (props.msg.files ?? []) : []))
const assistantActions = computed(() => (props.msg.kind === 'assistant' ? (props.msg.actions ?? []) : []))
/** 用户消息的附件列表 */
const userFiles = computed(() => {
  if (props.msg.kind !== 'user') return []
  return (props.msg as UserMessage).attachedFiles || []
})
/** 生命体主动消息（气泡/开场问候）：带生命体标记的渲染样式。 */
const isLife = computed(() => isAssistant.value && (props.msg as AssistantMessage).life === true)
/** 只有最新一条用户消息可编辑重发。 */
const isLastUser = computed(() => isUser.value && session.lastUserMessage === props.msg)
/** 只有最新一条助手消息可回撤。 */
const isLastAssistant = computed(() => isAssistant.value && session.lastAssistantMessage === props.msg)
const streaming = computed(() => props.msg.kind === 'assistant' && props.msg.streaming)
const src = computed(() => props.msg.content)

/**
 * 走纯文本还是 markdown：流式中（含逐字还没追平的落定期）一律纯文本；
 * 落定后一定解析——否则正文里的图片/表格在长回答里永远出不来。
 */
const usePlain = computed(() =>
  (isAssistant.value && (streaming.value || reveal.text.value !== null))
  || shouldUsePlainText(src.value, !!streaming.value))

/** 纯文本正文：逐字中 = 已揭示的那一截；追平后就是整段（同一节点平滑接上，不闪）。 */

const renderList = computed(() => ({ keys: rawKeys.value, html: blocks.value }))
/** 兜底：渲染结果为空但正文非空 → 整段直出（绝不留白屏）。 */
const streamFallback = computed(() => (
  !usePlain.value && !renderList.value.html.length && src.value ? src.value : ''
))

/** 按空行切块，但围栏代码块整体保留。 */
function splitBlocks(text: string): string[] {
  const out: string[] = []
  let buf: string[] = []
  let fence: string | null = null
  const flush = () => {
    const t = buf.join('\n').trim()
    if (t) out.push(t)
    buf = []
  }
  for (const line of text.split('\n')) {
    const m = /^\s*(```+|~~~+)/.exec(line)
    if (fence) {
      buf.push(line)
      if (m && line.trim().startsWith(fence)) { fence = null; flush() }
      continue
    }
    if (m) { flush(); fence = m[1]; buf.push(line); continue }
    if (line.trim() === '') { flush(); continue }
    buf.push(line)
  }
  flush()
  return out
}

function rebuild() {
  const texts = splitBlocks(src.value)
  rawKeys.value = texts
  blocks.value = texts.map(renderMarkdown)
}

/**
 * 定稿后才整段解析一次（markdown 在本文件里的唯一解析点）。
 * 流式期间 rebuild = 每帧重解析整条消息 = 卡顿与「先原文后格式」闪烁的根因，所以直接跳过。
 */
function schedule() {
  if (props.msg.kind !== 'assistant') return
  if (usePlain.value) return
  rebuild()
}

watch(src, schedule, { immediate: true })
watch(streaming, schedule)
// 逐字追平 / 落定这一刻切到 markdown：必须在渲染前同步 rebuild，否则会闪一帧纯文本。
watch(usePlain, schedule)

/**
 * 看门狗：流式期间每 250ms 自检一次「内容长度变了但没重绘」→ 强制刷新。
 * 目的：即使虚拟列表/组件缓存吞掉一次更新，也不会出现「正文不输出、切页才显示」。
 */
const watchdogTick = ref(0)
let watchdogTimer: number | undefined
let lastPaintLength = -1
watch(src, () => { lastPaintLength = src.value.length }, { immediate: true })
watch(streaming, (on) => {
  if (watchdogTimer) { window.clearInterval(watchdogTimer); watchdogTimer = undefined }
  if (!on) return
  watchdogTimer = window.setInterval(() => {
    if (lastPaintLength !== src.value.length) {
      lastPaintLength = src.value.length
      watchdogTick.value++
    }
  }, 250)
}, { immediate: true })
onBeforeUnmount(() => { if (watchdogTimer) window.clearInterval(watchdogTimer) })

const streamDebug = computed(() => {
  if (typeof location === 'undefined') return false
  return new URLSearchParams(location.search).get('streamdebug') === '1'
})

/**
 * 消息末尾「生成中」指示：正文还在流、或逐字还没落定，都留着点阵；
 * 落定那一刻才收（收束有 140ms 淡出，见 .tail-* 过渡）。
 * 推理尾巴故意留空 —— 那一帧由 TimelineBlock 在推理块旁边渲染 reasoning，
 * 两个挂点都画同一件事会变成两条点阵同时闪。
 */
const tailState = computed(() => messageTailState({
  streaming: streaming.value || reveal.revealing.value,
  reasoning: isReasoningTail(session.timeline),
}))

/** 编辑：把该消息文本回填到输入框，发送时覆盖该轮重新执行。 */
function editUserMessage() {
  const mid = (props.msg as UserMessage).mid ?? ''
  session.startEditMessage(mid, props.msg.content)
}

/** 回撤：先弹确认，清空该轮执行（含工具过程），回到这轮开始之前。 */
function undoAssistant() {
  const mid = (props.msg as AssistantMessage).mid ?? ''
  session.requestUndo(mid)
}

/**
 * 从助手文本中识别本地文件路径（供 FileInline 渲染为可点击文件卡片）。
 * 规则集中在 utils/filePaths：保留开头斜杠、支持中文名、把 guest 别名
 * （/workspace、/home/coomi、/tmp…）展开成宿主绝对路径。
 * 旧实现把开头斜杠吃掉再拼 cwd，本地模式下每张卡都指向不存在的路径。
 */
const filePaths = computed(() => {
  if (props.msg.kind !== 'assistant' || props.msg.streaming) return []
  const roots = { ...sessions.enginePaths, workspace: session.cwd || sessions.currentCwd }
  return extractFilePaths(src.value, roots, session.cwd, 8)
})

const actMeta = computed(() => {
  if (props.msg.kind !== 'assistant' || streaming.value) return ''
  const m = props.msg as { content: string; startedAt?: number; endedAt?: number; speedTps?: number | null }
  if (!m.startedAt || !m.endedAt) return ''
  const at = new Date(m.endedAt)
  const time = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  // 速率用引擎回执的 output_tokens_per_second（与顶栏同一口径），没有就显示 --
  const speed = m.speedTps == null ? '--' : `${m.speedTps.toFixed(1)} tok/s`
  return `${time} · ${speed}`
})

async function copyAll() {
  try { await navigator.clipboard.writeText(props.msg.content) } catch { /* 剪贴板不可用就算了 */ }
  copied.value = true
  setTimeout(() => { copied.value = false }, 1400)
}

/** 表格卡片上的「复制 / 查看」：事件代理，v-html 里的按钮不用逐个绑。 */
const tableView = ref('')
function onMdClick(event: MouseEvent) {
  const target = event.target as HTMLElement | null
  // 正文图片：点开统一大图查看器（缩放 / 下滑关闭 / 另存）。
  const image = target?.closest?.('.md img') as HTMLImageElement | null
  if (image) {
    openViewer(image.getAttribute('src') || '')
    return
  }
  const button = target?.closest?.('[data-md-table]') as HTMLElement | null
  if (!button) return
  const table = button.closest('.md-table')?.querySelector('table')
  if (!table) return
  if (button.dataset.mdTable === 'copy') {
    const text = Array.from(table.querySelectorAll('tr'))
      .map(row => Array.from(row.querySelectorAll('th,td')).map(cell => (cell.textContent ?? '').trim()).join('\t'))
      .join('\n')
    void navigator.clipboard?.writeText(text)
    const icon = button.innerHTML
    button.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 12.5l5 5L20 6.5"/></svg>'
    button.classList.add('done')
    setTimeout(() => { button.innerHTML = icon; button.classList.remove('done') }, 1200)
    return
  }
  tableView.value = table.outerHTML
}
</script>

<template>
  <div v-if="isUser" class="row user">
    <div class="wrap user-wrap">
      <div v-if="userFiles.length" class="msg-files">
        <AttachmentTile
          v-for="f in userFiles"
          :key="f.path + f.name"
          :file="f"
          :interactive="isImagePath(f.name)"
          @open="openViewer"
        />
      </div>
      <div class="bubble" :class="{ cascade: !noEnter, clamp: longUser }">{{ msg.content }}</div>
      <!-- 编辑重发后才会出现：在历史版本之间前后切换 -->
      <div v-if="versionCount > 1" class="versions" role="group" :aria-label="`历史版本 ${versionIndex + 1} / ${versionCount}`">
        <button type="button" aria-label="上一版" :disabled="versionIndex === 0" @click="stepVersion(-1)">
          <CoomiIcon name="chevronLeft" :size="13" />
        </button>
        <span class="versions-label">{{ versionIndex + 1 }} / {{ versionCount }}</span>
        <button type="button" aria-label="下一版" :disabled="versionIndex >= versionCount - 1" @click="stepVersion(1)">
          <CoomiIcon name="chevronRight" :size="13" />
        </button>
      </div>
      <button v-if="longUser" class="read-more" @click="readerOpen = true">查看更多</button>
      <Teleport to="body">
        <Transition name="sheet-pop">
          <div v-if="readerOpen" class="reader-mask" @click.self="readerOpen = false">
            <section class="reader" role="dialog" aria-modal="true" aria-label="完整消息">
              <header class="reader-head"><span>完整内容</span><button aria-label="关闭" @click="readerOpen = false">×</button></header>
              <div class="reader-body">{{ msg.content }}</div>
            </section>
          </div>
        </Transition>
      </Teleport>
      <div class="acts user-acts">
        <button class="act" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="copyAll">
          <CoomiIcon :name="copied ? 'check' : 'copy'" :size="16" />
        </button>
        <button v-if="isLastUser && !readonly" class="act" aria-label="编辑" title="编辑" @click="editUserMessage">
          <CoomiIcon name="pencil" :size="16" />
        </button>
      </div>
    </div>
  </div>

  <div
    v-else
    class="assistant"
    :class="{ life: isLife }"
    :data-len="src.length"
    :data-tick="watchdogTick"
    @click="onMdClick"
  >
    <span v-if="streamDebug" class="stream-debug">L{{ src.length }}·P{{ watchdogTick }}</span>
    <div v-if="isLife" class="life-tag"><CoomiIcon name="lifeRings" :size="12" /><span>生命体</span></div>
    <!-- 生成中：纯文本逐字（不解析 markdown、不高亮）—— 这是「字平滑出现」的唯一路径。
         落定后同一位置自动换成正式 markdown 渲染（见 usePlain / schedule）。 -->
    <div v-if="usePlain" class="md blk tail">
      <RevealText :text="src" :head="reveal.head.value" />
    </div>
    <template v-else>
      <div
        v-for="(h, i) in renderList.html"
        :key="renderList.keys[i] || i"
        class="md blk"
        v-html="h"
      />
      <div v-if="streamFallback" class="md blk tail">{{ streamFallback }}</div>
    </template>
    <FileInline v-if="filePaths.length" :paths="filePaths" />
    <!-- 一轮改动的文件汇总：只在结束后出现，和 dsh-go 的底部框一致 -->
    <FileChangeSummary
      v-if="!streaming && assistantFiles.length"
      :files="assistantFiles"
      :actions="assistantActions"
    />
    <!-- 消息末尾的「生成中」点阵：落定时淡出收起，不抢折叠栏的过渡。 -->
    <Transition name="tail">
      <AgentState v-if="tailState" :state="tailState" size="xs" tone="primary" class="tail-state" />
    </Transition>
    <Transition name="acts">
      <div v-if="!streaming && !reveal.revealing.value" class="acts" :class="{ 'acts-last': isLastAssistant }">
      <button class="act" :aria-label="copied ? '已复制' : '复制'" :title="copied ? '已复制' : '复制'" @click="copyAll">
        <CoomiIcon :name="copied ? 'check' : 'copy'" :size="16" />
      </button>
      <button v-if="isLastAssistant && !readonly" class="act" aria-label="回撤" title="回撤" @click="undoAssistant">
        <CoomiIcon name="arrowLeft" :size="16" />
      </button>
      <span v-if="actMeta" class="act-meta">{{ actMeta }}</span>
      </div>
    </Transition>
  </div>

  <!-- 表格全屏查看：只读放大，点背景或关闭退出。 -->
  <MediaViewer v-if="viewerSrc" :src="viewerSrc" @close="viewerSrc = ''" />
  <Teleport to="body">
    <div v-if="tableView" class="md-table-full" @click.self="tableView = ''">
      <div class="md-table-full-card">
        <div class="md-table-full-bar">
          <span>表格</span>
          <button type="button" class="md-table-btn" @click="tableView = ''">关闭</button>
        </div>
        <div class="md-table-full-body" v-html="tableView" />
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.row { display: flex; }
.row.user { justify-content: flex-end; }
.bubble {
  max-width: 100%;
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-card) var(--r-card) var(--r-sm) var(--r-card);
  background: var(--user-bubble); color: #fff; /* 亮=--blue；暗色为深一档蓝（白字 4.79:1） */
  font-size: var(--fs-body-lg); line-height: 1.6; font-weight: 400; word-break: break-word;
  white-space: pre-wrap; text-align: left;
  /* 入场动画已按反馈整体移除：重建 DOM 时重播是「界面闪」的根源（气泡/段落都不再播）。 */
}
.assistant { max-width: 100%; color: var(--text); }
/* 末尾点阵独立成行：紧跟在最后一段下面，不挤压正文的行距 */
.tail-state { display: inline-block; margin-top: 6px; height: 0; overflow: hidden; }
.blk + .blk { margin-top: 10px; }
/* 段落不再播入场动画（同上）。 */
.blk { animation: none; }
/* 纯文本正文（流式中 / 逐字中 / 超长正文）：保留换行与缩进，逐字追加不重排、不动画。 */
.blk.tail { animation: none; white-space: pre-wrap; word-break: break-word; }
.mb-tail-trim, .md :last-child { margin-bottom: 0; }
/* F4 取证标记（仅 ?streamdebug=1 显示） */
.stream-debug {
  display: inline-block; margin: 0 0 var(--sp-1);
  padding: 1px 6px; border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-3);
  font-family: var(--font-mono); font-size: var(--fs-caption);
}
/* 末尾点阵的收束：生成结束时淡出（与折叠栏的收起过渡同窗口，不是硬消失）。 */
.tail-enter-active, .tail-leave-active { transition: opacity var(--dur-fast) var(--ease-out); }
.tail-enter-from, .tail-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) { .tail-enter-active, .tail-leave-active { transition: none; } }

/* 生命体主动消息：左侧渐变边条 + 柔和底色，弱化“这是一条系统消息”的距离感。 */
.assistant.life { padding: 2px 0 var(--sp-1); }
.assistant.life .life-tag {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  margin: 0 0 6px; padding: 3px 9px 3px 7px;
  border-radius: var(--r-pill);
  background: color-mix(in srgb, var(--accent-soft) 70%, var(--bg));
  color: var(--accent); font-size: var(--fs-caption); font-weight: 600;
}
.assistant.life .blk {
  padding: 10px 13px;
  border-left: 3px solid color-mix(in srgb, var(--accent) 55%, var(--border));
  border-radius: var(--r-sm) var(--r-md) var(--r-md) var(--r-sm);
  background: color-mix(in srgb, var(--accent-soft) 30%, var(--bg));
}
.assistant.life .blk + .blk { margin-top: var(--sp-2); }

.user-wrap { display: flex; flex-direction: column; align-items: flex-end; max-width: 84%; }
/* 历史版本切换：编辑重发后才会出现 */
.versions {
  display: flex; align-items: center; gap: var(--sp-1); margin-top: 6px;
  font-size: var(--fs-caption); color: var(--text-3);
}
.versions button {
  display: grid; place-items: center; width: 22px; height: 22px;
  border-radius: var(--r-sm); background: var(--fill); color: var(--text-2);
}
.versions button:disabled { opacity: .35; }
.versions-label { font-variant-numeric: tabular-nums; }
/* 附件行：**单行横向滚动** + 方块瓦片。
   旧实现 flex-wrap:wrap，文件一多就一行行往下堆，把用户气泡越顶越高。 */
.msg-files {
  display: flex; flex-wrap: nowrap; align-items: flex-start;
  gap: 10px; margin-bottom: 6px;
  max-width: 100%;
  overflow-x: auto; overflow-y: hidden;
  padding: 2px 0 var(--sp-1);
  scroll-snap-type: x proximity;
  scrollbar-width: none;
  -webkit-overflow-scrolling: touch;
}
.msg-files::-webkit-scrollbar { display: none; }
.msg-files > * { scroll-snap-align: start; }
.user-acts { justify-content: flex-end; }
.acts { display: flex; align-items: center; gap: 2px; margin-top: var(--sp-2); }
.acts .act { width: 30px; height: 30px; display: grid; place-items: center; }
.bubble.clamp { max-height: 320px; overflow: hidden; -webkit-mask-image: linear-gradient(180deg, #000 78%, transparent 100%); mask-image: linear-gradient(180deg, #000 78%, transparent 100%); }
.read-more { align-self: flex-start; margin-top: var(--sp-1); min-height: 26px; padding: 0 10px; border: 1px solid var(--border); border-radius: var(--r-pill); background: var(--bg); color: var(--blue); font-size: var(--fs-caption); font-weight: 600; }
.reader-mask { position: fixed; inset: 0; z-index: var(--z-sheet); display: flex; align-items: flex-end; justify-content: center; padding: var(--sp-2); background: rgba(0,0,0,.44); }
.reader { width: 100%; max-width: 620px; max-height: 86vh; display: flex; flex-direction: column; padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom)); border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.reader-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); padding-bottom: var(--sp-2); font-size: var(--fs-sub); font-weight: 600; }
.reader-head button { display: grid; place-items: center; width: 28px; aspect-ratio: 1; border: 0; border-radius: 50%; background: var(--fill); color: var(--text-2); font-size: var(--fs-body); }
.reader-body { flex: 1; min-height: 0; overflow-y: auto; overscroll-behavior: contain; white-space: pre-wrap; word-break: break-word; font-size: var(--fs-body); line-height: var(--lh-body); color: var(--text); }
.act-meta { margin-left: auto; padding-left: var(--sp-2); font-size: var(--fs-caption); color: var(--text-3); white-space: nowrap; }
/* 末条消息的操作行要给右下角的「最新」圆钮让位，否则 tok/s 被压在按钮下面。 */
.acts-last { padding-right: var(--sp-9); }
.act {
  display: inline-flex; align-items: center; gap: 5px; min-height: 30px; padding: 0 10px;
  border: 0; border-radius: var(--r-pill); background: none;
  font-size: var(--fs-label); color: var(--text-2); /* 动作是功能入口：提为二级墨色 */
}
.act:active { background: var(--fill); color: var(--blue); }

/* 复制/回撤：输出完才出现，渐入 240ms（上移 4px） */
.acts-enter-active, .acts-leave-active { transition: opacity 240ms var(--ease-out), transform 240ms var(--ease-out); }
.acts-enter-from, .acts-leave-to { opacity: 0; transform: translateY(4px); }
</style>
