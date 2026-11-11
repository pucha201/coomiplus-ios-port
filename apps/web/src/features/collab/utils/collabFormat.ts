import type { CollabAgentStatus, CollabTaskStatus } from '../types/collab'

export const taskStatusLabel: Record<CollabTaskStatus, string> = {
  draft: '草稿', starting: '启动中', running: '运行中', waiting: '等待中',
  completed: '已完成', partial: '部分完成', failed: '失败', cancelled: '已取消',
  interrupted: '已中断', queued: '排队中',
}

export const agentStatusLabel: Record<CollabAgentStatus, string> = {
  pending: '待命', starting: '启动中', running: '执行中', waiting: '等待中',
  completed: '已完成', failed: '失败', cancelled: '已取消',
}

export function relativeTime(value: string): string {
  const timestamp = Date.parse(value)
  if (!Number.isFinite(timestamp)) return ''
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000))
  if (seconds < 60) return '刚刚'
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`
  return `${Math.floor(seconds / 86400)} 天前`
}

export function durationText(start?: string, end?: string): string {
  if (!start) return '0 分钟'
  const milliseconds = Math.max(0, Date.parse(end || new Date().toISOString()) - Date.parse(start))
  const minutes = Math.floor(milliseconds / 60_000)
  if (minutes < 60) return `${minutes} 分钟`
  return `${Math.floor(minutes / 60)} 小时 ${minutes % 60} 分`
}

export const subtaskStatusText: Record<string, string> = {
  pending: '待执行', starting: '启动中', running: '执行中', retrying: '重试中',
  completed: '完成', failed: '失败', cancelled: '已取消', timeout: '超时',
}
