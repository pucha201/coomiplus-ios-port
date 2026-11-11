import { reactive } from 'vue'

/**
 * 应用内目录选择器（无原生 SAF 桥时的替代品）。
 *
 * 以前桌面/无桥环境用 window.prompt 让用户手打绝对路径，Android WebView 又默认吞掉 prompt，
 * 于是「选择工作目录」在手机上等于没反应。这里改成 Promise 式的单例弹层：
 * 调用方 await pickDirectory(start)，弹层负责浏览并返回选中的目录。
 */
interface FolderPickerState {
  open: boolean
  start: string
}

export const folderPicker = reactive<FolderPickerState>({ open: false, start: '' })

let resolver: ((path: string | null) => void) | null = null

/** 打开选择器；同一时间只允许一个，上一次未决的请求按取消处理。 */
export function pickDirectory(start = ''): Promise<string | null> {
  resolver?.(null)
  folderPicker.start = start
  folderPicker.open = true
  return new Promise(resolve => { resolver = resolve })
}

/** 关闭选择器并交付结果（null = 取消）。 */
export function settleDirectory(path: string | null): void {
  const done = resolver
  resolver = null
  folderPicker.open = false
  folderPicker.start = ''
  done?.(path)
}

export function joinPath(base: string, name: string): string {
  if (!base) return name
  const separator = base.includes('\\') && !base.includes('/') ? '\\' : '/'
  return base.endsWith('/') || base.endsWith('\\') ? base + name : base + separator + name
}

/** 上一级目录；已是根（/ 或 C:\）时返回 null。 */
export function parentPath(path: string): string | null {
  if (!path) return null
  let value = path
  while (value.length > 1 && (value.endsWith('/') || value.endsWith('\\'))) {
    if (/^[A-Za-z]:[\\/]$/.test(value)) break
    value = value.slice(0, -1)
  }
  if (value === '/' || /^[A-Za-z]:[\\/]$/.test(value)) return null
  const index = Math.max(value.lastIndexOf('/'), value.lastIndexOf('\\'))
  if (index < 0) return null
  let parent = value.slice(0, index)
  if (/^[A-Za-z]:$/.test(parent)) parent += '\\'
  return parent || (value.startsWith('/') ? '/' : null)
}
