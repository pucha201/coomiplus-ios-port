import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import {
  MAX_TRANSCRIPT_ITEMS,
  blockIndexOfMessage,
  buildTimelineBlocks,
  parseTranscript,
  reuseTimelineBlocks,
  transcriptTail,
} from '../src/utils/chatTimeline.ts'
import type { Timelineitem, ToolCard } from '../src/stores/viewModel.ts'

function tool(callId: string, images?: string[]): ToolCard {
  return {
    kind: 'tool',
    callId,
    toolName: 'show_image',
    arguments: { path: `/tmp/${callId}.png` },
    status: 'success',
    images,
  }
}

function turnOf(block: unknown) {
  assert.equal((block as { t?: string }).t, 'turn')
  return block as Extract<import('../src/utils/chatTimeline.ts').TimelineBlockItem, { t: 'turn' }>
}

test('folds reasoning / tools / answer of one turn into a single process block', () => {
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u1', content: 'go' },
    { kind: 'reasoning', id: 'r1', content: '想想', expanded: false },
    tool('t1'),
    tool('t2'),
    { kind: 'reasoning', id: 'r2', content: '再想想', expanded: false },
    { kind: 'assistant', id: 'a1', content: '答案', streaming: false },
  ]

  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u1', 'turn:reasoning:r1'])
  const turn = turnOf(blocks[1])
  // 分阶段：思考 → 工具 → 继续思考，顺序即事件顺序。
  assert.deepEqual(turn.stages.map(stage => stage.s), ['reasoning', 'tools', 'reasoning'])
  assert.equal(turn.stages[1].s === 'tools' ? turn.stages[1].cards.map(c => c.callId).join(',') : '', 't1,t2')
  // 正文/过程分离：最后一段正文是答案，独立在过程块之后。
  assert.equal(turn.answer?.id, 'a1')
  assert.equal(turn.answer?.content, '答案')
})

test('trailing reasoning no longer swallows the answer (reported bug)', () => {
  // 思考 → 正文 → 继续思考：正文必须是答案，不能被打进过程、思考垫底。
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u1', content: 'go' },
    { kind: 'reasoning', id: 'r1', content: '前段思考', expanded: false },
    { kind: 'assistant', id: 'a1', content: '这是答案', streaming: false },
    { kind: 'reasoning', id: 'r2', content: '后段思考', expanded: false },
  ]
  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u1', 'turn:reasoning:r1'])
  const turn = turnOf(blocks[1])
  assert.deepEqual(turn.stages.map(stage => stage.s), ['reasoning', 'reasoning'])
  assert.equal(turn.answer?.content, '这是答案')
})

test('a turn with tools still running keeps tools in the process', () => {
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u1', content: 'start' },
    tool('t1'),
    tool('t2'),
    tool('t3'),
  ]
  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u1', 'turn:tool:t1'])
  const turn = turnOf(blocks[1])
  assert.deepEqual(turn.stages.map(stage => stage.s), ['tools'])
  assert.equal(turn.answer, null)
})

test('plain assistant replies keep the legacy bubble blocks', () => {
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u0', content: 'hi' },
    { kind: 'assistant', id: 'a0', content: '一', streaming: false },
    { kind: 'user', id: 'u1', content: 'again' },
    { kind: 'assistant', id: 'a1', content: '二', streaming: false },
  ]
  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u0', 'assistant:a0', 'user:u1', 'assistant:a1'])
  assert.ok(blocks.every(block => block.t === 'one'))
})

test('notices and question cards break the process run', () => {
  const items: Timelineitem[] = [
    { kind: 'user', id: 'u1', content: 'go' },
    { kind: 'reasoning', id: 'r1', content: '前半', expanded: false },
    { kind: 'notice', id: 'n1', tone: 'error', text: '上游断了' },
    { kind: 'reasoning', id: 'r2', content: '后半', expanded: false },
    { kind: 'assistant', id: 'a1', content: '好了', streaming: false },
  ]
  const blocks = buildTimelineBlocks(items)
  assert.deepEqual(blocks.map(block => block.key), ['user:u1', 'turn:reasoning:r1', 'notice:n1', 'turn:reasoning:r2'])
  const first = turnOf(blocks[1])
  const second = turnOf(blocks[3])
  assert.equal(first.answer, null)
  assert.equal(first.stages.length, 1)
  assert.equal(second.answer?.id, 'a1')
})

test('builds a 5,000-item variable-height timeline without truncating content', () => {
  const longMarkdown = `${'# Long response\n\n'}${'| cell | value |\n|---|---|\n'.repeat(2_000)}END_MARKER`
  const image = 'data:image/png;base64,iVBORw0KGgo='
  const items: Timelineitem[] = Array.from({ length: 4_997 }, (_, index) => index % 2 === 0
    ? { kind: 'user', id: `m${index}`, content: `message ${index}` }
    : { kind: 'assistant', id: `m${index}`, content: `message ${index}`, streaming: false })
  items.push({ kind: 'assistant', id: 'long', content: longMarkdown, streaming: false })
  items.push(tool('image-1', [image]))
  items.push(tool('image-2', [image]))

  const blocks = buildTimelineBlocks(items)
  assert.equal(items.length, 5_000)
  // 旧模型 4999（工具各成一块）；turn 模型把末轮收编成一块 = 4998。
  assert.equal(blocks.length, 4_998)
  // 末轮：长正文是最后一个 text 段 = 答案（独立在后），工具折进过程，图片一张不丢。
  const finalBlock = blocks.at(-1)
  const turn = turnOf(finalBlock)
  assert.deepEqual(turn.stages.map(stage => stage.s), ['tools'])
  assert.equal(turn.answer?.content, longMarkdown)
  assert.deepEqual(
    turn.stages.flatMap(stage => (stage.s === 'tools' ? stage.cards.flatMap(card => card.images ?? []) : [])),
    [image, image],
  )
})

