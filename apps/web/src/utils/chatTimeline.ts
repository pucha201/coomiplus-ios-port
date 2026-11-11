import type { AssistantMessage, ReasoningBlock, Timelineitem, ToolCard } from '@/stores/viewModel'

export const MAX_TRANSCRIPT_ITEMS = 400

/** 轮过程块里的一段：一次思考 / 一组连续工具 / 一段叙述正文。
 *  顺序即事件顺序（思考 → 工具 → 继续思考 → …），渲染层不重排。
 *  对标桌面端 lib/chat.ts 的 ProcessMember，数据源换成手机端的扁平时间线条目。 */
export type TurnStage =
  | { s: 'reasoning'; item: ReasoningBlock }
  | { s: 'tools'; cards: ToolCard[] }
  | { s: 'text'; item: AssistantMessage }

export type TimelineBlockItem =
  | { t: 'one'; key: string; item: Timelineitem }
  | { t: 'tools'; key: string; cards: ToolCard[] }
  | { t: 'turn'; key: string; stages: TurnStage[]; answer: AssistantMessage | null }

function itemId(item: Timelineitem): string {
  return 'id' in item ? item.id : item.callId
}

/** 这一项是否属于「一轮过程」：思考、工具与助手正文按事件先后聚成一轮。 */
function isProcessItem(item: Timelineitem): boolean {
  return item.kind === 'reasoning' || item.kind === 'tool' || item.kind === 'assistant'
}

export function buildTimelineBlocks(items: readonly Timelineitem[]): TimelineBlockItem[] {  const blocks: TimelineBlockItem[] = []
  let run: Timelineitem[] = []

  const flush = () => {
    if (!run.length) { run = []; return }
    const first = run[0]
    const stages: TurnStage[] = []
    for (const item of run) {
      if (item.kind === 'tool') {
        const lastStage = stages[stages.length - 1]
        if (lastStage && lastStage.s === 'tools') lastStage.cards.push(item)
        else stages.push({ s: 'tools', cards: [item] })
      } else if (item.kind === 'reasoning') {
        stages.push({ s: 'reasoning', item })
      } else if (item.kind === 'assistant') {
        stages.push({ s: 'text', item })
      }
    }
    /* 过程/正文分离（照搬桌面 splitProcessAnswer）：最后一段正文 = 答案，
       它之前的一切（思考 / 叙述 / 工具）都是过程；答案独立在后、永不参与折叠。
       只按 kind 判定、不读 content —— blocks 是 computed，读了内容每个流式
       chunk 都会触发整表重组（红线：流式 O(1)）。空正文段由渲染端跳过。 */
    /* 答案 = 最后一个 text 段（不要求它排在最后）：思考可能在正文之后继续吐
       （思考 → 正文 → 继续思考），按「最后一段」取会把正文打进过程、思考垫底。
       桌面端 reasoning 是独立字段不参与段序；取「最后一个正文段」与其语义一致。 */
    let answer: AssistantMessage | null = null
    let answerIndex = -1
    for (let i = stages.length - 1; i >= 0; i--) {
      const stage = stages[i]
      if (stage.s === 'text') { answer = stage.item; answerIndex = i; break }
    }
    const members = answerIndex >= 0 ? stages.filter((_, i) => i !== answerIndex) : stages.slice()
    const hasProcess = members.some(stage => stage.s !== 'text')
    if (!hasProcess) {
      /* 没有思考也没有工具：保持旧画法（正文气泡直排），不给普通对话套折叠壳。 */
      for (const stage of stages) {
        if (stage.s === 'tools') {
          blocks.push({ t: 'tools', key: 'g:' + stage.cards[0].callId, cards: stage.cards })
        } else {
          blocks.push({ t: 'one', key: stage.item.kind + ':' + itemId(stage.item), item: stage.item })
        }
      }
    } else {
      blocks.push({ t: 'turn', key: 'turn:' + first.kind + ':' + itemId(first), stages: members, answer })
    }
    run = []
  }

  for (const item of items) {
    if (isProcessItem(item)) { run.push(item); continue }
    flush()
    blocks.push({ t: 'one', key: item.kind + ':' + itemId(item), item })
  }
  flush()
  return blocks
}

function sameCards(left: ToolCard[], right: ToolCard[]): boolean {
  if (left.length !== right.length) return false
  for (let i = 0; i < left.length; i += 1) if (left[i] !== right[i]) return false
  return true
}

function sameBlock(left: TimelineBlockItem, right: TimelineBlockItem): boolean {
  if (left.t !== right.t || left.key !== right.key) return false
  if (left.t === 'one') return right.t === 'one' && left.item === right.item
  if (left.t === 'tools') return right.t === 'tools' && sameCards(left.cards, right.cards)
  if (right.t !== 'turn') return false
  if (left.answer !== right.answer || left.stages.length !== right.stages.length) return false
  for (let i = 0; i < left.stages.length; i += 1) {
    const a = left.stages[i]
    const b = right.stages[i]
    if (a.s !== b.s) return false
    if (a.s === 'tools') {
      if (b.s !== 'tools' || !sameCards(a.cards, b.cards)) return false
    } else if (b.s === 'tools' || a.item !== b.item) return false
  }
  return true
}

/**
 * 流式期间 blocks 会随每个 chunk 重算；历史块内容没变，但对象是新的，
 * 整条时间线（生成时是整段普通 DOM）会跟着重渲染。这里按 key 复用旧块：
 * 上一轮/上一条消息的 block 引用不变，Vue 就会跳过它们的子树，
 * 只更新正在长的那一块 —— 工具卡与自动贴底不再被历史重渲染拖顿。
 */
export function reuseTimelineBlocks(
  previous: readonly TimelineBlockItem[],
  next: TimelineBlockItem[],
): TimelineBlockItem[] {
  if (previous.length === 0) return next
  const old = new Map(previous.map(block => [block.key, block]))
  let reused = false
  const out = next.map(block => {
    const candidate = old.get(block.key)
    if (candidate && sameBlock(candidate, block)) { reused = true; return candidate }
    return block
  })
  return reused ? out : next
}

export function transcriptTail(
  items: readonly Timelineitem[],
  limit = MAX_TRANSCRIPT_ITEMS,
): Timelineitem[] {
  if (!Number.isInteger(limit) || limit <= 0) return []
  return items.slice(-limit)
}

export function parseTranscript(raw: string | null): Timelineitem[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed as Timelineitem[] : []
  } catch {
    return []
  }
}


/** 按消息 id 找块序号。索引会随流式重组变化，转盘/搜索保存的 blockIndex 只能当兜底。 */
export function blockIndexOfMessage(
  blocks: readonly TimelineBlockItem[],
  messageId: string,
): number {
  if (!messageId) return -1
  return blocks.findIndex(block =>
    block.t === 'one'
    && (block.item.kind === 'user' || block.item.kind === 'assistant')
    && block.item.id === messageId)
}
