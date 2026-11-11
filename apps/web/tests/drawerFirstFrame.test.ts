import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 「进入应用 / 重进对话页时侧栏文字叠在页面上」的回归护栏。
 *
 * rc33 界面层是按需注入的运行时补丁：样式晚到，SideDrawer 就会先按普通定位
 * 把整栏文字画在对话页上。样式必须在首帧之前进 head，面板自身也要有
 * 「关闭态不绘制」的兜底，脚本才可以等到挂载后再跑。
 */

test('drawer styles are installed before the first render', async () => {
  const main = await readFile(new URL('../src/main.ts', import.meta.url), 'utf8')
  const stylesAt = main.indexOf('installRc33Styles()')
  const mountAt = main.indexOf('createApp(App)')

  assert.ok(stylesAt > 0, 'main.ts 必须预注入 rc33 样式')
  assert.ok(mountAt > stylesAt, '样式注入必须早于 createApp/mount')
  // 桥仍晚于首帧（它要读已挂载的 DOM 与 Android 桥）；但不能再装 rc33 的运行时 UI：
  // 那套「本地/云端」开关会和组件里的设备行重复。
  assert.match(main, /setTimeout\(\(\) => \{ installCoomiUiBridge\(\) \}, 350\)/)
  assert.doesNotMatch(main, /installRc33Ui/)
})

test('drawer panel paints nothing before the runtime patch arrives', async () => {
  const drawer = await readFile(new URL('../src/components/SideDrawer.vue', import.meta.url), 'utf8')

  assert.match(drawer, /\.drawer-root \.panel \{[\s\S]*?visibility: hidden/)
  assert.match(drawer, /\.drawer-root \.panel \{[\s\S]*?background: var\(--bg\)/)
  // 打开态必须复位兜底的 -100% 位移，否则面板停在屏外、滑开只见空底图
  assert.match(drawer, /\.drawer-root\.open \.panel \{ visibility: visible; transform: none; \}/)
})

test('leaving the chat page releases the drawer tap layer', async () => {
  const chat = await readFile(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
  const legacy = await readFile(new URL('../vendor/rc33-ui/coomi-drawer.js', import.meta.url), 'utf8')

  // 带着打开的抽屉离开对话页：组件卸载时必须归零并通知补丁，否则点击层留在新页面上吞点击。
  assert.match(chat, /onBeforeUnmount\(\(\) => \{[\s\S]*?coomi:drawer-sync/)
  assert.match(legacy, /addEventListener\('coomi:drawer-state'/)
})

test('首页空态必须保留 logo 与主标题', async () => {
  // 之前清理「中央杂乱」时把输入栏 dock 之外的整块也一起搬空过一次：
  // hero 是产品门面，必须有回归护栏，不能再被顺手删掉。
  const empty = await readFile(new URL('../src/components/EmptyState.vue', import.meta.url), 'utf8')
  // 空态结构与文案对齐 Comax：品牌标记 + 格言 + 副文案。
  assert.match(empty, /<CoomiMark[^>]*:size="64"/)
  assert.match(empty, /海内存知己/)
  assert.match(empty, /准备好了，就告诉我想做什么/)

  const chat = await readFile(new URL('../src/views/ChatView.vue', import.meta.url), 'utf8')
  assert.match(chat, /v-if="session\.timeline\.length === 0"[\s\S]{0,240}class="empty-center"/)
})
