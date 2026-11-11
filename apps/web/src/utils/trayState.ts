import { reactive } from 'vue'

/** 输入框功能托盘（☰）的展开状态。模块级 reactive：Composer 读写、
 *  StatusBar 联动（展开时运行状态行上推 + 模糊渐隐，收回时降回来）。 */
export const trayState = reactive({ open: false })
