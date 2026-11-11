import { marked } from 'marked'
import { resolveMarkdownImageSrc, setImageSrcResolver, type ImageSrcResolver } from './markdownImage.ts'
export { setImageSrcResolver, type ImageSrcResolver }

/**
 * Markdown → HTML，出门前过一遍白名单。
 *
 * marked 会把源文里的裸 HTML 原样吐出来，而这段文字来自模型和工具结果 ——
 * 不可信。直接 v-html 就等于把 `<img onerror=…>` 放进 WebView，而这个
 * WebView 和引擎同源（127.0.0.1，手里有 shell）。所以解析完再过一遍：
 * 名单外的标签拆掉只留文字，属性一律丢，链接只放行 http(s)/mailto。
 *
 * 正文配图：模型给出的通常是本地文件路径（会话幕布里的 png/jpg），
 * 浏览器不能直接读本地路径，所以这里把「绝对路径 / 相对 cwd 的路径」
 * 统一交给宿主注入的 imageSrc 转成受控的 `/api/fs/raw?...` URL；
 * https 与 data:image 仍原样放行，其余 схем 一律丢弃。
 */
marked.setOptions({ breaks: true, gfm: true })

/** marked 正常会产出的标签，多一个都不放。 */
const ALLOWED = new Set([
  'p', 'br', 'hr',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'a', 'input',
  'table', 'thead', 'tbody', 'tr', 'th', 'td',
  // 正文配图：只允许 https 与 data:image，并强制懒加载/不带 referrer。
  'img',
])

/** 这些连文字都不要：里面装的是代码，不是内容。 */
const DROP = new Set(['script', 'style', 'iframe', 'object', 'embed', 'template', 'svg', 'math', 'link', 'meta'])

const ATTRS: Record<string, string[]> = {
  a: ['href'],
  code: ['class'],
  ol: ['start'],
  th: ['align'],
  td: ['align'],
  input: ['type', 'checked', 'disabled'],
  img: ['src', 'alt'],
}

const SAFE_IMG_SRC = /^(?:https:\/\/|data:image\/(?:png|jpe?g|gif|webp|avif);base64,)/i
/** 空白与控制字符：URL 解析器会抠掉它们（"java\tscript:" 是真能跑的）。 */
const URL_NOISE = /[\s\u0000-\u001f]+/g

const SAFE_HREF = /^(?:https?:|mailto:)/i
const SAFE_LANG = /^language-[\w+#.-]{1,24}$/
const SAFE_ALIGN = /^(?:left|right|center)$/

/** 返回要留下的属性值（可能被改写过）；不要就返回 null。 */
function cleanAttr(tag: string, name: string, value: string): string | null {
  if (!(ATTRS[tag] ?? []).includes(name)) return null
  if (name === 'href') {
    const url = value.replace(URL_NOISE, '')
    return SAFE_HREF.test(url) ? url : null
  }
  if (name === 'class') return SAFE_LANG.test(value) ? value : null
  if (name === 'align') return SAFE_ALIGN.test(value) ? value : null
  if (name === 'start') return /^\d{1,6}$/.test(value) ? value : null
  if (name === 'type') return value.toLowerCase() === 'checkbox' ? 'checkbox' : null
  if (tag === 'img' && name === 'src') return resolveMarkdownImageSrc(value)
  return value
}

function clean(node: Element): void {
  for (const el of Array.from(node.children)) {
    const tag = el.tagName.toLowerCase()
    if (DROP.has(tag)) { el.remove(); continue }
    if (!ALLOWED.has(tag)) {
      // 名单外的标签拆掉，孩子（文字）留下 —— 不能因为一个 <div> 吞掉半段回答。
      clean(el)
      el.replaceWith(...Array.from(el.childNodes))
      continue
    }
    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase()
      const kept = cleanAttr(tag, name, attr.value)
      if (kept === null) el.removeAttribute(attr.name)
      else if (kept !== attr.value) el.setAttribute(name, kept)
    }
    // 链接一律新窗口打开：别把整个 WebView 导航跑了。
    if (tag === 'a' && el.hasAttribute('href')) {
      el.setAttribute('target', '_blank')
      el.setAttribute('rel', 'noopener noreferrer nofollow')
    }
    clean(el)
  }
}

/** DOMParser 建出来的文档是惰性的：不跑脚本，也不会去拉 src。 */
const parser = new DOMParser()

/** 表格工具条的图标（内联 SVG：v-html 里用不了 Vue 组件）。 */
const TABLE_ICONS: Record<'copy' | 'view', string> = {
  copy: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5"/><path d="M5 15V5.5A2.5 2.5 0 0 1 7.5 3H17"/></svg>',
  view: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12z"/><circle cx="12" cy="12" r="2.6"/></svg>',
}

/** 表格卡片化：工具条（复制/查看）+ 横向滚动容器。按钮由 MessageBubble 事件代理接管。 */
function enhanceTables(doc: Document): void {
  for (const table of Array.from(doc.querySelectorAll('table'))) {
    const card = doc.createElement('div')
    card.className = 'md-table'
    const bar = doc.createElement('div')
    bar.className = 'md-table-bar'
    for (const [kind, label] of [['copy', '复制'], ['view', '查看']] as const) {
      const button = doc.createElement('button')
      button.type = 'button'
      button.className = 'md-table-btn'
      button.setAttribute('data-md-table', kind)
      button.setAttribute('aria-label', label)
      button.title = label
      button.innerHTML = TABLE_ICONS[kind]
      bar.append(button)
    }
    const scroll = doc.createElement('div')
    scroll.className = 'md-table-scroll'
    table.replaceWith(card)
    scroll.append(table)
    card.append(bar, scroll)
  }
}

function sanitize(html: string): string {
  const doc = parser.parseFromString(`<body>${html}</body>`, 'text/html')
  clean(doc.body)
  enhanceTables(doc)
  return doc.body.innerHTML
}

/**
 * 流式期间同一段文字会被反复渲染（MessageBubble 每 60ms 重建一次全部块），
 * 已经定稿的块没必要一遍遍解析，缓存住。
 */
const CACHE_MAX = 240
const cache = new Map<string, string>()

/**
 * 清空渲染缓存。
 * 图片 URL 依赖会话 cwd 与访问令牌：两者一变，旧 HTML 里的地址就失效。
 */
export function clearMarkdownCache(): void {
  cache.clear()
}

export function renderMarkdown(src: string): string {
  const hit = cache.get(src)
  if (hit !== undefined) return hit
  const html = sanitize(marked.parse(src, { async: false }) as string)
  if (cache.size >= CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest !== undefined) cache.delete(oldest)
  }
  cache.set(src, html)
  return html
}
