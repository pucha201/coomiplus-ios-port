/**
 * 正文里的文件路径抽取与归一化。
 *
 * 背景（两个真实缺陷）：
 *  1. 旧正则不从 `/` 开始匹配，`/data/data/…/a.png` 只匹配到 `data/data/…/a.png`，
 *     再被 `${cwd}/${p}` 拼成 `<cwd>/data/data/…` —— 本地模式下每张文件卡都指向
 *     一个不存在的路径，「另存为 / 用其它应用打开」自然静默失败。
 *  2. 安卓 proot 的内置工具把结果渲染成 guest 别名（`/workspace/…`、`/home/coomi/…`），
 *     前端从不映射；`fs/raw`、`fs/download` 与原生桥只认宿主路径。
 *
 * 这里统一两件事：**保留开头斜杠**、**按命名空间展开**。纯函数，可在 node 单测里跑。
 */

export interface PathRoots {
  /** `/workspace` 的宿主路径。调用方应传会话 cwd（每个会话有自己的幕布目录）。 */
  workspace?: string
  runtimeHome?: string
  buildKit?: string
  tmp?: string
  inbox?: string
  /** 引擎是否在 Android guest 命名空间里（桌面端为 false，别名就是真实路径）。 */
  guest?: boolean
}

/** 路径前面的「非路径」边界：空白、括号、引号、中文标点等。 */
const START = '(^|[\\s(（【「『"\'`，,。;；:：、=\\[])'
/** 主体：可选 ~/ ./ ../ 或 / 前缀 + 目录段 + 文件名.扩展名。允许中文与常见符号。 */
const TOKEN = '((?:~\\/|\\.{1,2}\\/|\\/)?(?:[\\p{L}\\p{N}_.+\\-]+\\/)*[\\p{L}\\p{N}_.+\\-]+\\.[A-Za-z0-9]{1,8})'
/** 结尾边界：空白、右括号、引号、中文标点、尖括号等。 */
const END = '(?=$|[\\s)）】」』"\'`，,。;；:：、\\]<>|])'

const PATH_RE = new RegExp(START + TOKEN + END, 'gu')

function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

/** 规范化绝对路径：消掉 `.`、`..` 与重复斜杠（不改大小写、不碰磁盘）。 */
export function normalizeAbsolute(value: string): string {
  const parts: string[] = []
  for (const segment of value.replace(/\\/g, '/').split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') { parts.pop(); continue }
    parts.push(segment)
  }
  return '/' + parts.join('/')
}

/**
 * 把正文里的一段路径文本变成引擎能读的宿主绝对路径。
 * 返回 null 表示这条路径无法解析（宁可不显示卡片，也不显示一张点了报错的卡）。
 */
export function normalizeFilePath(
  raw: string,
  roots: PathRoots,
  sessionCwd?: string,
): string | null {
  let token = raw.trim().replace(/\\/g, '/')
  if (!token) return null
  if (token.includes('://')) return null

  const guest = roots.guest !== false
  const workspace = stripTrailingSlash((sessionCwd || roots.workspace || '').trim())

  if (guest) {
    if (token.startsWith('~/')) {
      return roots.runtimeHome ? normalizeAbsolute(stripTrailingSlash(roots.runtimeHome) + '/' + token.slice(2)) : null
    }
    // /workspace/coomi/inbox 比 /workspace 更具体，必须先匹配。
    const aliases: Array<[string, string | undefined]> = [
      ['/workspace/coomi/inbox', roots.inbox],
      ['/workspace', workspace || roots.workspace],
      ['/home/coomi', roots.runtimeHome],
      ['/opt/coomi-dev', roots.buildKit],
      ['/tmp', roots.tmp],
    ]
    for (const [alias, root] of aliases) {
      if (!root) continue
      if (token === alias) return normalizeAbsolute(root)
      if (token.startsWith(alias + '/')) {
        return normalizeAbsolute(stripTrailingSlash(root) + token.slice(alias.length))
      }
    }
  }

  if (token.startsWith('/')) return normalizeAbsolute(token)
  const base = workspace || (guest ? '' : (roots.workspace ?? '').trim())
  if (!base) return null
  return normalizeAbsolute(stripTrailingSlash(base) + '/' + token.replace(/^\.\//, ''))
}

/**
 * 从一段正文里抽出可用的文件路径（去重、保序）。
 * 相对路径按会话 cwd 展开；`/workspace` 等 guest 别名按 roots 展开。
 */
export function extractFilePaths(
  text: string,
  roots: PathRoots,
  sessionCwd?: string,
  limit = 8,
): string[] {
  if (!text) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const match of text.matchAll(PATH_RE)) {
    const token = match[2]
    if (!token) continue
    const start = (match.index ?? 0) + (match[1]?.length ?? 0)
    // URL 里的路径不当作本地文件：`https://host/a.png` 的边界可能是 `:`。
    if (text.slice(Math.max(0, start - 3), start) === '://') continue
    const normalized = normalizeFilePath(token, roots, sessionCwd)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    out.push(normalized)
    if (out.length >= limit) break
  }
  return out
}

export function fileExt(path: string): string {
  const name = path.split('/').pop() || ''
  const dot = name.lastIndexOf('.')
  return dot <= 0 ? '' : name.slice(dot + 1).toLowerCase()
}

export function fileName(path: string): string {
  return path.split('/').filter(Boolean).pop() || path
}

export function isImagePath(path: string): boolean {
  return ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'].includes(fileExt(path))
}
