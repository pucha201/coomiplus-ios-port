import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

function read(relative) {
  return readFileSync(new URL('../src/' + relative, import.meta.url), 'utf8')
}
function readRepo(relative) {
  return readFileSync(new URL('../../' + relative, import.meta.url), 'utf8')
}

test('输入栏上方不再有渐出遮罩或辉光', () => {
  const composer = read('components/Composer.vue')
  assert.doesNotMatch(composer, /\.composer::before/)
  assert.doesNotMatch(composer, /box-shadow: 0 0 6px 6px/)
  // 修「按钮被消息覆盖」的那两条不能跟着删。
  assert.match(composer, /isolation: isolate/)
})

test('键盘跟随走 transform：原生不缩 WebView，前端只抬底部整组', () => {
  const global = read('styles/global.css')
  assert.match(global, /html\[data-ime='transform'\] \.composer/)
  assert.match(global, /translate3d\(0, calc\(-1 \* var\(--kb-inset, 0px\)\), 0\)/)
  assert.match(global, /html\[data-ime-anim\]/)

  const inset = read('utils/keyboardInset.ts')
  assert.match(inset, /usesImeTransform/)
  assert.match(inset, /imeTransformActive/)

  const activity = readRepo('coomi-app/app/src/main/java/com/termux/app/CoomiActivity.java')
  assert.match(activity, /usesImeTransform/)
  // 逐帧 setPadding 会把整页重新布局，必须移除。
  assert.doesNotMatch(activity, /content\.setPadding\(0, 0, 0, imeBottom\)/)
  assert.match(activity, /requestHighRefreshRate/)
})

test('滚动位置写盘不再逐帧（同步 IO 会拖低帧率）', () => {
  const hub = read('views/SettingsView.vue')
  assert.match(hub, /scrollSaveTimer/)
  const page = read('components/settings/SettingsPage.vue')
  assert.match(page, /scrollSaveTimer/)
})

test('时长只认引擎计时，不再拿会话年龄减工具耗时', () => {
  const topbar = read('components/TopBar.vue')
  assert.doesNotMatch(topbar, /Date\.now\(\) - /)
  assert.doesNotMatch(topbar, /sessionMs/)
  assert.doesNotMatch(topbar, /function toMs/)
  assert.match(topbar, /timing\?\.llmMs/)
  assert.match(topbar, /timing\?\.elapsedMs/)

  const session = read('stores/session.ts')
  assert.match(session, /\/api\/sessions\/\$\{encodeURIComponent\(id\)\}\/timing/)
  assert.match(session, /addTurnTiming\(ev\.elapsed_ms/)
})

test('文件改动：diff 与记录随 turn_end 下发，并按消息 id 回放', () => {
  const summary = read('components/FileChangeSummary.vue')
  assert.match(summary, /个文件已更改/)
  assert.match(summary, /FileDiff/)
  assert.match(summary, /记录/)

  const bubble = read('components/MessageBubble.vue')
  assert.match(bubble, /:actions="assistantActions"/)

  const session = read('stores/session.ts')
  assert.match(session, /hydrateFileChanges/)
  assert.match(session, /message_id/)
})

test('余额卡常驻：查不到显示「当前账户无法查询」，不退化成 0 也不消失', () => {
  const card = read('components/BalanceCard.vue')
  // 只有拿得到金额才显示数字。
  assert.match(card, /supported === true/)
  // 卡片本体不再按 visible 隐藏（旧实现的「读不到就整块消失」会让面板高度跳变）。
  assert.doesNotMatch(card, /v-if="visible"/)
  assert.match(card, /当前账户无法查询/)
  // 失败只记错误，不清掉上一次已知的余额。
  assert.match(card, /lastError\.value =/)
  assert.doesNotMatch(card, /catch \{\s*data\.value = null/)
})
