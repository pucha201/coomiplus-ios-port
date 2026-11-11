import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { deferUntilTransportOpen, flushHydrationOnOpen, pendingHydrationCount, primeHydration } from '../src/utils/hydration.ts'

test('deferred hydration does not run before the transport is open', () => {
  let ran = 0
  deferUntilTransportOpen(() => { ran += 1 })

  assert.equal(ran, 0)
  assert.equal(pendingHydrationCount(), 1)
})

test('one open event runs each pending task exactly once', async () => {
  const ran: string[] = []
  deferUntilTransportOpen(() => { ran.push('sessions') })
  deferUntilTransportOpen(async () => { ran.push('providers') })

  await flushHydrationOnOpen()
  await flushHydrationOnOpen()

  assert.deepEqual(ran, ['sessions', 'providers'])
  assert.equal(pendingHydrationCount(), 0)
})

test('a failing task is retried on the next open instead of being dropped', async () => {
  let attempts = 0
  deferUntilTransportOpen(() => {
    attempts += 1
    if (attempts === 1) throw new Error('engine not ready')
  })

  await flushHydrationOnOpen()
  assert.equal(attempts, 1)
  assert.equal(pendingHydrationCount(), 1)

  await flushHydrationOnOpen()
  assert.equal(attempts, 2)
  assert.equal(pendingHydrationCount(), 0)
})

test('the same task identity is queued only once', () => {
  const task = (): void => undefined
  deferUntilTransportOpen(task)
  deferUntilTransportOpen(task)

  assert.equal(pendingHydrationCount(), 1)
})

test('startup loads immediately instead of waiting for a transport open', () => {
  const source = readFileSync(new URL('../src/composables/useConnectionContext.ts', import.meta.url), 'utf8')
  // 冷启动时 open 可能早于 App 挂载，之后不会再来一次：必须主动打一次。
  assert.match(source, /primeHydration\(hydrationTask\)/)
  assert.doesNotMatch(source, /attempt < 5/)
})

test('a startup load that succeeds never enters the pending queue', async () => {
  const before = pendingHydrationCount()
  let ran = 0
  await primeHydration(() => { ran += 1 })
  assert.equal(ran, 1)
  assert.equal(pendingHydrationCount(), before)
})

test('a startup load that fails is kept for the next open', async () => {
  // 模块级 pending Set 会被前面的用例共用：这里只断言「失败后重试确实发生了」。
  let attempts = 0
  const task = (): void => {
    attempts += 1
    if (attempts === 1) throw new Error('engine not ready')
  }
  await primeHydration(task)
  assert.equal(attempts, 1)

  await flushHydrationOnOpen()
  assert.equal(attempts, 2)
})

test('the session store drains pending hydration when its transport reaches open', () => {
  const source = readFileSync(new URL('../src/stores/session.ts', import.meta.url), 'utf8')
  assert.match(source, /flushHydrationOnOpen/)
})
