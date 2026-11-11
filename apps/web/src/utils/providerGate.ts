/**
 * 发送前的模型门禁判定。
 *
 * 界面上原来只有「有模型 / 没模型」两态，切引擎那一瞬列表被清空就算「没模型」，
 * 于是把人推进添加模型控制台——可那台机器上明明配好了，只是还没读到。
 * 第三态「不知道」不能当成「没有」：不知道只许等，不许赶人。
 */
export type ProviderGate = 'send' | 'reading' | 'add-model'

export function decideProviderGate({ ready, known }: { ready: boolean; known: boolean }): ProviderGate {
  if (ready) return 'send'
  return known ? 'add-model' : 'reading'
}
