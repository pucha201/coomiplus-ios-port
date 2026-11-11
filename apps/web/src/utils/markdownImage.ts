/**
 * 正文配图的地址判定（纯函数，不碰 DOM，便于单测）。
 *
 * 模型在回答里给的图片通常是本地文件路径（会话幕布里的 png/jpg），
 * 浏览器不能直接读本地路径；这里只负责「安不安全」，真正的
 * 路径 → 受控 URL 转换由宿主注入的 resolver 完成。
 */

/** 引擎自己的文件读取端点：已经带令牌，原样放行。 */
const ENGINE_IMG_SRC = /^\/api\/fs\/raw\?/i

/** https 与内联图片：原样放行。 */
const SAFE_IMG_SRC = /^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i

/** Windows 盘符 / POSIX 绝对路径（正反斜杠都认）。 */
const LOCAL_ABS = /^(?:[a-zA-Z]:[\\/]|[\\/])/

/** 只把这些扩展名当图片转预览，避免把任意路径塞进 <img>。 */
const LOCAL_IMG_EXT = /\.(?:png|jpe?g|gif|webp|avif|svg)$/i

/** 空白和控制字符：URL 解析器会把它们抠掉，"java\tscript:" 是真能跑的。 */
const URL_NOISE = /[\s\u0000-\u001f]+/g

export type ImageSrcResolver = (raw: string) => string | null

let resolveImageSrc: ImageSrcResolver = () => null

/** 注册图片地址解析器（应用启动时调用一次，测试里可替换）。 */
export function setImageSrcResolver(resolver: ImageSrcResolver): void {
  resolveImageSrc = resolver
}

/** 把 Markdown 里的图片地址翻成可访问 URL；不安全或非图片返回 null。 */
export function resolveMarkdownImageSrc(value: string): string | null {
  // 本地路径里的空格是合法字符（`a b.png`），只剪掉首尾；
  // URL 方案检测才需要把空白/控制字符全部抠掉（"java\tscript:" 是真能跑的）。
  const local = value.trim()
  if (LOCAL_ABS.test(local) || local.startsWith('./') || local.startsWith('../') || local.startsWith('~/')) {
    return LOCAL_IMG_EXT.test(local) ? resolveImageSrc(local) : null
  }
  const url = value.replace(URL_NOISE, '')
  if (!url) return null
  if (SAFE_IMG_SRC.test(url) || ENGINE_IMG_SRC.test(url)) return url
  // 裸相对路径（如 images/a.png）也允许——模型常用它指会话目录里的文件。
  if (!LOCAL_IMG_EXT.test(local) || local.includes(':') || local.startsWith('/')) return null
  return resolveImageSrc(local)
}
