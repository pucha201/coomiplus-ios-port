/** 旧版本把计划模式指令拼进了用户消息正文；新版本只走模型 request_prefix。 */
export const PLAN_MODE_PREFIX =
  'Work in planning mode. Inspect the project and return an actionable plan before making changes.'

/** 剥离开头的完整计划模式前缀；不是这种消息就原样返回。 */
export function stripPlanModePrefix(text: string): string {
  if (!text.startsWith(PLAN_MODE_PREFIX)) return text
  return text.slice(PLAN_MODE_PREFIX.length).replace(/^[\r\n]+/, '')
}

/** 标题可能已被旧逻辑截断，只保留开头特征串；命中后交给引擎重算或显示占位。 */
export function isPlanModeTitle(text: string): boolean {
  return text.trimStart().startsWith('Work in planning mode')
}
