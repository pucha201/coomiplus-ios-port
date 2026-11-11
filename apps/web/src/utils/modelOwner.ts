/**
 * 「这份模型配置是谁的」。
 *
 * 云端模式下手机端的模型页读写的是电脑里那个引擎的 config/providers.json：
 * 页面本身不写清这一点，用户就会以为手机也存了一份，回头在手机上找不到自己改的东西，
 * 或者以为改动没生效又改一遍。
 */
import type { ConnectionMode } from '../protocol/remote.ts'

export interface ModelOwnerInput {
  mode: ConnectionMode
  /** 云端模式下是否已经选中了一台电脑。 */
  hasDevice: boolean
  deviceName?: string
}

export function modelOwnerNote(input: ModelOwnerInput): string | null {
  if (input.mode !== 'cloud') return null
  if (!input.hasDevice) return '云端模式还没选中电脑：模型配置改的是电脑上的引擎，请先选一台。'
  return `正在编辑「${input.deviceName?.trim() || '这台电脑'}」的模型：改动存进电脑的引擎，不在手机上。`
}
