import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

const read = (path: string): string => readFileSync(new URL('../' + path, import.meta.url), 'utf8')

test('新建对话立即创建自己的幕布目录并写回 cwd', () => {
  const store = read('src/stores/session.ts')
  // 旧机制：<根目录>/<session-id>，新建时就建，不等第一条消息。
  assert.match(store, /void ensureSessionWorkspace\(nextId\)/)
  assert.match(store, /\/api\/sessions\/\$\{id\}\/workspace/)
  assert.match(store, /cwd\.value = path/)
  // 会话目录不是项目根：currentCwd 只由 /api/runtime/health 提供，供分组使用。
  assert.doesNotMatch(store, /sessions\.setCurrentCwd\(path\)/)
  // 新建时先清空上一会话的 cwd，避免切过去还显示旧目录。
  assert.match(store, /activateSession\(nextId\)\s*\n\s*cwd\.value = ''/)
})

test('引擎侧新会话目录 = 根目录 / 会话 id，已有会话不被改写', () => {
  const engine = readFileSync(
    new URL('../../coomi-rs/ui/src/web/mod.rs', import.meta.url),
    'utf8',
  )
  assert.match(engine, /let session_dir = cwd\.join\(session_id\.to_string\(\)\)/)
  assert.match(engine, /Session::new\(provider_id, model, session_dir\)/)
  // 不能再把历史会话的 cwd 归一成根目录。
  assert.doesNotMatch(engine, /if session\.cwd == legacy \{\s*\n\s*session\.cwd = cwd\.to_path_buf\(\);/)
})

test('未落盘会话的工作区也不回落到根目录', () => {
  const engine = readFileSync(
    new URL('../../coomi-rs/ui/src/web/mod.rs', import.meta.url),
    'utf8',
  )
  assert.match(engine, /unwrap_or_else\(\|\| engine_cwd\.join\(session_id\)\)/)
})
