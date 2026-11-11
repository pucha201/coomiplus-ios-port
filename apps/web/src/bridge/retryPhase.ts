/**
 * 首次连接与“重连”的状态区分。
 *
 * 刚打开应用时传输层本来就要花几秒握手；这段窗口内的失败属于“还没连上”，
 * 不是“连上后又断了”。如果直接报 reconnecting，用户一进应用就看到红色重连条。
 * 只有宽限期结束，或这条连接确实成功打开过，才允许进入 reconnecting。
 */
export const INITIAL_CONNECT_GRACE_MS = 5_000

export interface RetryPhaseInput {
  /** 这条传输是否成功打开过至少一次。 */
  everOpened: boolean
  /** 从本次 connect() 开始到现在的毫秒数。 */
  elapsedMs: number
  /** 首次连接宽限期；默认 5s。 */
  graceMs?: number
}

export function retryStateFor(input: RetryPhaseInput): 'connecting' | 'reconnecting' {
  const grace = input.graceMs ?? INITIAL_CONNECT_GRACE_MS
  if (!input.everOpened && input.elapsedMs < grace) return 'connecting'
  return 'reconnecting'
}
