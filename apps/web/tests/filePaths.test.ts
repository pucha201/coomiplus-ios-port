import assert from 'node:assert/strict'
import test from 'node:test'
import { extractFilePaths, normalizeAbsolute, normalizeFilePath } from '../src/utils/filePaths.ts'

const androidRoots = {
  runtimeHome: '/data/user/0/com.monai.coomiplus/files/home/runtime-v2/home',
  buildKit: '/data/user/0/com.monai.coomiplus/files/home/runtime-v2/home/.coomi-dev',
  tmp: '/data/user/0/com.monai.coomiplus/files/home/runtime-v2/tmp',
  inbox: '/data/user/0/com.monai.coomiplus/files/home/coomi/inbox',
  guest: true,
}
const sessionCwd = '/data/user/0/com.monai.coomiplus/files/home/chat/session-1'

test('absolute host paths keep their leading slash', () => {
  // 旧实现的正则从不匹配开头的 `/`，再拼上 cwd —— 本地每一张文件卡都指向
  // `<cwd>/data/data/...`，这就是「前两个按钮点了没反应」的根因。
  const text = '已生成 /data/user/0/com.monai.coomiplus/files/home/chat/session-1/out/a.png 请查看'
  assert.deepEqual(
    extractFilePaths(text, androidRoots, sessionCwd),
    ['/data/user/0/com.monai.coomiplus/files/home/chat/session-1/out/a.png'],
  )
})

test('guest aliases are mapped back to host paths', () => {
  assert.equal(
    normalizeFilePath('/workspace/out/a.png', androidRoots, sessionCwd),
    sessionCwd + '/out/a.png',
  )
  assert.equal(
    normalizeFilePath('/home/coomi/pic.png', androidRoots, sessionCwd),
    androidRoots.runtimeHome + '/pic.png',
  )
  assert.equal(
    normalizeFilePath('/opt/coomi-dev/tool.py', androidRoots, sessionCwd),
    androidRoots.buildKit + '/tool.py',
  )
  assert.equal(
    normalizeFilePath('/tmp/frame.jpg', androidRoots, sessionCwd),
    androidRoots.tmp + '/frame.jpg',
  )
  assert.equal(
    normalizeFilePath('~/.coomi/config.json', androidRoots, sessionCwd),
    androidRoots.runtimeHome + '/.coomi/config.json',
  )
})

test('inbox alias wins over the workspace prefix', () => {
  assert.equal(
    normalizeFilePath('/workspace/coomi/inbox/report.pdf', androidRoots, sessionCwd),
    androidRoots.inbox + '/report.pdf',
  )
})

test('chinese file names are recognised (old regex was ASCII-only)', () => {
  const paths = extractFilePaths('结果：/workspace/chat/s1/报告.pdf', androidRoots, sessionCwd)
  assert.deepEqual(paths, [sessionCwd + '/chat/s1/报告.pdf'])
})

test('relative paths resolve against the session workspace', () => {
  assert.deepEqual(extractFilePaths('图片见 ./out/b.jpg', androidRoots, sessionCwd), [sessionCwd + '/out/b.jpg'])
  assert.deepEqual(extractFilePaths('图见 out/c.png', androidRoots, sessionCwd), [sessionCwd + '/out/c.png'])
})

test('short names are not dropped', () => {
  assert.deepEqual(extractFilePaths('见 /a/b.png', androidRoots, sessionCwd), ['/a/b.png'])
})

test('URLs are never treated as local files', () => {
  assert.deepEqual(extractFilePaths('链接 https://example.com/a.png 不算', androidRoots, sessionCwd), [])
  assert.deepEqual(extractFilePaths('链接 http://host/x/y.jpg', androidRoots, sessionCwd), [])
})

test('desktop engines keep real /tmp paths (no guest mapping)', () => {
  const desktop = { guest: false, workspace: '/home/me/project' }
  assert.equal(normalizeFilePath('/tmp/keep.png', desktop, '/home/me/project'), '/tmp/keep.png')
  assert.deepEqual(
    extractFilePaths('输出 /tmp/keep.png', desktop, '/home/me/project'),
    ['/tmp/keep.png'],
  )
})

test('normalizeAbsolute collapses . and .. segments', () => {
  assert.equal(normalizeAbsolute('/a/./b/../c//d.png'), '/a/c/d.png')
})

test('duplicate paths are reported once and order is preserved', () => {
  const text = '/workspace/a.png 再来一次 /workspace/a.png 和 /workspace/b.jpg'
  assert.deepEqual(extractFilePaths(text, androidRoots, sessionCwd), [
    sessionCwd + '/a.png',
    sessionCwd + '/b.jpg',
  ])
})
