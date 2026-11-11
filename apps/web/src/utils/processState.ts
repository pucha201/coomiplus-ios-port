import { reactive } from 'vue'

/** 轮过程块（ProcessBlock）的展开状态：key = turn 块 key。
 *  不放组件本地 ref：vue-virtual-scroller 滚出视口会销毁行组件，滚回来重建时
 *  本地状态会丢（ReasoningBlock 的教训是把展开态写回条目本身；turn 块没有单一
 *  对应条目，所以记在这张模块级表里，与数据同生共死、跨滚动保持）。 */
export const processOpenState = reactive(new Map<string, boolean>())

/** 工具组（ToolGroup）的手动开合状态：key = 会话 + 组内首张卡 callId。
 *  与 processOpenState 同理 —— 虚拟列表会销毁行组件，本地 ref 一滚就丢；
 *  组只会往尾部追加调用，首卡 callId 是稳定标识。 */
export const toolGroupOpenState = reactive(new Map<string, boolean>())

/** 单张工具卡的详情 sheet：key = 会话 + callId。
 *  生成中卡片会从「单卡块」并入「轮过程块」，组件实例被重建；
 *  状态放本地 ref 会被顺手关掉，放这里就能在重建后继续开着。 */
export const toolCardOpenState = reactive(new Map<string, boolean>())

/** 切会话时清空：不同会话的 callId / 块 key 可能重复，旧开合态会串到新会话。 */
export function resetTransientUiState(): void {
  processOpenState.clear()
  toolGroupOpenState.clear()
  toolCardOpenState.clear()
}