test('session fallback persistence keeps the newest bounded transcript intact', () => {
  const items: Timelineitem[] = Array.from({ length: 1_200 }, (_, index) => ({
    kind: 'assistant',
    id: `a${index}`,
    content: index === 1_199 ? `${'large markdown\n'.repeat(3_000)}LAST` : `message ${index}`,
    streaming: false,
  }))

  const tail = transcriptTail(items)
  assert.equal(tail.length, MAX_TRANSCRIPT_ITEMS)
  assert.equal('id' in tail[0] ? tail[0].id : '', 'a800')
  const last = tail.at(-1)
  assert.match(last?.kind === 'assistant' ? last.content : '', /LAST$/)
  assert.deepEqual(parseTranscript(JSON.stringify(tail)), tail)
  assert.deepEqual(parseTranscript('{broken'), [])
  assert.deepEqual(transcriptTail(items, 0), [])
})

test('streaming reuses unchanged blocks so history is not re-rendered per chunk', () => {
  const user: Timelineitem = { kind: 'user', id: 'u1', content: 'hi' }
  const answer: Timelineitem = { kind: 'assistant', id: 'a1', content: '第一段', streaming: true }
  const first = buildTimelineBlocks([user, answer])

  // 每个 chunk 都会重建 blocks：引用没变的历史块必须原样复用。
  const same = reuseTimelineBlocks(first, buildTimelineBlocks([user, answer]))
  assert.equal(same[0], first[0])
  assert.equal(same[1], first[1])

  // 内容对象被替换的那一块才是新块，历史仍然复用。
  const longer: Timelineitem = { ...answer, content: '第一段更长了' }
  const next = reuseTimelineBlocks(same, buildTimelineBlocks([user, longer]))
  assert.equal(next[0], first[0])
  assert.notEqual(next[1], first[1])
  assert.equal(next[1].t === 'one' ? next[1].item : null, longer)
})

test('tool groups keep identity only while their card references are unchanged', () => {
  const user: Timelineitem = { kind: 'user', id: 'u1', content: 'go' }
  const t1 = tool('t1')
  const t2 = tool('t2')
  const first = buildTimelineBlocks([user, t1, t2])
  const same = reuseTimelineBlocks(first, buildTimelineBlocks([user, t1, t2]))
  assert.equal(same[1], first[1])

  // 工具状态被替换（同一个 callId、新对象）：这一块必须重建，不能拿旧引用掩盖更新。
  const renamed = { ...t1, status: 'running' as const }
  const next = reuseTimelineBlocks(same, buildTimelineBlocks([user, renamed, t2]))
  assert.notEqual(next[1], first[1])
})

test('chat templates retain dynamic measurement and lazy image contracts', async () => {
  const chat = await readFile(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
  const toolCard = await readFile(new URL('../src/components/ToolCardItem.vue', import.meta.url), 'utf8')
  const fileInline = await readFile(new URL('../src/components/FileInline.vue', import.meta.url), 'utf8')

  assert.match(chat, /<DynamicScroller\b/)
  assert.match(chat, /<DynamicScrollerItem\b/)
  assert.match(chat, /key-field="key"/)
  // 条目高度由 DynamicScrollerItem 自己的 ResizeObserver 跟踪（emit-resize），
  // 流式正文长高不需要 size-dependencies 再走一遍整表重算。
  assert.match(chat, /emit-resize/)
  assert.match(chat, /@resize="onItemResize"/)
  assert.match(chat, /ResizeObserver/)
  assert.match(toolCard, /loading="lazy"\s+decoding="async"/)
  assert.match(fileInline, /loading="lazy"\s+decoding="async"/)
})

test('jump targets resolve by message id even after blocks shift', () => {
  const first: Timelineitem = { kind: 'user', id: 'u1', mid: 'm1', content: 'one' }
  const reply: Timelineitem = { kind: 'assistant', id: 'a1', mid: 'm1', content: 'ok', streaming: false }
  const before = buildTimelineBlocks([first, reply])
  assert.equal(blockIndexOfMessage(before, 'u1'), 0)

  const reasoning: Timelineitem = { kind: 'reasoning', id: 'r1', content: 'think', expanded: false }
  const second: Timelineitem = { kind: 'user', id: 'u2', mid: 'm2', content: 'two' }
  const after = buildTimelineBlocks([first, reply, reasoning, second])
  const expected = after.findIndex(block => block.t === 'one' && block.item.kind === 'user' && block.item.id === 'u2')
  assert.ok(expected > 0)
  assert.equal(blockIndexOfMessage(after, 'u2'), expected)
  assert.equal(blockIndexOfMessage(after, 'gone'), -1)
  assert.equal(blockIndexOfMessage(after, ''), -1)
})
