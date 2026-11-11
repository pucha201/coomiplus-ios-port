import type { ConnectionMode } from '@/protocol/remote'

/**
 * 历史上下文的唯一键：本地一份、每台电脑各一份、云端未选设备是独立的空上下文。
 * 必须能在任何页面/原生桥调用，不能只在聊天页算。
 */
export function connectionContextKey(mode: ConnectionMode, deviceId: string): string {
  if (mode !== 'cloud') return 'local'
  return 'cloud:' + (deviceId || 'unselected')
}

/** 云端但没选电脑：本地历史不属于这个上下文，必须清空。 */
export function shouldClearSessionHistory(mode: ConnectionMode, deviceId: string): boolean {
  return mode === 'cloud' && !deviceId
}
