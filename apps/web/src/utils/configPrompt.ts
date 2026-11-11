/**
 * configuration_required 事件的界面措辞。
 *
 * 引擎在「跑不动」时发这条事件，旧行为是前端立刻 router.push 到事件里带的 route：
 * 用户在别的面板上打字，页面自己跳走，看起来像 bug；云端模式下那条事件来自对面那台
 * 电脑，route 属于远端引擎，直接把远端给的地址塞进本机路由也不合适。
 * 所以这里只产出「说什么 + 能不能跳 + 跳到哪儿」，跳转由用户按下按钮触发。
 */

/** 允许自动跳转之外的唯一去处：写死在白名单里，远端给什么都进不来。 */
const SAFE_ROUTES = ['/providers'] as const
export type SafeConfigRoute = (typeof SAFE_ROUTES)[number]

export interface ConfigPromptAction {
  label: string
  route: SafeConfigRoute
}

export interface ConfigPrompt {
  text: string
  /** null = 只显示文字，不给跳转按钮。 */
  action: ConfigPromptAction | null
}

const DEFAULT_MESSAGE = '请先配置并启用一个可用的模型供应商'

/** 引擎 reason → 我们自己的中文说法。首次未配置和配置坏了的修法不同，不能共用一句话。 */
const REASON_TEXT: Record<string, string> = {
  not_configured: DEFAULT_MESSAGE,
  invalid_config: '模型配置文件读不出来了（可能已损坏），请打开模型配置重新保存一次',
}

export function safeConfigRoute(route: unknown): SafeConfigRoute | null {
  return SAFE_ROUTES.includes(route as SafeConfigRoute) ? (route as SafeConfigRoute) : null
}

export function configPromptFor(ev: { message?: string; route?: string; reason?: string }): ConfigPrompt {
  const fromEngine = ev.message?.trim() ?? ''
  const text = REASON_TEXT[ev.reason ?? ''] ?? (fromEngine || DEFAULT_MESSAGE)
  // route 缺省时按「去配模型」处理；显式给了不认识的 route 就只留文字。
  const route = safeConfigRoute(ev.route ?? '/providers')
  return { text, action: route ? { label: '去配置模型', route } : null }
}
