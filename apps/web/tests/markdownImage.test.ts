import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveMarkdownImageSrc, setImageSrcResolver } from '../src/utils/markdownImage.ts'

/** 模拟 MessageBubble 注入的解析器：本地路径 → 受控 fs/raw URL。 */
function installResolver(cwd = '/data/coomi/chat/s1'): void {
  setImageSrcResolver(raw => {
    const value = raw.trim()
    const base = cwd.replace(/[\/]+$/, '')
    const absolute = /^(?:[a-zA-Z]:[\/]|[\/])/.test(value) ? value : base + '/' + value
    return '/api/fs/raw?path=' + encodeURIComponent(absolute) + '&token=T'
  })
}

test('绝对路径的正文图片会转成受控预览地址', () => {
  installResolver()
  const src = resolveMarkdownImageSrc('/storage/emulated/0/coomi/chat/s1/out.png')
  assert.ok(src)
  assert.match(src, /^\/api\/fs\/raw\?path=/)
  assert.match(decodeURIComponent(src), /out\.png/)
})

test('相对路径按会话工作目录解析', () => {
  installResolver('/data/coomi/chat/s1')
  const src = resolveMarkdownImageSrc('out/chart.png')
  assert.ok(src)
  assert.match(decodeURIComponent(src), /\/data\/coomi\/chat\/s1\/out\/chart\.png/)
})

test('https 与 data:image 原样保留', () => {
  installResolver()
  assert.equal(resolveMarkdownImageSrc('https://example.com/a.png'), 'https://example.com/a.png')
  const inline = 'data:image/png;base64,iVBORw0KGgo='
  assert.equal(resolveMarkdownImageSrc(inline), inline)
})

test('危险与非图片源不会被放行', () => {
  installResolver()
  for (const url of [
    'javascript:alert(1)',
    'file:///etc/passwd',
    'http://example.com/a.png',
    '/etc/passwd',
    'notes.txt',
  ]) {
    assert.equal(resolveMarkdownImageSrc(url), null, `不应放行：${url}`)
  }
})

test('本地图片带空格/换行也会被清理后再解析', () => {
  installResolver()
  const src = resolveMarkdownImageSrc('/data/coomi/chat/s1/a b.png\n')
  assert.ok(src)
  assert.match(decodeURIComponent(src), /a b\.png/)
})
