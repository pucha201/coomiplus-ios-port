import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

function read(relative) {
  return readFileSync(new URL('../src/' + relative, import.meta.url), 'utf8')
}

test('生命体入口在设置枢纽页（对话页之外唯一入口）', () => {
  const hub = read('views/SettingsView.vue')
  assert.match(hub, /title="数字生命体"/)
  assert.match(hub, /router\.push\('\/life'\)/)
  assert.match(hub, /router\.push\('\/life\/memory'\)/)
  assert.match(hub, /router\.push\('\/life\/journal'\)/)
})

test('设置页顶栏有毛玻璃底，搜索框是方角', () => {
  const hub = read('views/SettingsView.vue')
  assert.match(hub, /class="bar-bg"/)
  assert.match(hub, /backdrop-filter: blur\(18px\)/)
  // 搜索框圆角跟卡片一致（r-md），不再是胶囊。
  assert.match(hub, /\.search \{[\s\S]*?border-radius: var\(--r-md\)/)

  const page = read('components/settings/SettingsPage.vue')
  assert.match(page, /class="bar-bg"/)
})

test('暗色主题：底与卡片/描边拉开层级', () => {
  const css = read('styles/global.css')
  assert.match(css, /:root\[data-theme='dark'\] \{[\s\S]*?--bg: #1a1d22;/)
  assert.match(css, /:root\[data-theme='dark'\] \{[\s\S]*?--border: #3a424d;/)
})

test('侧栏：分组不再套框；支持多选与归档', () => {
  const drawer = read('components/SideDrawer.vue')
  assert.doesNotMatch(drawer, /\.ghead \{[\s\S]{0,300}?border: 1px solid var\(--border\)/)
  assert.match(drawer, /const selected = ref<Set<string> \| null>/)
  assert.match(drawer, /function archiveSelection\(archived: boolean\)/)
  assert.match(drawer, /sessions\.setArchived\(menuFor\.value\.id, archived\)/)
  assert.match(drawer, /go\('\/sessions\/archived'\)/)

  const store = read('stores/sessions.ts')
  assert.match(store, /async function setArchived/)
  assert.match(store, /const archived = computed<SessionMeta\[\]>/)
})

test('计划模式只有一套 UI：胶囊；有胶囊时不再显示「正在…」；清单向上展开', () => {
  const composer = read('components/Composer.vue')
  assert.doesNotMatch(composer, /plan-banner/)
  assert.match(composer, /:mode-on="config\.planMode"/)

  const capsule = read('components/PlanCapsule.vue')
  assert.match(capsule, /modeOn/)
  assert.match(capsule, /emit\('exit'\)/)
  // 列表在按钮之前（DOM 顺序 = 视觉在上方）。
  assert.ok(capsule.indexOf('<ul v-if="open && hasPlan"') < capsule.indexOf('class="pill"'))
  assert.match(capsule, /plan-list-leave-active/)

  const status = read('components/StatusBar.vue')
  assert.match(status, /planCapsuleShown/)
  assert.match(status, /v-if="runLabel && !planCapsuleShown"/)
})

test('横屏/平板：静态双栏，关掉滑盖 3D 与模糊', () => {
  const chat = read('views/ChatView.vue')
  assert.match(chat, /const landscape = window\.innerWidth >= 768 && !portrait/)
  assert.match(chat, /const noSlideFx = computed\(\(\) => isTablet\.value \|\| fxLite\.value\)/)
  assert.match(chat, /const angle = noSlideFx\.value \? 0 : 14 \* p/)
})

test('系统返回：浮层先关；对话页返回需要「再按一次退出」', () => {
  const nav = read('bridge/navigation.ts')
  // 先消费最上层浮层。
  assert.match(nav, /if \(closeTopOverlay\(\)\) return true/)
  // 对话页不再第一次就 exit：先提示，2 秒内再按才退出。
  assert.match(nav, /const EXIT_CONFIRM_MS = 2000/)
  assert.match(nav, /再按一次返回退出/)
  assert.match(nav, /if \(exitArmedAt > 0 && now - exitArmedAt <= EXIT_CONFIRM_MS\)/)

  // 工具详情 / 用量面板 / 输入区面板都要登记到返回栈。
  const tool = read('components/ToolCardItem.vue')
  assert.match(tool, /registerOverlay\(`tool-detail:\$\{props\.card\.callId\}`/)
  const group = read('components/ToolGroup.vue')
  assert.match(group, /registerOverlay\(registeredOverlayId, onHeadToggle\)/)
  const topbar = read('components/TopBar.vue')
  assert.match(topbar, /bindOverlay\('topbar-usage', usageOpen\)/)
  const composer = read('components/Composer.vue')
  assert.match(composer, /registerOverlay\('composer-overlay', closeComposerOverlay\)/)
})

test('会话列表：重启后不吞会话，归档不会被 checkpoint 翻回去', () => {
  const store = read('stores/sessions.ts')
  // 引擎列表不带轮数：有标题/预览时不能写 0，否则 readMetas 会把最近会话当空草稿丢掉。
  assert.match(store, /turns: local\?\.turns \?\? \(preview \|\| r\.title \? 1 : 0\)/)
  // 弱网/重连失败不清空列表。
  assert.match(store, /const giveUp = \(\): false => false/)
  // 内容没变不替换 metas 数组（避免每 2s 整张侧栏重算）。
  assert.match(store, /alive\.every\(\(meta, index\) => meta === metas\.value\[index\]\)/)
  // 删除墓碑：DELETE 未确认前同步不会把会话带回来。
  assert.match(store, /const TOMBSTONE_TTL_MS = 10 \* 60 \* 1000/)
  assert.match(store, /merged\.filter\(meta => !deletedIds\.value\.has\(meta\.id\)\)/)
})

test('高负载：轮询自适应、不可见时暂停、状态不变不重建', () => {
  const chat = read('views/ChatView.vue')
  assert.match(chat, /schedulePoll\(session\.isBusy \? 2000 : 6000\)/)
  assert.match(chat, /document\.visibilityState === 'hidden'/)
  assert.match(chat, /addEventListener\('visibilitychange', onVisibility\)/)

  const sessions = read('stores/sessions.ts')
  assert.match(sessions, /const unchanged = next\.size === runningIds\.value\.size/)
  assert.match(sessions, /let lastTasksSignature = ''/)
})
