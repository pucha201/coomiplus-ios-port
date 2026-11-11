import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'

function read(relative: string): string {
  return readFileSync(new URL('../src/' + relative, import.meta.url), 'utf8')
}

test('历史转盘发的是目标数组下标，不是块序号', () => {
  const dial = read('components/HistoryDial.vue')
  // blockIndex 恒 ≥ 目标下标，越往后越容易越界 → 返回 undefined → 静默不动，
  // 表现就是「只能往上跳、往下跳失灵」。
  assert.match(dial, /emit\('jump', index\.value\)/)
  assert.doesNotMatch(dial, /emit\('jump', target\.blockIndex\)/)
  // ChatView 的锚点要带消息 id：流式重组后块序号会变，跳转时按 id 重新定位。
  const chat = read('views/ChatView.vue')
  assert.match(chat, /const messageId = \(block\.item as \{ id\?: string \}\)\.id/)
  assert.match(chat, /out\.push\(\{ blockIndex: index, messageId,/)
})

test('已发送附件：单行横向滚动 + 方形瓦片，不再竖着堆', () => {
  const bubble = read('components/MessageBubble.vue')
  assert.match(bubble, /\.msg-files \{[\s\S]*?flex-wrap: nowrap/)
  assert.match(bubble, /\.msg-files \{[\s\S]*?overflow-x: auto/)
  assert.doesNotMatch(bubble, /\.msg-files \{[\s\S]{0,200}flex-wrap: wrap/)
  assert.match(bubble, /<AttachmentTile[\s\S]{0,200}:file="f"/)

  const tile = read('components/AttachmentTile.vue')
  // 方块：宽高相等 + 图片走缩略图（object-fit: cover），非图片显示类型占位。
  assert.match(tile, /width: 72px; height: 72px;/)
  assert.match(tile, /aspect-ratio: 1 \/ 1;/)
  assert.match(tile, /object-fit: cover/)
  assert.match(tile, /isImagePath\(displayName\.value\)/)

  const composerRow = read('components/AttachedFileChipContainer.vue')
  assert.match(composerRow, /flex-wrap: nowrap/)
  assert.match(composerRow, /overflow-x: auto/)
  assert.match(composerRow, /<AttachmentTile/)
})

test('本地文件卡：路径经统一解析，动作前先确认文件存在', () => {
  const bubble = read('components/MessageBubble.vue')
  assert.match(bubble, /extractFilePaths\(src\.value, roots, session\.cwd, 8\)/)
  assert.doesNotMatch(bubble, /p\.length < 8/)
  const inline = read('components/FileInline.vue')
  assert.match(inline, /async function fileExists/)
  assert.match(inline, /文件不在手机上（可能已被移动或删除）/)
  assert.match(inline, /window\.CoomiAndroid\?\.saveFileData/)
  assert.match(inline, /downloadAndSave/)
})

test('正文图片可点开统一查看器', () => {
  const bubble = read('components/MessageBubble.vue')
  assert.match(bubble, /closest\?\.\('\.md img'\)/)
  assert.match(bubble, /<MediaViewer v-if="viewerSrc"/)
  const viewer = read('components/MediaViewer.vue')
  assert.match(viewer, /toggleZoom/)
  assert.match(viewer, /dragY\.value > 96/)
})

test('底部弹层过渡已进全局（查看全部不再硬挂硬摘）', () => {
  const css = read('styles/global.css')
  assert.match(css, /\.sheet-pop-enter-active \{ transition: opacity 200ms/)
  assert.match(css, /\.sheet-pop-enter-active \.reader/)
})

test('目录语义：会话 cwd 与项目根分开，冷启动不用根目录回填', () => {
  const chat = read('views/ChatView.vue')
  assert.doesNotMatch(chat, /if \(!session\.cwd\) session\.cwd = h\.cwd/)
  const sessionStore = read('stores/session.ts')
  assert.doesNotMatch(sessionStore, /sessions\.setCurrentCwd\(path\)/)
  assert.doesNotMatch(sessionStore, /sessions\.setCurrentCwd\(session\.cwd\)/)
  // 新建会话的 meta 不再拿项目根当会话目录。
  const sessionsStore = read('stores/sessions.ts')
  assert.match(sessionsStore, /cwd: undefined, mode: 'agent'/)
})

test('侧栏：恢复「对话」分组 + 折叠栏有底色描边 + 面板与对话页不同色', () => {
  const drawer = read('components/SideDrawer.vue')
  assert.match(drawer, /label: '对话'/)
  assert.match(drawer, /cwd\.startsWith\(root \+ '\/'\)/)
  // 分组头不再套描边方框（dsh-go 同款）：只留一行标签，靠留白分组。
  assert.doesNotMatch(drawer, /\.ghead \{[\s\S]{0,300}?border: 1px solid var\(--border\)/)
  assert.match(drawer, /\.ghead \{[\s\S]*?background: transparent/)
  assert.match(drawer, /\.drawer-root \.panel \{[\s\S]*?background: var\(--page\)/)

  const chat = read('views/ChatView.vue')
  // 常驻挂载：挂载即带 open 类会让 opacity 没有起始帧（「阴影直接附上去」）。
  assert.match(chat, /<div ref="veilEl" class="drawer-veil" aria-hidden="true" \/>/)
  assert.match(chat, /\.chat > \.drawer-veil \{[\s\S]*?opacity: 0;/)
  assert.match(chat, /transition: opacity \.34s cubic-bezier\(\.22, \.68, \.19, 1\),/)
  // 暗色：模糊随滑动进度加深（--drawer-blur 0 → 7px），不是落定后突然出现。
  // 只保留 blur；亮/暗都生效。压暗交给 veil，避免收尾撤规则时亮度回弹。
  assert.match(chat, /filter: blur\(var\(--drawer-blur, 0px\)\);/)
  assert.doesNotMatch(chat, /filter: blur\(var\(--drawer-blur, 0px\)\) saturate/)
  assert.match(chat, /\.chat\.drawer-open \{[^}]*--drawer-blur: 7px; \}/)
  assert.match(chat, /\.chat\.drawer-open \{ --drawer-blur: 7px; \}/)
  assert.match(chat, /chatRootEl\.value\?\.style\.setProperty\('--drawer-blur'/)
  const css = read('styles/global.css')
  assert.match(css, /@property --drawer-blur/)
  // 卡片与压暗层同一圆角几何：左上/左下 36，右侧直角。
  assert.match(chat, /border-radius: 36px 0 0 36px;/)
  assert.match(chat, /drawerTransform\(p\)/)
  // 侧栏面板不再自带右边框（会在卡片左上圆角上方露成一条竖线）。
  assert.doesNotMatch(drawer, /border-right: 1px solid var\(--border\)/)
})

test('移入分组是二级 sheet，不在主菜单里铺开全部分组', () => {
  const drawer = read('components/SideDrawer.vue')
  assert.match(drawer, /@click="openGroupPicker"/)
  assert.match(drawer, /v-if="groupPickerFor"/)
  assert.match(drawer, /class="cm-sheet-root is-open cm-sheet-root--sub"/)
  assert.doesNotMatch(drawer, /v-for="group in manualGroups"[\s\S]{0,200}移动到「/)
})

test('输入框离散高度档 + 跨档滚动补偿；删除 scrollIntoView', () => {
  const composer = read('components/Composer.vue')
  assert.match(composer, /const INPUT_LINE_TIERS = \[1, 2, 3, 4, 5\]/)
  assert.match(composer, /coomi:composer-resized/)
  assert.doesNotMatch(composer, /scrollIntoView\(\{ block: 'nearest' \}\)/)
  // dock 跟键盘/面板收起，且不再做 FLIP。
  assert.match(composer, /dockCollapsed = computed\(\(\) => bottomBusy\.value \|\| trayState\.open\)/)
  assert.match(composer, /bottomBusy = computed\(\(\) => panelActive\.value \|\| panelBusy\.value \|\| keyboardVisible\.value\)/)
  assert.match(composer, /\.dock-slot \{[\s\S]*?grid-template-rows: 1fr/)
  assert.match(composer, /class="dock-slot"/)

  const view = read('views/ChatView.vue')
  assert.match(view, /window\.addEventListener\('coomi:composer-resized', onComposerResized\)/)
})

test('加号面板与键盘：键盘先退、面板接管，输入栏只按高度差落位', () => {
  const composer = read('components/Composer.vue')
  // 展开必须收起键盘（不再出现「面板与输入法同屏」）。
  assert.match(composer, /function openQuick\(\)/)
  assert.match(composer, /textarea\.value\?\.blur\(\)/)
  // 高度由纯函数驱动，不再是 grid 0fr→1fr 的 CSS 过渡。
  assert.match(composer, /handoffFrame\(\{/)
  assert.match(composer, /panelSlotH\.value = frame\.panelH/)
  assert.match(composer, /nativeReserve: native, elapsed, holdMs, adjustMs, holdDone/)
  assert.match(composer, /class="quick-slot"/)
  assert.match(composer, /\.quick-slot \{[\s\S]*?height: 0;/)
  assert.doesNotMatch(composer, /quick-drop-/)
  // 点输入框：面板让位、键盘回来。
  assert.match(composer, /closeQuick\(\{ focus: true \}\)/)
  // 键盘高度由原生推送（安卓垫高时 visualViewport 差值为 0）。
  const insets = read('utils/keyboardInset.ts')
  assert.match(insets, /nativeImeInset/)
  assert.match(insets, /__coomiImeInset/)
  const activity = readFileSync(new URL('../../coomi-app/app/src/main/java/com/termux/app/CoomiActivity.java', import.meta.url), 'utf8')
  assert.match(activity, /__coomiImeInset/)
  assert.match(activity, /getImeInsetCss/)
})

test('工具次数不设上限：设置页不再有三档，协议按兜底文案展示', () => {
  // 设置首页只剩入口；这条说明跟着「思考强度」搬到了 AI 设置页。
  const settings = read('views/settings/AiSettingsView.vue')
  assert.doesNotMatch(settings, /\[192, 256, 512\]/)
  assert.match(settings, /工具调用不设次数上限/)
  assert.doesNotMatch(read('views/SettingsView.vue'), /\[192, 256, 512\]/)

  const chat = read('views/ChatView.vue')
  assert.match(chat, /tool_round_ceiling/)
  assert.match(chat, /turn_budget/)
  assert.doesNotMatch(chat, /rc\.reason === 'tool_round_limit'/)
})

test('跨网：配对码带中继快照，失败原因四档可解释', () => {
  const device = read('stores/device.ts')
  assert.match(device, /function classifyIrohFailure/)
  assert.match(device, /配对时没有连上中继/)
  assert.match(device, /配对令牌已失效/)
  assert.match(device, /中继或打洞没有打通/)
  assert.match(device, /电脑端引擎没有应答/)
  assert.match(device, /parsed\.iroh\?\.mode === 'direct'/)
})
