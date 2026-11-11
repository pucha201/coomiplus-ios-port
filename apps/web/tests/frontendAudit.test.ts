import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import test from 'node:test'

/**
 * 手机页面试用审计里发现的「错位 / 缺失 / 误导」回归契约。
 * 这些都是布局与文案层面的真实缺陷，组件单测抓不到；用源码契约锁住。
 */
const read = (path: string) => readFile(new URL('../' + path, import.meta.url), 'utf8')

test('连接条改悬浮胶囊：不再占流内高度，页面不被打下去', async () => {
  const banner = await read('src/components/ConnectionBanner.vue')
  // v3 把 28px 流内占位彻底删掉：细条改纯 fixed 浮层，重连时整页不再往下移。
  assert.match(banner, /position: fixed/)
  assert.doesNotMatch(banner, /class="conn-space"/)

  // 对应的全局偏移规则也一并删除。
  const globalCss = await read('src/styles/global.css')
  assert.doesNotMatch(globalCss, /#app:has\(> \.banner\) \.drawer-root \.panel \{ top: 28px; \}/)
})

test('本地抽屉不再同时给出「全局对话」和「还没有历史会话」', async () => {
  const drawer = await read('src/components/SideDrawer.vue')
  // v4 把本地/云端选择整条隐藏（能力保留、UI 移除），空态文案不再需要区分模式。
  // 关键是「空态存在但不与常驻的全局对话行冲突」这条不变量仍然成立。
  assert.match(drawer, /const isEmpty = computed\(\(\) => sessions\.flat\.length === 0\)/)
  assert.match(drawer, /v-if="isEmpty" class="empty-sm"/)
})

test('没有重连上限时不写成「第 N/0 次重连」', async () => {
  const store = await read('src/stores/connection.ts')
  // retryMax 缺省是 0（云端降级链不报上限）：只有 >0 才拼 N/M，否则只报当前第几次。
  assert.match(store, /retryMax\.value > 0\s*\n\s*\? `第 \$\{retryAttempt\.value\}\/\$\{retryMax\.value\} 次重连`\s*\n\s*: `第 \$\{retryAttempt\.value\} 次重连`/)
  assert.doesNotMatch(store, /retryMessage\.value = `第 \$\{retryAttempt\.value\}\/\$\{retryMax\.value\}/)
})

test('首页空态布局交回 ChatView：vendor 不再用 !important 顶偏主标题', async () => {
  const css = await read('vendor/rc33-ui/coomi-cloud.css')
  assert.doesNotMatch(css, /\.chat \.empty-center \{/)
  assert.doesNotMatch(css, /\.chat \.empty-center \.empty-sm \{/)
  assert.doesNotMatch(css, /align-items: flex-start !important/)
  assert.doesNotMatch(css, /\.cm-switch--home/)
  assert.doesNotMatch(css, /\.cm-switch--side/)
})

test('模式切换入口只在输入框下方 dock chip，不在 vendor 注入层', async () => {
  const js = await read('vendor/rc33-ui/coomi-cloud.js')
  assert.doesNotMatch(js, /mountHomeSwitch/)
  assert.doesNotMatch(js, /\.cm-switch--home/)
  assert.doesNotMatch(js, /\.cm-switch--side/)
  assert.match(js, /function setMode\(/)
  assert.match(js, /function sheetDevices\(/)
})

test('真实桥的添加设备表单只认完整连接码，不再先弹 6 格短码', async () => {
  const js = await read('vendor/rc33-ui/coomi-cloud.js')
  assert.match(js, /var real = !!\(B && B\.addDevice\)/)
  assert.match(js, /\(real \? '' :[\s\S]{0,140}cm-code/)
  assert.match(js, /if \(!real\) setTimeout/)
  assert.doesNotMatch(js, /连接同一账号/)
})

test('生成落定不再切渲染路径：单一滚动权威 + 保留回到底部入口', async () => {
  const scroll = await read('src/composables/useAutoScroll.ts')
  // 脱离跟随只认手势：程序性 scrollTop 变化（懒测量、插件补偿）不再被误判成「用户上滑」。
  assert.match(scroll, /const GESTURE_TAIL_MS = 1500/)
  assert.match(scroll, /if \(performance\.now\(\) - lastGestureAt > GESTURE_TAIL_MS\) return/)
  // 内容变高只走 rAF 合并的一次贴底。
  assert.match(scroll, /function requestFollow\(\)/)

  const chat = await read('src/views/ChatView.vue')
  // 生成中与落定后都走同一个 DynamicScroller：揭幕门只控制可见性，不换渲染树。
  assert.match(chat, /async function revealWhenSettled/)
  assert.match(chat, /stream-hidden/)
  assert.doesNotMatch(chat, /function settleFollow/)
  // 回到底部并入右侧历史转盘（@latest），屏幕正中不再放第二颗按钮。
  assert.match(chat, /@latest="jumpToBottom\(\)"/)
  assert.doesNotMatch(chat, /class="to-bottom"/)
})

test('连接状态只在顶部报一次，输入栏不再挂「消息没有发出」', async () => {
  const composer = await read('src/components/Composer.vue')
  assert.doesNotMatch(composer, /class="conn-banner"/)
  assert.doesNotMatch(composer, /\.conn-banner \{/)
})

test('骨架屏四种变体都有真实布局，加载态不会塌成空白', async () => {
  const sk = await read('src/components/ui/UiSkeleton.vue')
  for (const selector of ['.sk { display: block; }', '.sk-row {', '.sk-body {', '.sk-card {', '.sk-msg {']) {
    assert.ok(sk.includes(selector), `missing ${selector}`)
  }
})

test('后台任务完成通知不再自带第二个勾', async () => {
  const store = await read('src/stores/session.ts')
  assert.doesNotMatch(store, /✓ 后台任务/)
  assert.doesNotMatch(store, /✕ 后台任务/)
})

test('/files 收到非 JSON 时不把空对象当列表，骨架不会永挂', async () => {
  const view = await read('src/views/FileManagerView.vue')
  // 引擎不在线时同源可能回落到 HTML 200；JSON.parse 失败必须抛错，而不是返回 {}。
  assert.match(view, /电脑端返回了非 JSON 响应/)
  // 列表响应必须校验结构，否则 path 被赋成 undefined，crumbs 计算属性每帧抛错。
  assert.match(view, /typeof data\.path !== 'string'/)
  assert.match(view, /Array\.isArray\(data\.entries\)/)
  // 加载失败时不能再同时显示「空目录」。
  assert.match(view, /v-else-if="!entries\.length && !error"/)
})

test('vendor 弹层随路由切换自动关闭，不盖住新页面', async () => {
  const router = await read('src/router/index.ts')
  assert.match(router, /router\.afterEach/)
  assert.match(router, /__coomiCloudApi\?\.closeSheet/)
  const vendor = await read('vendor/rc33-ui/coomi-cloud.js')
  assert.match(vendor, /closeSheet: function \(\) \{ closeSheet\(true\); \}/)
})

test('云端没选电脑时页面不说「请求没有发出」，目录页错误与空态不并存', async () => {
  const http = await read('src/bridge/http.ts')
  assert.match(http, /throw new Error\('云端模式还没有选择电脑'\)/)
  assert.doesNotMatch(http, /throw new Error\('云端未连接电脑：请求没有发出'\)/)
  const catalog = await read('src/views/CatalogView.vue')
  assert.match(catalog, /!loading && !error && visibleMcp\.length === 0/)
  assert.match(catalog, /!loading && !error && visibleSkills\.length === 0/)
})

test('加载失败时不再同时给出「暂无数据」空态（记忆/日记/工作流）', async () => {
  const lm = await read('src/views/LifeMemoryView.vue')
  assert.match(lm, /entries\.length === 0 && !loading && !error/)
  const lj = await read('src/views/LifeJournalView.vue')
  assert.match(lj, /filtered\.length === 0 && !loading && !error/)
  const wf = await read('src/views/WorkflowView.vue')
  assert.match(wf, /workflows\.length === 0 && !error/)
  const mv = await read('src/views/MemoryView.vue')
  assert.match(mv, /const loadFailed = ref\(false\)/)
  assert.match(mv, /!memories\.length && !loadFailed/)
})

test('清理与用量页不把「Error: 」前缀漏给用户，失败时不显示暂无记录', async () => {
  const m = await read('src/views/MaintenanceView.vue')
  assert.match(m, /const errText = \(e: unknown\) => \(e instanceof Error \? e\.message : String\(e\)\)/)
  assert.doesNotMatch(m, /error\.value = String\(e\)/)
  const u = await read('src/views/UsageView.vue')
  assert.match(u, /error\.value=e instanceof Error\?e\.message:String\(e\)/)
  assert.match(u, /!data\.records\.length && !error/)
})

test('引擎请求的兜底文案不说「GET /path → 404」，排障信息只留在 console', async () => {
  const http = await read('src/bridge/http.ts')
  assert.match(http, /function requestError\(r: Response, method: string, path: string, data: any\): Error \{/)
  assert.match(http, /console\.warn\(`\[coomi\] \$\{method\} \$\{path\} → HTTP \$\{r\.status\}`\)/)
  assert.match(http, /请求失败（HTTP \$\{r\.status\}）/)
  assert.doesNotMatch(http, /`GET \$\{path\} → \$\{r\.status\}`/)
  assert.doesNotMatch(http, /`\$\{method\} \$\{path\} → \$\{r\.status\}`/)
})

test('200 + HTML 不当成成功、结构不对不当成空态：群聊 API 与目录页', async () => {
  const group = await read('src/features/collab-chat/api/groupChatApi.ts')
  assert.match(group, /let isJson = true/)
  assert.match(group, /if \(!isJson\) throw new Error\(`电脑端返回了非 JSON 响应/)
  assert.doesNotMatch(group, /throw new Error\(data\.error \?\? data\.message \?\? `HTTP \$\{res\.status\}`\)/)
  const catalog = await read('src/views/CatalogView.vue')
  assert.match(catalog, /let isJson = true/)
  assert.match(catalog, /if \(!isJson\) throw new Error\(`电脑端返回了非 JSON 响应/)
  // 目录/已安装列表都必须校验数组结构，否则连接问题会伪装成「暂无 MCP」。
  assert.match(catalog, /if \(!Array\.isArray\(data\.mcp\) \|\| !Array\.isArray\(data\.skills\)\) \{\n\s*throw new Error\('目录响应格式不对/)
  assert.match(catalog, /throw new Error\('已安装列表响应格式不对/)
  assert.doesNotMatch(catalog, /if \(!res\.ok\) throw new Error\(`HTTP \$\{res\.status\}`\)/)
})

test('写操作不再有假成功（自定义 MCP / 钩子 / 遥测 / 记忆 / 本地 Skill 列表）', async () => {
  const catalog = await read('src/views/CatalogView.vue')
  // 保存自定义 MCP 必须解析响应：引擎掉线时 PUT 会以 200 + HTML 回来，不解析就显示「已保存」。
  assert.match(catalog, /body: JSON\.stringify\(\{ servers \}\),\n\s*\}\)\n[\s\S]{0,160}await parseRes\(res\)/)
  const hooks = await read('src/views/HooksView.vue')
  assert.match(hooks, /if \(!text\.trim\(\)\.startsWith\('\{'\) && text\.trim\(\) !== ''\) \{/)
  assert.match(hooks, /保存失败（HTTP \$\{response\.status\}）/)
  // 设置首页现在只有入口；读写 http 的兜底在通用设置子页里。
  const settings = await read('src/views/settings/GeneralSettingsView.vue')
  assert.match(settings, /if \(data === null\) throw new Error\(`电脑端返回了非 JSON 响应/)
  assert.match(settings, /设置失败（HTTP \$\{res\.status\}）/)
  const mv = await read('src/views/MemoryView.vue')
  assert.doesNotMatch(mv, /authedFetch/)
  // 记忆按会话 cwd 读取：URL 带 ?session_id=，但依然是 apiGet/apiSend（失败会抛，不静默）。
  assert.match(mv, /await apiGet<\{ memories\?: MemoryItem\[\] \}>\(`\/api\/memory/)
  assert.match(mv, /apiSend<\{ deleted\?: boolean \}>/)
  const composer = await read('src/components/Composer.vue')
  assert.match(composer, /apiGet<\{ skills\?: Array<\{ name: string; description: string \}> \}>\('\/api\/local-model\/skills-list'\)/)
  assert.doesNotMatch(composer, /authedFetch\('\/api\/local-model\/skills-list'\)/)
})

test('新建对话会创建并绑定自己的幕布目录（旧机制）', async () => {
  const store = await read('src/stores/session.ts')
  // 新会话必须主动调 /workspace，把 <根目录>/<session-id> 建出来并写回 cwd。
  assert.match(store, /void ensureSessionWorkspace\(nextId\)/)
  assert.match(store, /\/api\/sessions\/\$\{id\}\/workspace/)
  assert.match(store, /cwd\.value = path/)
  assert.match(store, /meta\.cwd = path/)
  // 项目根（用于分组）不能被会话目录覆盖：那会让「对话」分组消失、侧栏目录显示错。
  assert.doesNotMatch(store, /sessions\.setCurrentCwd\(path\)/)
  assert.doesNotMatch(store, /sessions\.setCurrentCwd\(session\.cwd\)/)
})

test('互联功能已隐藏：/home /im /collab 全部 redirect 回首页', async () => {
  // v3 把「协同工作台 / 群聊首页」入口整条摘掉，对应路由改成 redirect。
  // 之前这条测试锁的是「/im 挂 GroupHomeView」——那个前提已经被产品决策推翻，
  // 现在锁的是「这些路径进不去，一律回 /」。GroupHomeView 组件本身保留，
  // 只是不再有路由指向它。
  const router = await read('src/router/index.ts')
  assert.match(router, /path: '\/home', redirect: '\/'/)
  assert.match(router, /path: '\/im', redirect: '\/'/)
  assert.match(router, /path: '\/im\/:roomId', redirect: '\/'/)
  assert.match(router, /path: '\/collab[^']*', redirect: '\/'/)
  assert.doesNotMatch(router, /features\/group\/views\/GroupHomeView\.vue/)

  // 组件本身的错误态处理仍要保留（将来若恢复入口，那条链路不能退化成「还没有群聊」）。
  const api = await read('src/features/group/api.ts')
  assert.match(api, /let isJson = true/)
  assert.match(api, /if \(!isJson\) throw new Error\(`电脑端返回了非 JSON 响应/)
  const view = await read('src/features/group/views/GroupHomeView.vue')
  assert.match(view, /if \(!store\.error\) \{\n\s*if \(!store\.activeProject\) \{\n\s*setupOpen\.value = true/)
})

test('非 JSON 兜底文案全站统一说「电脑端」，不再一会儿「引擎」一会儿「电脑端」', async () => {
  const files = [
    'src/bridge/http.ts',
    'src/views/FileManagerView.vue',
    'src/views/CatalogView.vue',
    'src/features/group/api.ts',
    'src/features/collab-chat/api/groupChatApi.ts',
    'src/views/HooksView.vue',
    'src/views/settings/GeneralSettingsView.vue',
  ]
  for (const f of files) {
    const text = await read(f)
    assert.match(text, /电脑端返回了非 JSON 响应/, f + ' 缺少统一兜底文案')
    assert.doesNotMatch(text, /引擎返回了非 JSON 响应/, f + ' 仍在用「引擎」这种内部说法')
  }
})

test('列表拉失败时角标不谎报「0」', async () => {
  const group = await read('src/features/group/views/GroupHomeView.vue')
  assert.match(group, /v-if="store\.homeTab === 'messages' && !store\.error"/)
  assert.match(group, /v-else-if="store\.homeTab === 'me'">独立群聊空间/)
  assert.doesNotMatch(group, /<p v-else>独立群聊空间<\/p>/)
  const catalog = await read('src/views/CatalogView.vue')
  assert.match(catalog, /<span v-if="!loading && !error" class="cnt">\{\{ mcpCount \}\}<\/span>/)
  assert.match(catalog, /<span v-if="!loading && !error" class="cnt">\{\{ skillsCount \}\}<\/span>/)
})

test('引擎端点跨重启复用：换端口就是换 WebView origin，设备列表会整块读不到', async () => {
  const service = await read('../coomi-app/app/src/main/java/app/coomi/CoomiService.java')
  assert.match(service, /private static final String ENGINE_PREFS = "coomi_engine_endpoint"/)
  assert.match(service, /private int persistedEnginePort\(\)/)
  assert.match(service, /private void persistEngineEndpoint\(int port, String token\)/)
  // 两条启动路径（JNI / 子进程）都要落盘
  const persists = service.match(/persistEngineEndpoint\(port, token\);/g) ?? []
  assert.ok(persists.length >= 2, 'JNI 与子进程路径都要持久化端点')
  // 上个进程留下的健康引擎要认领，不许另挑端口
  assert.match(service, /Adopted engine already listening on port/)
  // 端口真的变了要留下证据
  assert.match(service, /Engine port changed[\s\S]*WebView origin changes/)
})

test('在线判据：活跃通道 open 就直接判在线，不再用附加 HTTP 请求推翻它', async () => {
  const device = await read('src/stores/device.ts')
  assert.match(device, /import \{ readTransportDiag \} from '@\/utils\/transportAttribution'/)
  assert.match(device, /const live = readTransportDiag\(\)/)
  assert.match(device, /if \(mode\.value === 'cloud' && live\?\.state === 'open'\) \{/)
  // 该分支必须在 LAN 探测之前返回
  const openIdx = device.indexOf("live?.state === 'open'")
  const lanIdx = device.indexOf('const lanStatus = await client.getEngineStatus()')
  assert.ok(openIdx > 0 && lanIdx > openIdx, '通道 open 的分支必须排在 LAN 探测之前')
})

test('switch_session 只在宿主腿上发：LAN/本机直连对端是引擎，不认识这条命令', async () => {
  const transport = await read('src/bridge/transport.ts')
  assert.match(transport, /readonly hostCommands\?: boolean/)
  assert.match(await read('src/bridge/wsTransport.ts'), /readonly hostCommands = false/)
  assert.match(await read('src/bridge/directTransport.ts'), /readonly hostCommands = false/)
  assert.match(await read('src/bridge/demoTransport.ts'), /readonly hostCommands = false/)
  const index = await read('src/bridge/index.ts')
  // WebRTC/MQTT 宿主腿已整体移除：现在没有任何内置传输层声明自己是宿主腿，
  // 所以 switch_session 一律不发（对端就是引擎）。
  assert.doesNotMatch(index, /hostCommands = true/)
  assert.doesNotMatch(index, /get hostCommands/)
  const session = await read('src/stores/session.ts')
  assert.match(session, /isCloudConnectionMode\(\) && t\.hostCommands !== false\) t\.send\(\{ command: 'switch_session'/)
  const guarded = session.match(/previous\.hostCommands !== false/g) ?? []
  assert.ok(guarded.length >= 2, 'newSession / activate 两处都要按腿判断')
})

test('补加载不再被静默吞掉：模型列表失败留在队列里，退避重试', async () => {
  const config = await read('src/stores/config.ts')
  assert.match(config, /async function fetchProviders\(\): Promise<boolean>/)
  assert.match(config, /return false/)
  const context = await read('src/composables/useConnectionContext.ts')
  assert.match(context, /const providersLoaded = await config\.fetchProviders\(\)/)
  assert.match(context, /if \(!providersLoaded\) throw new Error\('模型列表未同步'\)/)
  const hydration = await read('src/utils/hydration.ts')
  assert.match(hydration, /const RETRY_BASE_MS = 3_000/)
  assert.match(hydration, /function scheduleRetry\(\): void/)
  assert.match(hydration, /if \(pending\.size > 0\) scheduleRetry\(\)/)
})

test('空响应不再当成功：查询接口拿到空 body 要报错', async () => {
  const http = await read('src/bridge/http.ts')
  assert.match(http, /if \(allowEmpty\) return \{\}/)
  assert.match(http, /电脑端返回了空响应（HTTP \$\{response\.status\}）/)
  // 写操作允许空 body
  assert.match(http, /const data = await parseJson\(r, true\)/)
  // 模型列表空态要把原因说出来
  const composer = await read('src/components/Composer.vue')
  assert.match(composer, /config\.lastError \? `模型列表没拉到：\$\{config\.lastError\}`/)
})

test('手机端会话列表扁平化；桌面端仍按工作目录分组', async (t) => {
  const phone = await read('src/stores/sessions.ts')
  // 引擎给每个会话的 cwd 不同，按目录分 → 一个会话一个折叠栏。
  // 主列表排除归档（归档走侧栏「已归档」二级页）。
  assert.match(phone, /const flat = computed<SessionMeta\[\]>\(\(\) => filtered\.value\.filter\(m => !m\.archived\)\)/)
  assert.match(phone, /const archived = computed<SessionMeta\[\]>\(\(\) => filtered\.value\.filter\(m => m\.archived\)\)/)
  assert.doesNotMatch(phone, /groupSessionsByWorkspace\(filtered\.value/)
  assert.match(await read('src/components/SideDrawer.vue'), /v-for="m in sessions\.flat"/)
  assert.match(await read('src/views/SessionsView.vue'), /v-for="m in sessions\.flat"/)
  const shared = await read('src/utils/sessionGroups.ts')
  assert.match(shared, /export function groupSessionsByWorkspace/)
  // 只分发手机源码的工作树里没有桌面工程，这部分契约在这里无法断言
  if (!existsSync(new URL('../desktop-ui-react/src/stores/workspace.ts', import.meta.url))) {
    return t.skip('桌面源码不在当前工作树')
  }
  const desktop = await read('../desktop-ui-react/src/stores/workspace.ts')
  assert.match(desktop, /import \{ groupSessionsByWorkspace \} from '\.\.\/\.\.\/\.\.\/web\/src\/utils\/sessionGroups'/)
  assert.match(desktop, /return groupSessionsByWorkspace\(sessions, \{/)
})

test('桌面「在线」不只看 last_seen：宿主通道活着就是在线（中转时代发命令不刷新 last_seen）', async (t) => {
  if (!existsSync(new URL('../desktop-ui-react/src/lib/peerActions.ts', import.meta.url))) {
    return t.skip('桌面源码不在当前工作树')
  }
  const peerActions = await read('../desktop-ui-react/src/lib/peerActions.ts')
  assert.match(peerActions, /const connected = host\?\.transport === 'direct' \|\| host\?\.transport === 'relay'/)
  assert.match(peerActions, /\(connected \|\| peer\.online\) \? '在线' : '离线'/)
})

test('互联只剩 iroh + 局域网：WebRTC/MQTT 死链已移除，失败仍可归因', async () => {
  const index = await read('src/bridge/index.ts')
  // 死代码不能再回来：它们比 iroh 多一跳、依赖公共 broker，已整体移除。
  assert.doesNotMatch(index, /RemoteFallbackTransport/)
  assert.doesNotMatch(index, /MqttRelayTransport/)
  // 剩下的两条腿都在自己的传输层里带重连；bridge 不再维护一份待发队列。
  assert.doesNotMatch(index, /queuePending/)
  // 失败归因与冷却（不再「两次失败整会话放弃」）。
  const device = await read('src/stores/device.ts')
  assert.match(device, /function classifyIrohFailure/)
  assert.match(device, /IROH_COOLDOWN_MS/)
  assert.match(device, /relay_pending/)
})

test('引擎认领必须验令牌：health 免认证，谁占着端口都能回 200', async () => {
  const service = await read('../coomi-app/app/src/main/java/app/coomi/CoomiService.java')
  assert.match(service, /private boolean verifyEngineToken\(int port, String token\)/)
  assert.match(service, /\/api\/sessions/)
  assert.match(service, /&& verifyEngineToken\(storedPort, storedTokenForAdopt\)/)
  assert.match(service, /rejected the persisted token; refusing to adopt/)
})

test('转场照搬 DeepSeek：1.7% 微位移 + 盖子按抽屉宽度整幅推开', async () => {
  const app = await read('src/App.vue')
  assert.match(app, /\.page-forward-enter-from \{ opacity: 0; transform: translateX\(1\.7%\); \}/)
  assert.match(app, /\.page-back-leave-to \{ opacity: 0; transform: translateX\(1\.7%\); \}/)
  assert.match(app, /cubic-bezier\(0\.05, 0, 0\.133, 1\)/)
  const rc33 = await read('vendor/rc33-ui/compat-rc104.css')
  // 圆角只跟开关态（data-lid），不逐帧 calc：逐帧算圆角 + 40px 模糊阴影是展开卡顿主因
  assert.match(rc33, /\.chat\[data-lid\] > \.shell \{\s*border-radius: 36px 0 0 36px;/)
  const drawer = await read('vendor/rc33-ui/coomi-drawer.js')
  // 位移必须等于抽屉面板宽度（露出右侧约 20% 对话页）。
  // 曾经写成 v*W*0.7 再叠 scale(1-0.06v)，既只推开一半、又整页逐帧重栅格化。
  assert.match(drawer, /translate3d\(' \+ \(v \* W\)\.toFixed\(2\)/)
  assert.doesNotMatch(drawer, /v \* W \* 0\.7/)
  assert.doesNotMatch(drawer, /scale\(' \+ \(1 - 0\.06 \* v\)/)
})

test('安卓返回：浮层先关，对话页「再按一次」才退出，不再沿 hash 历史乱跳', async () => {
  const nav = await read('src/bridge/navigation.ts')
  // 浮层（工具详情/用量面板/输入区面板）优先消费返回。
  assert.match(nav, /if \(closeTopOverlay\(\)\) return true/)
  // 对话页第一次返回只提示，2 秒内第二次才真的退出。
  assert.match(nav, /const EXIT_CONFIRM_MS = 2000/)
  assert.match(nav, /exitArmedAt > 0 && now - exitArmedAt <= EXIT_CONFIRM_MS/)
  assert.match(nav, /再按一次返回退出/)
  const activity = await read('../coomi-app/app/src/main/java/com/termux/app/CoomiActivity.java')
  assert.match(activity, /"exit"\.equals\(value\)/)
  assert.match(activity, /finishAffinity\(\);/)
})

test('root 授权后给引擎补 su 转发脚本并做可用性自检', async () => {
  const launcher = await read('../coomi-app/app/src/main/java/app/coomi/CoomiLauncherActivity.java')
  assert.match(launcher, /private boolean installRootShellShim\(\)/)
  assert.match(launcher, /RootShellShim\.install\(this\)/)
  assert.match(launcher, /case GRANTED:[\s\S]*?installRootShellShim\(\)/)
  assert.match(launcher, /probeRootBridge\(mRootCheckGeneration\)/)
  const shim = await read('../coomi-app/app/src/main/java/app/coomi/RootShellShim.java')
  assert.match(shim, /BACKUP_NAME = "su\.coomi-stock\.bak"/)
  assert.match(shim, /\/data\/adb\/ksu\/bin\/su/)
})

test('模型上下文窗口保存前夹紧到 32000..1048576', async () => {
  const config = await read('src/stores/config.ts')
  assert.match(config, /const CONTEXT_MAX = 1_048_576/)
  assert.match(config, /function clampContextWindow\(value: number \| undefined\)/)
  assert.match(config, /contextWindow: clampContextWindow\(input\.contextWindow\)/)
  assert.match(config, /modelContextWindows: clampContextMap\(input\.modelContextWindows\)/)
})

test('表格卡片：复制/查看 + 横向滚动 + 全屏查看', async () => {
  const md = await read('src/utils/markdown.ts')
  assert.match(md, /function enhanceTables\(doc: Document\)/)
  assert.match(md, /button\.setAttribute\('data-md-table', kind\)/)
  const bubble = await read('src/components/MessageBubble.vue')
  assert.match(bubble, /function onMdClick\(event: MouseEvent\)/)
  assert.match(bubble, /class="md-table-full"/)
  const css = await read('src/styles/global.css')
  assert.match(css, /\.md \.md-table \{/)
  assert.match(css, /\.md-table-scroll \{ overflow-x: auto;/)
})

test('切会话不再闪：幕布后落定再揭幕 + 折叠栏生成中可点 + 工具卡定高滚动', async () => {
  const chat = await read('src/views/ChatView.vue')
  // 换会话不做 opacity 淡入：内容与测量都在 visibility:hidden 的幕布后完成，再一次性揭幕。
  assert.match(chat, /\.stream\.stream-hidden \{ visibility: hidden; \}/)
  assert.match(chat, /async function revealWhenSettled/)
  assert.doesNotMatch(chat, /\.stream\.fading/)
  const process = await read('src/components/ProcessBlock.vue')
  // v2 回到「生成中由 live 强制展开、用户点过就听用户」的双轨语义，
  // 折叠态权威仍是 processOpenState（模块级，滚出视口不丢）。
  assert.match(process, /const open = computed\(\(\) => props\.live \? !userClosed\.value : processOpenState\.get/)
  assert.match(process, /processOpenState\.set/)
  const card = await read('src/components/ToolCardItem.vue')
  // 输出区默认 40vh 限高 + 内部滚动；「展开全部」用 .out.full 真正解除上限。
  assert.match(card, /\.out \{ max-height: 40vh; overflow: auto;/)
  assert.match(card, /\.out\.full \{ max-height: none;/)
})

test('底部只留一个悬浮键；侧栏手势与按钮尺寸', async () => {
  const chat = await read('src/views/ChatView.vue')
  assert.doesNotMatch(chat, /class="to-bottom"/)
  // v3 把回到底部圆钮再下移一档（104 → 116）。
  // v4 改成跟随输入栏实际高度（--composer-h 由 Composer 的 ResizeObserver 写入），
  // 键盘抬起 / 错误条出现时圆钮会自己让位，不再是写死的一个数字。
  assert.match(await read('src/components/HistoryDial.vue'), /bottom: calc\(env\(safe-area-inset-bottom, 0px\) \+ var\(--composer-h, 96px\) \+ 8px\)/)
  // 手势要真正可用：manipulation 会把横向拖拽判给浏览器手势，抽屉就再也滑不开；
  // pan-y 只封竖屏缩放歧义，横滑交给我们的跟手指令。
  assert.match(chat, /\.chat, \.stream \{ touch-action: pan-y; \}/)
  // 表格这类横向滚动容器必须显式放开两轴，否则祖先的 touch-action 会把横滚封死（缺陷 13）
  assert.match(chat, /\.md-table-scroll, \.md-table-full-body, \.md > table \{ touch-action: auto;/)
  const drawer = await read('vendor/rc33-ui/coomi-drawer.js')
  assert.match(drawer, /setPointerCapture\(pointerId\)/)
  // 位移只走内联 transform；不再逐帧写 --cp-f（那是展开卡顿的主因）
  assert.match(drawer, /shell\.style\.setProperty\('transform', shellTf, 'important'\)/)
  assert.doesNotMatch(drawer, /style\.setProperty\('--cp-f'/)
  // 圆角/阴影改开关态：由 data-lid 触发
  assert.match(drawer, /setAttribute\('data-lid', '1'\)/)
  const side = await read('src/components/SideDrawer.vue')
  assert.match(side, /\.drawer-root \.dfoot \{\s*display: flex; align-items: stretch; flex: none;/)
  assert.match(side, /\.drawer-root \.nicon \{ width: 34px; height: 34px; \}/)
})

test('顶栏压缩：46px + 标题最多半屏', async () => {
  const top = await read('src/components/TopBar.vue')
  assert.match(top, /min-height: calc\(var\(--safe-top\) \+ 46px\)/)
  assert.match(top, /max-width: 52vw/)
})

test('厂商编辑统一走网页；侧栏入口两列排布；设置页有连接诊断', async () => {
  // 控制台整页已是网页设置首页（继承 CoomiWebPageActivity，落在 #/settings）；
  // 厂商入口在网页里走 /providers，两个原生页只剩「重定向到网页版」这一条路。
  const dash = await read('../coomi-app/app/src/main/java/app/coomi/CoomiDashboardActivity.java')
  assert.match(dash, /extends CoomiWebPageActivity/)
  assert.match(dash, /CONSOLE_ROUTE = "#\/settings"/)
  const providers = await read('../coomi-app/app/src/main/java/app/coomi/CoomiProvidersActivity.java')
  assert.match(providers, /redirectToWebProviders\("#\/providers"\)/)
  assert.match(providers, /CoomiWebPageActivity\.class/)
  const config = await read('../coomi-app/app/src/main/java/app/coomi/CoomiProviderConfigActivity.java')
  assert.match(config, /"#\/providers\/new"/)
  assert.match(config, /"#\/providers\/" \+ redirectId/)
  const side = await read('src/components/SideDrawer.vue')
  assert.match(side, /\.entry-row \{\s*display: grid; grid-template-columns: 1fr 1fr;/)
  // v4 删掉了「连接诊断」这一节（本地/云端隐藏后它失去意义），
  // 但一键复制诊断信息的能力保留在「关于」页。
  const settings = await read('src/views/SettingsView.vue')
  assert.doesNotMatch(settings, /连接诊断/)
  const about = await read('src/views/AboutView.vue')
  assert.match(about, /function copyDiag\(\)/)
  assert.match(about, /device\.tokenStatus\.configured/)
})

test('抽屉动画不再逐帧重绘整页：模糊全程静态，圆角/阴影常驻', async () => {
  const drawer = await read('vendor/rc33-ui/coomi-drawer.js')
  assert.match(drawer, /function setAnimClass\(on\)/)
  assert.match(drawer, /classList\.toggle\('cp-anim', !!on\)/)
  const compat = await read('vendor/rc33-ui/compat-rc104.css')
  // 顶栏改成全程静态半透明底、不做 backdrop-filter：
  // 以前只在 .drawer-live 里关模糊，那个切换本身发生在动画第 0 帧，
  // 一边挂 will-change 一边换合成属性 → WebView 重新分层 → 闪一下。
  assert.match(compat, /\.chat \.topbar \{/)
  assert.match(compat, /backdrop-filter: none !important/)
  // 不允许再出现「只在 .drawer-live 期间」的条件式模糊切换
  assert.doesNotMatch(compat, /\.chat\.drawer-live \.topbar \{/)
})

test('虚拟列表尺寸补偿不再把页面顶回用户消息：单权威 + 只观察宿主', async () => {
  const scroll = await read('src/composables/useAutoScroll.ts')
  // 脱离跟随只认手势：尺寸补偿、懒测量这些程序性位移不再被判成「用户上滑」。
  assert.match(scroll, /function onWheel\(event: WheelEvent\): void/)
  assert.match(scroll, /if \(event\.deltaY < 0\) detachFollow\(\)/)
  // 贴底写的是真正底部，不靠浏览器夹取
  assert.match(scroll, /el\.scrollTop = bottom/)
  // 横滑（抽屉手势）不能当成用户在看历史
  assert.match(scroll, /if \(Math\.abs\(dx\) > Math\.abs\(dy\)\) return/)
  const chat = await read('src/views/ChatView.vue')
  // 只观察滚动宿主 + 内容层；不再按渲染路径切观察目标，也不再登记「布局静默窗」。
  assert.match(chat, /function observeHost\(\)/)
  assert.match(chat, /\.vue-recycle-scroller__item-wrapper/)
  assert.doesNotMatch(chat, /noteLayoutChange\(/)
  assert.doesNotMatch(chat, /followAfterLayout\(/)
  assert.match(chat, /overflow-anchor: none;/)
})

test('打开侧栏不再逐行重播入场动画（会话标题不闪）', async () => {
  const cloud = await read('vendor/rc33-ui/coomi-cloud.css')
  assert.doesNotMatch(cloud, /\.drawer-root\.open \.panel \.list > \.row|\.drawer-root\.open \.panel \.list > \.session-entry/)
  assert.doesNotMatch(cloud, /\.drawer-root\.open \.panel \.list > \*:nth-child/)
})

test('抽屉打开只走合成：预热帧就位、动画只改 transform、点卡片能收回', async () => {
  const chat = await read('src/views/ChatView.vue')
  // border-radius 是 paint 属性，绝不能进 transition（否则 340ms 每帧重绘整屏）
  assert.doesNotMatch(chat, /transition:\s*\n?\s*transform[^;]*border-radius/)
  assert.match(chat, /transition: transform \.34s/)
  // 预热两帧后再开；动画期间视觉由常驻属性 + 独立阴影层固定住
  assert.match(chat, /requestAnimationFrame\(\(\) => requestAnimationFrame\(\(\) => \{/)
  assert.match(chat, /drawerLive\.value = true/)
  // 圆角/overflow 改成 .shell 常驻（不再在预热帧切换），阴影挪到 .shell-shade 独立层
  assert.match(chat, /\.shell \{[\s\S]*?border-radius: var\(--r-card\);[\s\S]*?overflow: hidden;/)
  assert.match(chat, /\.shell-shade \{/)
  assert.match(chat, /\.chat\.drawer-open \.shell-shade,/)
  // 阴影只过渡 opacity，不再是 paint 属性逐帧重算
  assert.match(chat, /transition: opacity \.34s/)
  // 自动降级已移除：真机首帧慢是面板首绘+冷缓存导致的，
  // 抽 3 帧就永久砍掉 3D 会让用户以为「打开动画消失」。
  // 现在只剩 ?fx=lite 这个手动逃生口，默认始终完整动画。
  assert.doesNotMatch(chat, /function probeFrameBudget/)
  assert.doesNotMatch(chat, /probeFrameBudget\(\)/)
  assert.match(chat, /new URLSearchParams\(location\.search\)\.get\('fx'\) === 'lite'/)
  assert.match(chat, /\.chat\.fx-lite\.drawer-open \.shell/)
  // tap 层在 .shell 外面（否则会被卡片位移再推走一个抽屉宽）
  assert.match(chat, /\n    <div v-if="drawerOpen" class="drawer-tap" @click="onDrawerTap" \/>/)
  assert.match(chat, /function onDrawerTap\(\)/)
  assert.match(chat, /tapSuppressUntil = Date\.now\(\) \+ 260/)
  // 顶栏模糊改为全程静态（见上一个测试的理由）
  const compat = await read('vendor/rc33-ui/compat-rc104.css')
  assert.match(compat, /\.chat \.topbar \{/)
  // 打开时刷新运行态延后到动画之后
  assert.match(await read('src/components/SideDrawer.vue'), /setTimeout\(\(\) => \{ sessions\.refreshRunning\(\) \}, 400\)/)
})

test('设置页所有开关都接到 SettingsRow 真正发出的 update:switch 事件', async () => {
  // 真机回归：SettingsRow 声明并 emit 的是 `update:switch`，
  // 但有 11 处调用点写成了 `@update:switch-state` —— 事件名不匹配时 Vue 不报错，
  // emit 出去没有任何监听者，于是开关点下去毫无反应（既不生效也不报错）。
  // 全局会话记忆、团队模式、计划模式、平滑输出、逆向、遥测、留痕、备份、LAN 全部中招。
  const row = await read('src/components/settings/SettingsRow.vue')
  assert.match(row, /'update:switch': \[value: 'on' \| 'off'\]/)

  const consumers = [
    'src/views/settings/AiSettingsView.vue',
    'src/views/settings/GeneralSettingsView.vue',
    'src/views/BackupView.vue',
    'src/views/DevicesView.vue',
  ]
  for (const file of consumers) {
    const source = await read(file)
    assert.doesNotMatch(source, /@update:switch-state/, `${file} 监听了不存在的事件名`)
  }
})
