/**
 * 「等通道真正打开再补的加载」。
 *
 * 历史列表、模型列表这类启动加载以前靠固定次数重试：P2P 握手比 3.5 秒慢一点就彻底放弃，
 * 界面于是停在空列表 + 「正在重连」。这里改成由传输 open 事件驱动：没成就继续挂着，
 * 每次真正连上再补一次，成功即出队。
 */
export type HydrationTask = () => void | Promise<void>

const pending = new Set<HydrationTask>()

/** 挂一个待补加载；同一个函数重复挂只算一次。 */
export function deferUntilTransportOpen(task: HydrationTask): void {
  pending.add(task)
}

export function pendingHydrationCount(): number {
  return pending.size
}

/**
 * 通道 open 只是一次「可以试了」的时机，不是保证：中转刚打开时宿主的引擎桥
 * 可能还没就绪，第一次补加载照样会失败。以前失败的留在队列里、等下一次 open ——
 * 可连接已经稳定，不会再有下一次 open，列表就永远空着。这里给残留任务一个
 * 退避重试（3s 起、60s 封顶），成功即停。
 */
const RETRY_BASE_MS = 3_000
const RETRY_MAX_MS = 60_000
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryDelay = RETRY_BASE_MS

function scheduleRetry(): void {
  if (retryTimer || pending.size === 0 || typeof window === 'undefined') return
  retryTimer = setTimeout(() => {
    retryTimer = null
    void flushHydrationOnOpen()
  }, retryDelay)
  retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS)
}

/** 传输打开时调用：跑一遍待补加载，失败的留在队列里等下一次 open 或退避重试。 */
export async function flushHydrationOnOpen(): Promise<void> {
  for (const task of [...pending]) {
    try {
      await task()
      pending.delete(task)
    } catch {
      // 还没连上/引擎没就绪：保持 pending，等下一次 open 或退避重试。
    }
  }
  if (pending.size > 0) scheduleRetry()
  else retryDelay = RETRY_BASE_MS
}

/**
 * 启动即加载：立刻打一次，失败才进队列等 open / 退避重试。
 *
 * 不能只挂队列再 flush —— 冷启动时 WS 的 open 可能早于调用方执行，
 * 之后再没有第二个 open，任务就一直睡在队列里，界面永远空着。
 */
export async function primeHydration(task: HydrationTask): Promise<void> {
  try {
    await task()
  } catch {
    pending.add(task)
    scheduleRetry()
  }
}
