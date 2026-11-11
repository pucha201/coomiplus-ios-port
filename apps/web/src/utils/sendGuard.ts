import type { ConnectionState } from '@/bridge/transport'

/**
 * 「能不能起一轮」的唯一判据。
 *
 * 以前 sendMessage 用 `transport?.send(...)`：通道没打开时这句静默什么也不做，
 * 但消息已经进时间线、状态已经切成 thinking —— 用户看到的就是「发了没反应」。
 * 拦截理由同时给输入框提示和 store  Notice，两边口径一致。
 */
export interface TurnGateInput {
  state: ConnectionState
  hasTransport: boolean
  demo: boolean
}

export function turnBlockReason(input: TurnGateInput): string | null {
  if (input.demo) return null
  if (!input.hasTransport || input.state === 'closed' || input.state === 'error') return '未连接：消息没有发出'
  // 首次握手那段 connecting 不拦：本地 WS 有离线待发队列，连上就 flush。
  // 拦在这里等于一进应用就弹红条，正是「进入应用直接显示正在重连」的观感来源。
  if (input.state === 'connecting') return null
  if (input.state !== 'open') return '正在重连，稍后再发送'
  return null
}
