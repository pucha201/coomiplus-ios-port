<script setup lang="ts">
/**
 * SKILL / MCP 管理（控制台入口）。
 * 数据来自引擎 /api/catalog；安装走 /api/catalog/{mcp,skills}/install。
 * 交互：点击「安装」→ 弹出确认（名称/描述/来源/生效方式）→ MCP 再填参数，Skill 直接安装。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import EnvRepairSheet from '@/components/EnvRepairSheet.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { apiGet, authedFetch } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { filterMarketItems } from '@/utils/marketSearch'
import { zhName, zhDesc, softenEn } from '@/utils/catalogZh'

const transportOptions = [
  { value: 'stdio', label: 'stdio（本地命令）' },
  { value: 'http', label: 'HTTP / Streamable' },
  { value: 'sse', label: 'SSE' },
]

const router = useRouter()

/** 解析引擎响应：兼容空 body（旧引擎进程对未知路由返回 404 空体），错误带可读信息。 */
async function parseRes(res: Response): Promise<any> {
  const text = await res.text()
  let data: any = {}
  let isJson = true
  try { data = text ? JSON.parse(text) : {} } catch { data = {}; isJson = false }
  if (!res.ok) {
    const detail = data.error ?? data.message ?? ''
    // 兜底文案不能只丢「HTTP 404」：这句话会原样出现在页面错误条里，用户需要知道下一步做什么。
    throw new Error(detail || `请求失败（HTTP ${res.status}）${text ? '' : '，电脑端响应为空，可能版本过旧，请重启应用'}`)
  }
  // 引擎掉线时同源桥会把前端 index.html 以 200 回给 /api/*：这种 200 不是数据，
  // 当成空目录会让用户看到「暂无 MCP」而不是「连不上电脑」。
  if (!isJson) throw new Error(`电脑端返回了非 JSON 响应（HTTP ${res.status}），请检查连接`)
  return data
}

type Tab = 'mcp' | 'skills'
const tab = ref<Tab>('mcp')
/** 页签内的视图：已安装（本机实际配置，含自建/导入）｜仓库（内置目录）｜市场（社区注册表）。 */
type Scope = 'installed' | 'catalog' | 'market'
const scope = ref<Scope>('catalog')

interface RequiredParam { key: string; label: string; secret?: boolean }
interface McpItem {
  id: string; name: string; description: string; transport: string
  required_parameters: RequiredParam[]; installed: boolean; enabled: boolean
  path?: string
  /** 远程/自定义安装用：与 transport 一起决定走 /install-remote 还是 /install。 */
  command?: string; args?: string[]; url?: string; env?: Record<string, string>
}
interface SkillItem { id: string; name: string; description: string; repository: string; installed: boolean; enabled: boolean; path?: string }
/** 社区市场条目（registry.json）：在 SkillItem 基础上扩展元数据与热度来源。 */
interface MarketItem extends SkillItem {
  ref?: string; subdir?: string
  author?: string; tags?: string[]; license?: string; verified?: boolean
  source?: string
  /** 广场里的 MCP 也带连接信息（有它才能直接在广场安装）。 */
  transport?: string; command?: string; args?: string[]; url?: string; env?: Record<string, string>
  required_parameters?: RequiredParam[]
}

const mcp = ref<McpItem[]>([])
const skills = ref<SkillItem[]>([])
const installedMcp = ref<McpItem[]>([])
const installedSkills = ref<SkillItem[]>([])
// ── 社区市场（/api/registry）──
const marketSkills = ref<MarketItem[]>([])
const marketMcps = ref<MarketItem[]>([])
const marketStats = ref<{ github?: any; app?: any }>({})
const marketUpdatedAt = ref('')
const marketLoading = ref(false)
const marketQuery = ref('')
const filteredMarketSkills = computed(() => filterMarketItems(marketSkills.value, marketQuery.value))
const filteredMarketMcps = computed(() => filterMarketItems(marketMcps.value, marketQuery.value))
const activeMarketResults = computed(() => {
  if (tab.value === 'skills') return filteredMarketSkills.value
  return filteredMarketMcps.value
})
const marketKindLabel = computed(() => {
  if (tab.value === 'skills') return 'Skills'
  return 'MCP'
})
const marketSearchPlaceholder = computed(() => `搜索 ${marketKindLabel.value}`)
const loading = ref(true)
const error = ref('')
let catalogRequest = 0
let installedRequest = 0
let marketRequest = 0
let sourcesRequest = 0
const busy = ref<string | null>(null)
const notice = ref('')
/** MCP 预检失败时引擎会返回「本机缺少运行环境：…」；把缺的东西列出来并给出补全入口。 */
const envMissing = ref<string[]>([])
const canRepairEnv = ref(false)
const repairOpen = ref(false)
const repairAutoStart = ref(false)

function openRepair(autoStart: boolean) {
  repairAutoStart.value = autoStart
  repairOpen.value = true
}

/**
 * 缺依赖时先确认当前是不是 Proot：桌面端缺 Node 应该提示去安装 Node，
 * 不能弹一个只会跑 apt 的补全层。确认后 Proot 自动开始补全并显示日志。
 */
async function handleMissingEnv(missing: string[]) {
  envMissing.value = missing
  canRepairEnv.value = false
  try {
    const runtime = await apiGet<{ runtime?: { backend?: string } }>('/api/runtime/v2')
    if (runtime.runtime?.backend === 'proot_linux') {
      canRepairEnv.value = true
      openRepair(true)
      return
    }
  } catch { /* 读不到环境就只保留文字提示 */ }
  notice.value = `安装需要 ${missing.join('、')}，请先在系统里安装对应运行时。`
}

function onRepairReady() {
  repairOpen.value = false
  envMissing.value = []
  canRepairEnv.value = false
  // 补全完成后自动把刚才失败的 MCP 安装重跑一次（表单还开着才重跑）。
  if (installingMcp.value) void installMcp()
}

function onRepairFailure(message: string) {
  // 不自动关弹层：失败后用户要能在弹层里直接点「重新补全」。
  notice.value = `依赖补全失败：${message}`
}
/** 当前展开详情的卡片 id（卡片默认折叠，只显示名称）。 */
const expanded = ref<string | null>(null)
function toggleExpanded(id: string) {
  expanded.value = expanded.value === id ? null : id
}

// ── 安装确认（所有安装必须先确认，不能点击即装）──
const askMcp = ref<McpItem | null>(null)
const askSkill = ref<SkillItem | null>(null)

// ── MCP 安装参数表单（按目录的 required_parameters 动态生成）──
const installingMcp = ref<McpItem | null>(null)
const installValues = ref<Record<string, string>>({})

/** 必填参数是否都已填写（未填完不允许安装，避免 500）。 */
const installReady = computed(() => {
  const item = installingMcp.value
  if (!item) return false
  return item.required_parameters.every(
    p => (installValues.value[p.key] ?? '').trim().length > 0,
  )
})

function confirmMcpInstall(item: McpItem) {
  askMcp.value = item
}

/** 广场条目 → 可安装的 McpItem：补齐 transport/required_parameters，
 *  这样「仓库」和「广场」两个页签走同一套安装流程（缺陷 5）。 */
function marketMcpToItem(m: MarketItem): McpItem {
  return {
    id: m.id,
    name: m.name,
    description: m.description ?? '',
    transport: m.transport ?? (m.command ? 'stdio' : (m.url ? 'http' : 'stdio')),
    required_parameters: m.required_parameters ?? [],
    installed: m.installed,
    enabled: false,
    command: m.command,
    args: m.args,
    url: m.url,
    env: m.env,
  }
}

function proceedMcp() {
  const item = askMcp.value
  askMcp.value = null
  if (!item) return
  installingMcp.value = item
  installValues.value = {}
  notice.value = ''
}

function confirmSkillInstall(item: SkillItem) {
  askSkill.value = item
}

// ── 停用 / 启用（管理页卸载 = 停用可恢复；删除 = 彻底删除）──
const askDelete = ref<{ kind: 'mcp' | 'skill'; item: McpItem | SkillItem } | null>(null)

async function setEnabled(kind: 'mcp' | 'skill', item: McpItem | SkillItem, enabled: boolean) {
  busy.value = item.id
  notice.value = ''
  try {
    // 注意：引擎路由为 /api/catalog/{mcp,skills}/...（skills 是复数）
    const resource = kind === 'mcp' ? 'mcp' : 'skills'
    const res = await authedFetch(`/api/catalog/${resource}/${item.id}/enabled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled }),
    })
    await parseRes(res)
    // 本地乐观更新：立即反映按钮/徽标状态（不依赖后续 load 是否成功）。
    item.enabled = enabled
    notice.value = enabled
      ? `已启用${kind === 'mcp' ? ' MCP' : ' Skill'}「${item.name}」，新开会话后生效`
      : `已停用${kind === 'mcp' ? ' MCP' : ' Skill'}「${item.name}」，文件与配置已保留，可随时重新启用`
    await load()
  } catch (e) {
    notice.value = `${enabled ? '启用' : '停用'}失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

function confirmDelete(kind: 'mcp' | 'skill', item: McpItem | SkillItem) {
  askDelete.value = { kind, item }
}

async function deleteItem() {
  const target = askDelete.value
  if (!target) return
  busy.value = target.item.id
  notice.value = ''
  try {
    // 注意：引擎路由为 /api/catalog/{mcp,skills}/...（skills 是复数）
    const resource = target.kind === 'mcp' ? 'mcp' : 'skills'
    const res = await authedFetch(`/api/catalog/${resource}/${target.item.id}`, { method: 'DELETE' })
    await parseRes(res)
    notice.value = `已彻底删除${target.kind === 'mcp' ? ' MCP' : ' Skill'}「${target.item.name}」`
    askDelete.value = null
    await load()
  } catch (e) {
    notice.value = `删除失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

function proceedSkill() {
  const item = askSkill.value
  askSkill.value = null
  if (!item) return
  installSkill(item)
}

function closeInstallForm() {
  installingMcp.value = null
  installValues.value = {}
}

async function load() {
  const request = ++catalogRequest
  loading.value = true
  error.value = ''
  try {
    const res = await authedFetch('/api/catalog')
    const data = await parseRes(res)
    if (request !== catalogRequest) return
    // 结构不对就不是「目录为空」：写成空数组会给出「暂无 MCP」的空态，把连接问题伪装成正常结果。
    if (!Array.isArray(data.mcp) || !Array.isArray(data.skills)) {
      throw new Error('目录响应格式不对，请检查电脑连接')
    }
    mcp.value = data.mcp
    skills.value = (data.skills ?? []).map((s: any) => ({
      ...s, name: zhName(s.id, s.name), description: zhDesc(s.id, s.description || ''),
    }))
  } catch (e) {
    if (request === catalogRequest) error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (request === catalogRequest) loading.value = false
  }
}

/** 加载本机已安装列表（含目录之外自建/导入的）：/api/runtime/installed。 */
async function loadInstalled() {
  const request = ++installedRequest
  const currentScope = scope.value
  loading.value = true
  error.value = ''
  try {
    const res = await authedFetch('/api/runtime/installed')
    const data = await parseRes(res)
    if (request !== installedRequest || currentScope !== 'installed') return
    if (!Array.isArray(data.mcp) || !Array.isArray(data.skills)) {
      throw new Error('已安装列表响应格式不对，请检查电脑连接')
    }
    installedMcp.value = data.mcp.map((m: any) => ({
      id: m.id, name: m.name, description: '', transport: m.transport ?? '', required_parameters: [], installed: true, enabled: m.enabled, path: m.path,
    }))
    installedSkills.value = (data.skills ?? []).map((s: any) => ({
      id: s.id, name: s.name, description: '', repository: '', installed: true, enabled: s.enabled, path: s.path,
    }))
  } catch (e) {
    if (request === installedRequest && currentScope === 'installed') error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (request === installedRequest && currentScope === 'installed') loading.value = false
  }
}

/** 可选下载源（/api/registry/sources）。 */
const marketSources = ref<{ id: string; name: string; url: string }[]>([])
const activeSource = ref('official')

/** 拉取下载源列表（进入市场视图时调用一次）。 */
async function loadSources() {
  const request = ++sourcesRequest
  const previousSource = activeSource.value
  try {
    const res = await authedFetch('/api/registry/sources')
    if (!res.ok) return
    const data = await parseRes(res)
    if (request !== sourcesRequest) return
    marketSources.value = data.sources ?? []
    if (previousSource === 'official') activeSource.value = data.active ?? 'official'
  } catch { /* 源列表失败时保持默认，不影响市场加载 */ }
}

/** 切换下载源：重新拉取该源的市场数据。 */
async function switchSource(id: string) {
  if (id === activeSource.value) return
  activeSource.value = id
  await loadMarket()
}

/** 加载社区市场（/api/registry）：引擎代理拉取注册表 + 热度统计，带 10 分钟缓存。 */
async function loadMarket() {
  const request = ++marketRequest
  const requestedSource = activeSource.value
  marketLoading.value = true
  error.value = ''
  try {
    const qs = activeSource.value && activeSource.value !== 'official'
      ? '?source=' + encodeURIComponent(activeSource.value)
      : ''
    const res = await authedFetch('/api/registry' + qs)
    const data = await parseRes(res)
    if (request !== marketRequest || requestedSource !== activeSource.value) return
    const remote = data.remote ?? {}
    const installedIds: string[] = data.installed ?? []
    const decorate = (e: any): MarketItem => ({
      id: e.id, name: zhName(e.id, e.name), description: zhDesc(e.id, softenEn(e.description ?? '')), repository: e.repository ?? '', ref: e.ref ?? 'main', subdir: e.subdir ?? '', author: e.author, tags: e.tags, license: e.license, verified: e.verified, installed: installedIds.includes(e.id), enabled: false, source: e.source,
      // 广场里的 MCP 要能直接安装，必须把「怎么连」的字段透出来：
      // installMcp() 判定远程安装的前提就是 transport/command/url（缺陷 5）。
      transport: e.transport, command: e.command, args: e.args, url: e.url, env: e.env,
    })
    marketSkills.value = (remote.skills ?? []).map(decorate)
    marketMcps.value = (remote.mcps ?? []).map(decorate)
    marketStats.value = data.stats ?? {}
    marketUpdatedAt.value = remote.updated_at ?? ''
  } catch (e) {
    if (request === marketRequest) error.value = e instanceof Error ? e.message : String(e)
    // Keep the previous catalog visible while showing the refresh error.
  } finally {
    if (request === marketRequest) marketLoading.value = false
  }
}

/** 切换视图（已安装/仓库/市场）：已安装与市场首次进入时拉取一次。 */
function switchScope(next: Scope) {
  if (scope.value === next) return
  scope.value = next
  error.value = ''
  if (next === 'installed') void loadInstalled()
  if (next === 'market') {
    void loadSources()
    void loadMarket()
  }
}

// ── 手动安装 Skill 压缩包（zip）──
const installingLocal = ref(false)
const localFileInput = ref<HTMLInputElement | null>(null)

function openLocalSkillPicker() {
  if (installingLocal.value) return
  // Android 壳：走原生 SAF 文件选择（WebView 不实现 <input type=file> 的选择器）
  const bridge = (window as any).CoomiAndroid
  if (bridge?.importFiles) {
    const onImported = (e: Event) => {
      window.removeEventListener('coomi:files-imported', onImported as any)
      const detail = (e as CustomEvent<{ paths?: string[] }>).detail ?? {}
      const paths = detail.paths ?? []
      if (paths.length === 1) void installSkillFromPath(paths[0])
      else if (paths.length > 1) notice.value = '一次只能安装一个 Skill 压缩包，已选择 ' + paths.length + ' 个'
      else notice.value = '未选择文件'
    }
    window.addEventListener('coomi:files-imported', onImported as any)
    bridge.importFiles()
    return
  }
  // 桌面浏览器降级：原生 input[type=file]（accept 仅 zip）
  localFileInput.value?.click()
}

/** Android 桥返回文件路径后：经 /api/fs/raw 读字节 → base64 → install-local */
async function installSkillFromPath(path: string) {
  if (installingLocal.value) return
  if (!/\.zip$/i.test(path) && !/\.skill\.json$/i.test(path)) {
    notice.value = '安装失败：请选择 .zip（Skill 包）文件'
    return
  }
  installingLocal.value = true
  notice.value = ''
  try {
    const res = await authedFetch('/api/fs/raw?path=' + encodeURIComponent(path))
    if (!res.ok) throw new Error(`读取本地文件失败（HTTP ${res.status}）`)
    // 引擎掉线时同源桥会把前端页面以 200 回给 /api/fs/raw：拿到的若是 HTML，
    // 继续走安装只会让引擎报一个看不懂的 zip 错误。
    const rawType = (res.headers.get('content-type') || '').toLowerCase()
    if (rawType.includes('text/html')) throw new Error('电脑端返回的是页面而不是文件，请检查连接')
    const buf = await res.arrayBuffer()
    const bytes = new Uint8Array(buf)
    await installZipBytes(bytes, path)
  } catch (e) {
    notice.value = '安装失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    installingLocal.value = false
  }
}

/** 共享安装逻辑：zip 字节 → base64 → install-local（文件名推断 id）。 */
async function installZipBytes(bytes: Uint8Array, fileName: string) {
  const base = fileName.replace(/\.skill\.json$/i, '').replace(/\.zip$/i, '').trim()
  const id = base.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'local-skill'
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  const zipBase64 = btoa(binary)
  const res = await authedFetch('/api/catalog/skills/install-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, name: base || id, zip_base64: zipBase64 }),
  })
  const data = await parseRes(res)
  notice.value = '已安装 Skill「' + (data.id ?? id) + '」'
  void loadInstalled()
  if (scope.value === 'market') void loadMarket()
}

async function onLocalSkillFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  if (!/\.zip$/i.test(file.name) && file.type !== 'application/zip') {
    notice.value = '安装失败：请选择 .zip（Skill 包）文件'
    return
  }
  installingLocal.value = true
  notice.value = ''
  try {
    const buf = await file.arrayBuffer()
    await installZipBytes(new Uint8Array(buf), file.name)
  } catch (e) {
    notice.value = '安装失败：' + (e instanceof Error ? e.message : String(e))
  } finally {
    installingLocal.value = false
  }
}

/** 当前视图下要渲染的列表（已安装｜仓库｜市场）。市场条目不进旧模板渲染，
 * 这里仅保证类型完整（transport 等字段填默认值）。 */
const visibleMcp = computed<McpItem[]>(() => {
  if (scope.value === 'installed') return installedMcp.value
  if (scope.value === 'market') {
    return marketMcps.value.map(m => ({
      id: m.id, name: m.name, description: m.description, transport: '', required_parameters: [], installed: m.installed, enabled: false,
    }))
  }
  return mcp.value
})
const visibleSkills = computed<SkillItem[]>(() => {
  if (scope.value === 'installed') return installedSkills.value
  if (scope.value === 'market') return marketSkills.value
  return skills.value
})

/** 各类型页签的计数（市场页签在 tab 计数角标上各自独立）。 */
const mcpCount = computed(() => {
  if (scope.value === 'installed') return installedMcp.value.length
  if (scope.value === 'market') return marketMcps.value.length
  return mcp.value.length
})
const skillsCount = computed(() => {
  if (scope.value === 'installed') return installedSkills.value.length
  if (scope.value === 'market') return marketSkills.value.length
  return skills.value.length
})

/** 热度数字格式化：1000+ 显示为 1.0k。 */
function fmt(n: number | undefined | null): string {
  if (n == null) return '—'
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

// ── 自定义 MCP Server ──
const addOpen = ref(false)
const addBusy = ref(false)
const addForm = ref({
  name: '', transport: 'stdio' as 'stdio' | 'http' | 'sse', command: '', args: '', url: '', enabled: true,
})
function openAdd() {
  addForm.value = { name: '', transport: 'stdio', command: '', args: '', url: '', enabled: true }
  addOpen.value = true
}
async function saveCustomMcp() {
  const f = addForm.value
  const name = f.name.trim()
  if (!name) { notice.value = '请填写服务名称'; return }
  if (f.transport === 'stdio' && !f.command.trim()) { notice.value = 'stdio 需要填写 command'; return }
  if ((f.transport === 'http' || f.transport === 'sse') && !f.url.trim()) { notice.value = 'HTTP/SSE 需要填写 url'; return }
  addBusy.value = true
  notice.value = ''
  try {
    const existing = await authedFetch('/api/settings/mcp').then(r => r.json()).catch(() => ({ servers: {} }))
    const servers = existing.servers ?? {}
    const server: Record<string, unknown> = { transport: f.transport, enabled: f.enabled }
    if (f.transport === 'stdio') {
      server.command = f.command.trim()
      server.args = f.args.split(/\s+/).map(s => s.trim()).filter(Boolean)
    } else {
      server.url = f.url.trim()
    }
    servers[name] = server
    const res = await authedFetch('/api/settings/mcp', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers }),
    })
    // 必须解析响应：引擎掉线时这条 PUT 会被同源桥以 200 + HTML 收下，
    // 不检查就会出现「已保存自定义 MCP」的假成功，重启后配置并不存在。
    await parseRes(res)
    notice.value = `已保存自定义 MCP「${name}」，重启引擎或新开会话后生效`
    addOpen.value = false
    scope.value = 'installed'
    await loadInstalled()
  } catch (e) {
    notice.value = `保存失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    addBusy.value = false
  }
}

/** 市场条目热度：GitHub 公开指标（stars/下载量） + App 安装统计。 */
function heatOf(item: MarketItem) {
  const gh = marketStats.value.github?.skills?.[item.id]
  const app = marketStats.value.app?.events?.install_ok?.[item.id]
  return {
    stars: gh?.stars as number | undefined, downloads30d: gh?.downloads_30d as number | undefined, install7d: app?.['7d'] as number | undefined, installTotal: app?.total as number | undefined,
  }
}

async function installMcp() {
  let remoteFallback = ''
  const item = installingMcp.value
  if (!item) return
  busy.value = item.id
  notice.value = ''
  try {
    const remote = (item as any) as { transport?: string; command?: string; url?: string; args?: string[]; env?: Record<string, string> }
    const canRemote = !!(remote.command || remote.url)
    if (canRemote) {
      const payload: Record<string, unknown> = {
        id: sanitizeId(item.id),
        name: item.name,
        transport: remote.transport ?? (remote.url ? 'http' : 'stdio'),
      }
      if (remote.command) payload.command = remote.command
      if (remote.url) payload.url = remote.url
      if (remote.args) payload.args = remote.args
      if (remote.env) payload.env = remote.env
      let remoteOk = true
      try {
        const res = await authedFetch('/api/catalog/mcp/install-remote', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
        })
        await parseRes(res)
      } catch (error) {
        // 旧引擎没有 install-remote：退回带参数的 install。
        remoteOk = false
        remoteFallback = error instanceof Error ? error.message : String(error)
      }
      if (!remoteOk) {
        const res = await authedFetch('/api/catalog/mcp/install', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: item.id, values: installValues.value }),
        })
        await parseRes(res)
      }
      const enableError = await enableAfterInstall('mcp', sanitizeId(item.id))
      const listed = await installedIds()
      const target = sanitizeId(item.id)
      const present = !listed || listed.mcp.some(id => id === target || id.endsWith(target))
      if (!present) {
        // 引擎返回了成功、列表里却暂时没有：不再当成失败（引擎可能按自己的 id 落盘），
        // 只提示刷新；真正的失败由上面的 parseRes 抛出。
        notice.value = `已提交安装「${item.name}」，列表尚未刷新${enableError ? `；启用未确认：${enableError}` : ''}`
        closeInstallForm()
        await load()
        await loadInstalled()
        return
      }
      notice.value = enableError
        ? `已安装 MCP「${item.name}」，但自动启用失败：${enableError}`
        : `已安装并启用 MCP「${item.name}」`
      closeInstallForm()
      await load()
      return
    }
    const res = await authedFetch('/api/catalog/mcp/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id, values: installValues.value }),
    })
    await parseRes(res)
    notice.value = `已安装 MCP「${item.name}」，重启引擎或新开会话后生效`
    closeInstallForm()
    await load()
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    notice.value = `安装失败：${message}${remoteFallback ? `（远程安装：${remoteFallback}）` : ''}`
    // 预检在缺 npm / pip 时直接 400，不会进入后台任务。这里把缺失项解析出来，
    // 弹层显示 apt 的实时日志与下载速度，补全后自动重试安装。
    const missing = /本机缺少运行环境：(.+?)；/.exec(message)
    if (missing) {
      const items = missing[1].split('、').map(item => item.trim()).filter(Boolean)
      void handleMissingEnv(items)
    }
  } finally {
    busy.value = null
  }
}

/** 引擎要求 id 只能小写字母数字 + 连字符，且不能以符号开头。 */
function sanitizeId(raw: string): string {
  let out = ''
  for (const ch of (raw ?? '').trim().toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch
    else if (out.length > 0 && !out.endsWith('-')) out += '-'
  }
  return out.replace(/^-+/, '').replace(/-+$/, '')
}

/** 装完自动启用（引擎 /api/catalog/{mcp,skills}/{id}/enabled）。返回失败原因（空串=成功）。 */
async function enableAfterInstall(resource: 'mcp' | 'skills', id: string): Promise<string> {
  try {
    const res = await authedFetch(`/api/catalog/${resource}/${encodeURIComponent(id)}/enabled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: true })
    })
    await parseRes(res)
    return ''
  } catch (e) {
    // 以前这里静默吞掉：装成功但没启用，用户看到的就是「装了却用不了」。
    return e instanceof Error ? e.message : String(e)
  }
}

/** 安装后核对：接口说成功、已安装列表里却没有 = 没装上，必须说出来。 */
async function installedIds(): Promise<{ mcp: string[]; skills: string[] } | null> {
  try {
    const res = await authedFetch('/api/runtime/installed')
    const data = await parseRes(res)
    if (!Array.isArray(data.mcp) || !Array.isArray(data.skills)) return null
    return {
      mcp: data.mcp.map((m: { id?: string }) => String(m.id ?? '')),
      skills: data.skills.map((s: { id?: string }) => String(s.id ?? '')),
    }
  } catch {
    return null
  }
}

async function installSkill(item: SkillItem) {
  busy.value = item.id
  notice.value = '正在下载并安装…'
  try {
    if (scope.value === 'market') {
      const market = item as MarketItem
      const res = await authedFetch('/api/catalog/skills/install-remote', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          id: market.id, name: market.name, description: market.description, repository: market.repository, ref: market.ref ?? 'main', subdir: market.subdir ?? '',
        }),
      })
      await parseRes(res)
      await enableAfterInstall('skills', sanitizeId(market.id))
      notice.value = `已安装并启用 Skill「${market.name}」，新开会话后生效`
      await loadMarket()
    } else {
      const res = await authedFetch('/api/catalog/skills/install', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }),
      })
      await parseRes(res)
      notice.value = `已安装 Skill「${item.name}」，重启引擎或新开会话后生效`
      await load()
    }
  } catch (e) {
    notice.value = `安装失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

/** 回滚 Skill 到安装前备份。 */
async function rollbackSkill(id: string, name: string) {
  busy.value = `rb_${id}`
  notice.value = '正在回滚…'
  try {
    await parseRes(await authedFetch(`/api/catalog/skills/${encodeURIComponent(id)}/rollback`, { method: 'POST' }))
    notice.value = `已回滚「${name}」到最近备份`
    await load()
  } catch (e) {
    notice.value = `回滚失败：${e instanceof Error ? e.message : String(e)}`
  } finally {
    busy.value = null
  }
}

/** 星级：stars 映射 0–5 星（对数刻度）。 */
function starsOf(item: MarketItem): number {
  const s = heatOf(item).stars
  if (s == null) return 0
  if (s >= 5000) return 5
  if (s >= 1000) return 4
  if (s >= 200) return 3
  if (s >= 50) return 2
  if (s >= 10) return 1
  return 0
}
function starText(n: number): string {
  return '★'.repeat(n) + '☆'.repeat(5 - n)
}

onMounted(load)
// 返回：有历史则回进入前页面；无历史回对话（不强开控制台）
function goDashboard() {
  // 兜底回设置页（有历史时 goBack 会自己回进入前那一页）。
  goBack(router, '/settings')
}
</script>

<template>
  <div class="page">
    <PageHead title="拓展管理" @back="goDashboard" />
    <main class="body">
      <!-- 一级：已安装 | 仓库 | 市场 -->
      <div class="seg" role="tablist">
        <button class="segitem" :class="{ on: scope === 'installed' }" @click="switchScope('installed')">
          <CoomiIcon name="check" :size="14" />已安装
        </button>
        <button class="segitem" :class="{ on: scope === 'catalog' }" @click="switchScope('catalog')">
          <CoomiIcon name="globe" :size="14" />仓库
        </button>
        <button class="segitem" :class="{ on: scope === 'market' }" @click="switchScope('market')">
          <CoomiIcon name="sparkle" :size="14" />广场
        </button>
      </div>

      <!-- 二级：MCP | Skills -->
      <div class="tabs">
        <button class="tab" :class="{ on: tab === 'mcp' }" @click="tab = 'mcp'">
          <CoomiIcon name="plug" :size="15" />MCP
          <!-- 没拉到列表时不显示 0：角标写 0 等于替用户下了「一个都没有」的结论，
               而下面同一屏正在说「连不上电脑」。 -->
          <span v-if="!loading && !error" class="cnt">{{ mcpCount }}</span>
        </button>
        <button class="tab" :class="{ on: tab === 'skills' }" @click="tab = 'skills'">
          <CoomiIcon name="wrench" :size="15" />Skills
          <span v-if="!loading && !error" class="cnt">{{ skillsCount }}</span>
        </button>
      </div>

      <div v-if="scope === 'market'" class="market-toolbar">
        <label class="market-search">
          <CoomiIcon name="search" :size="16" />
          <input
            v-model="marketQuery"
            :placeholder="marketSearchPlaceholder"
            :aria-label="marketSearchPlaceholder"
            autocomplete="off"
          />
          <button v-if="marketQuery" type="button" aria-label="清空搜索" @click="marketQuery = ''">
            <CoomiIcon name="close" :size="14" />
          </button>
        </label>
        <label class="market-source" :title="'下载源：' + (marketSources.find(s => s.id === activeSource)?.name ?? activeSource)">
          <CoomiIcon name="globe" :size="14" />
          <select v-model="activeSource" @change="switchSource(activeSource)" aria-label="切换下载源">
            <option v-for="s in marketSources" :key="s.id" :value="s.id">{{ s.name }}</option>
          </select>
        </label>
      </div>

      <div v-if="scope === 'market'" class="market-toolbar" style="margin-top:8px">
        <button class="local-install" :disabled="installingLocal" @click="openLocalSkillPicker">
          <CoomiIcon :name="installingLocal ? 'subtask' : 'folder'" :size="14" />
          {{ installingLocal ? '安装中…' : '从本地安装 Skill' }}
        </button>
        <a
          class="submit-extension"
          href="https://github.com/TensorHub-ORG/coomi-registry/issues/new?template=submission.yml"
          target="_blank"
          rel="noopener noreferrer"
        >
          <span>去提交一个拓展</span>
          <CoomiIcon name="chevronRight" :size="16" />
        </a>
      </div>
      <input ref="localFileInput" type="file" accept=".zip" class="visually-hidden" @change="onLocalSkillFile" />

      <p v-if="notice" class="notice" :class="{ err: notice.startsWith('安装失败') }">{{ notice }}</p>
      <div v-if="envMissing.length" class="notice env-missing">
        <span>安装需要 {{ envMissing.join('、') }}，当前运行环境缺少。</span>
        <button v-if="canRepairEnv" @click="openRepair(false)">查看补全</button>
      </div>
      <p v-if="error" class="notice err">加载失败：{{ error }}</p>
      <p v-if="loading" class="hint">加载中…</p>

      <!-- MCP（市场视图在下方独立渲染） -->
      <template v-if="tab === 'mcp' && scope !== 'market'">
        <div class="add-row">
          <button class="add-btn" type="button" @click="openAdd">添加自定义 MCP</button>
        </div>
        <p v-if="!loading && !error && visibleMcp.length === 0" class="hint">
          {{ scope === 'installed' ? '本机还没有已安装的 MCP Server。' : '目录为空，暂时没有可安装的 MCP Server。' }}
        </p>
        <div v-else class="cards">
          <div v-for="item in visibleMcp" :key="item.id" class="card enter-item">
            <button class="card-head" @click.stop="toggleExpanded(item.id)">
              <span class="tile" :class="{ on: item.installed }">
                <CoomiIcon name="plug" :size="18" />
              </span>
              <span class="cname">{{ item.name }}</span>
              <span v-if="item.installed" class="badge" :class="item.enabled ? 'ok' : 'off'">
                {{ item.enabled ? '已启用' : '已停用' }}
              </span>
              <span v-else class="badge plain">未安装</span>
              <CoomiIcon name="chevronRight" :size="14" class="chev" :class="{ open: expanded === item.id }" />
            </button>
            <div v-if="expanded === item.id" class="detail">
              <p class="cdesc">{{ item.description || '本机配置的 MCP Server' }}</p>
              <span v-if="item.transport" class="cmeta"><CoomiIcon name="link" :size="12" />{{ item.transport }}</span>
              <span v-if="item.path" class="cmeta path"><CoomiIcon name="folder" :size="12" />{{ item.path }}</span>
              <div class="dops">
                <template v-if="item.installed">
                  <button class="act" :disabled="busy !== null" @click.stop="setEnabled('mcp', item, !item.enabled)">
                    {{ item.enabled ? '停用' : '启用' }}
                  </button>
                  <button class="act danger" :disabled="busy !== null" @click.stop="confirmDelete('mcp', item)">删除</button>
                </template>
                <button v-else class="act" :disabled="busy !== null" @click.stop="confirmMcpInstall(item)">
                  {{ busy === item.id ? '安装中…' : '安装' }}
                </button>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- Skills（市场视图在下方独立渲染） -->
      <template v-else-if="scope !== 'market'">
        <p v-if="!loading && !error && visibleSkills.length === 0" class="hint">
          {{ scope === 'installed' ? '本机还没有已安装的 Skill。' : '目录为空，暂时没有可安装的 Skill。' }}
        </p>
        <div v-else class="cards">
          <div v-for="item in visibleSkills" :key="item.id" class="card enter-item">
            <button class="card-head" @click.stop="toggleExpanded(item.id)">
              <span class="tile" :class="{ on: item.installed }">
                <CoomiIcon name="wrench" :size="18" />
              </span>
              <span class="cname">{{ item.name }}</span>
              <span v-if="item.installed" class="badge" :class="item.enabled ? 'ok' : 'off'">
                {{ item.enabled ? '已启用' : '已停用' }}
              </span>
              <span v-else class="badge plain">未安装</span>
              <CoomiIcon name="chevronRight" :size="14" class="chev" :class="{ open: expanded === item.id }" />
            </button>
            <div v-if="expanded === item.id" class="detail">
              <p class="cdesc">{{ item.description || '本机安装的 Skill' }}</p>
              <span v-if="item.repository" class="cmeta"><CoomiIcon name="globe" :size="12" />{{ item.repository }}</span>
              <span v-if="item.path" class="cmeta path"><CoomiIcon name="folder" :size="12" />{{ item.path }}</span>
              <div class="dops">
                <template v-if="item.installed">
                  <button class="act" :disabled="busy !== null" @click.stop="setEnabled('skill', item, !item.enabled)">
                    {{ item.enabled ? '停用' : '启用' }}
                  </button>
                  <button class="act" :disabled="busy !== null" @click.stop="rollbackSkill(item.id, item.name)">
                    {{ busy === `rb_${item.id}` ? '回滚中…' : '回滚' }}
                  </button>
                  <button v-if="item.id !== 'skill-creator'" class="act danger" :disabled="busy !== null" @click.stop="confirmDelete('skill', item)">删除</button>
                  <span v-else class="cmeta">内置 Skill，不可卸载</span>
                </template>
                <button v-else class="act" :disabled="busy !== null" @click.stop="confirmSkillInstall(item)">
                  {{ busy === item.id ? '安装中…' : '安装' }}
                </button>
                <div v-if="busy === item.id || busy === `rb_${item.id}`" class="progress" aria-hidden="true">
                  <i />
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- 市场（社区注册表）：SKILL 可一键安装；MCP 暂为收录展示 -->
      <template v-else>
        <p v-if="marketLoading" class="hint">加载中…</p>
        <template v-else>
          <p v-if="tab === 'skills' && marketSkills.length === 0" class="hint">
            广场里还没有 SKILL。
          </p>
          <p v-else-if="tab === 'mcp' && marketMcps.length === 0" class="hint">
            广场里还没有 MCP。
          </p>
          <p v-else-if="marketQuery.trim() && activeMarketResults.length === 0" class="hint">
            没有找到“{{ marketQuery.trim() }}”相关的 {{ marketKindLabel }}。
          </p>
          <p v-else-if="tab === 'skills' && marketSkills.length > 0" class="hint sub">
            社区注册表 · 更新于 {{ marketUpdatedAt || '—' }} · 内容托管在贡献者自己的仓库
          </p>

          <div v-if="tab === 'skills' && filteredMarketSkills.length > 0" class="cards">
            <div v-for="item in filteredMarketSkills" :key="item.id" class="card enter-item">
              <button class="card-head" @click.stop="toggleExpanded(item.id)">
                <span class="tile" :class="{ on: item.installed }">
                  <CoomiIcon name="wrench" :size="18" />
                </span>
                <span class="cname">{{ item.name }}</span>
                <span class="stars" :title="`${starsOf(item)} 星`">{{ starText(starsOf(item)) }}</span>
                <span v-if="item.verified" class="badge vrf"><CoomiIcon name="shield" :size="10" />已验证</span>
                <span v-if="item.installed" class="badge ok">已安装</span>
                <CoomiIcon name="chevronRight" :size="14" class="chev" :class="{ open: expanded === item.id }" />
              </button>
              <div v-if="expanded === item.id" class="detail">
                <p class="cdesc">{{ item.description || '（无描述）' }}</p>
                <span class="cmeta"><CoomiIcon name="user" :size="12" />{{ item.author || '—' }}</span>
                <a class="cmeta repo" :href="'https://github.com/' + item.repository" target="_blank">
                  <CoomiIcon name="external" :size="12" />{{ item.repository }}
                </a>
                <span v-if="item.source" class="cmeta"><CoomiIcon name="globe" :size="12" />源: {{ item.source }}</span>
                <span class="cmeta"><CoomiIcon name="shield" :size="12" />{{ item.license || '—' }}</span>
                <span v-if="item.tags?.length" class="cmeta"><CoomiIcon name="search" :size="12" />{{ item.tags.join(' · ') }}</span>
                <div class="heat">
                  <span v-if="heatOf(item).stars != null"><CoomiIcon name="sparkle" :size="11" />{{ fmt(heatOf(item).stars) }} stars</span>
                  <span v-if="heatOf(item).install7d != null"><CoomiIcon name="bolt" :size="11" />周安装 {{ heatOf(item).install7d }}</span>
                  <span v-if="heatOf(item).installTotal != null"><CoomiIcon name="check" :size="11" />累计安装 {{ heatOf(item).installTotal }}</span>
                  <span v-if="heatOf(item).downloads30d"><CoomiIcon name="arrowDown" :size="11" />30天下载 {{ fmt(heatOf(item).downloads30d) }}</span>
                </div>
                <div class="dops">
                  <template v-if="item.installed">
                    <button v-if="item.id !== 'skill-creator'" class="act danger" :disabled="busy !== null" @click.stop="confirmDelete('skill', item)">删除</button>
                    <span v-else class="cmeta">内置 Skill，不可卸载</span>
                  </template>
                  <button v-else class="act" :disabled="busy !== null" @click.stop="confirmSkillInstall(item)">
                    {{ busy === item.id ? '安装中…' : '安装' }}
                  </button>
                  <a class="act link" :href="'https://github.com/' + item.repository" target="_blank">查看仓库</a>
                </div>
              </div>
            </div>
          </div>

          <!-- MCP：收录展示，先看仓库（安装支持 v2） -->
          <div v-if="tab === 'mcp' && filteredMarketMcps.length > 0" class="cards">
            <div v-for="item in filteredMarketMcps" :key="item.id" class="card enter-item">
              <button class="card-head" @click.stop="toggleExpanded(item.id)">
                <span class="tile"><CoomiIcon name="plug" :size="18" /></span>
                <span class="cname">{{ item.name }}</span>
                <span v-if="item.verified" class="badge vrf"><CoomiIcon name="shield" :size="10" />已验证</span>
                <CoomiIcon name="chevronRight" :size="14" class="chev" :class="{ open: expanded === item.id }" />
              </button>
              <div v-if="expanded === item.id" class="detail">
                <p class="cdesc">{{ item.description || '（无描述）' }}</p>
                <a class="cmeta repo" :href="'https://github.com/' + item.repository" target="_blank">
                  <CoomiIcon name="external" :size="12" />{{ item.repository }}
                </a>
              <div class="dops">
                <template v-if="item.installed">
                  <span class="cmeta">已安装</span>
                </template>
                <button v-else class="act" :disabled="busy !== null" @click.stop="confirmMcpInstall(marketMcpToItem(item))">
                  {{ busy === item.id ? '安装中…' : '安装' }}
                </button>
                <a class="act link" :href="'https://github.com/' + item.repository" target="_blank">查看仓库</a>
                </div>
              </div>
            </div>
          </div>

        </template>
      </template>

      <!-- 彻底删除确认（管理页卸载 = 停用可恢复，删除 = 彻底删除） -->
      <div v-if="askDelete" class="sheet-mask enter-flat" @click.self="askDelete = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle">
            <CoomiIcon :name="askDelete.kind === 'mcp' ? 'plug' : 'wrench'" :size="17" />
            彻底删除{{ askDelete.kind === 'mcp' ? ' MCP' : ' Skill' }}「{{ askDelete.item.name }}」？
          </div>
          <p class="sdesc">
            {{ askDelete.kind === 'mcp'
              ? '将从 config/mcp_servers.json 中移除该服务（不可恢复）。若只是想暂时不用，请改用「停用」。'
              : '将删除已安装的 Skill 目录与配置记录（不可恢复）。若只是想暂时不用，请改用「停用」。' }}
          </p>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askDelete = null">取消</button>
            <button class="btn danger-solid" :disabled="busy !== null" @click="deleteItem">确认彻底删除</button>
          </div>
        </div>
      </div>

      <!-- MCP 安装确认 -->
      <div v-if="askMcp" class="sheet-mask enter-flat" @click.self="askMcp = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle"><CoomiIcon name="plug" :size="17" />安装 MCP「{{ askMcp.name }}」？</div>
          <p class="sdesc">{{ askMcp.description }}</p>
          <div class="sinfo">
            <span><CoomiIcon name="link" :size="13" />{{ askMcp.transport }}</span>
            <span><CoomiIcon name="folder" :size="13" />写入 config/mcp_servers.json</span>
            <span><CoomiIcon name="refresh" :size="13" />重启引擎或新开会话后生效</span>
          </div>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askMcp = null">取消</button>
            <button class="btn primary" @click="proceedMcp">继续配置</button>
          </div>
        </div>
      </div>

      <!-- 添加自定义 MCP -->
      <div v-if="addOpen" class="sheet-mask enter-flat" @click.self="addOpen = false">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle">添加自定义 MCP Server</div>
          <p class="sdesc">写入 config/mcp_servers.json，重启引擎或新开会话后生效。</p>
          <label class="form-row"><span>名称</span>
            <input v-model="addForm.name" placeholder="my-server" autocomplete="off" />
          </label>
          <label class="form-row"><span>传输方式</span>
            <UiSelect v-model="addForm.transport" :options="transportOptions" block />
          </label>
          <template v-if="addForm.transport === 'stdio'">
            <label class="form-row"><span>command</span>
              <input v-model="addForm.command" placeholder="npx / uvx / 路径" autocomplete="off" />
            </label>
            <label class="form-row"><span>args（空格分隔）</span>
              <input v-model="addForm.args" placeholder="-y @scope/package /path" autocomplete="off" />
            </label>
          </template>
          <template v-else>
            <label class="form-row"><span>url</span>
              <input v-model="addForm.url" placeholder="https://example.com/mcp" autocomplete="off" />
            </label>
          </template>
          <label class="form-row check"><input v-model="addForm.enabled" type="checkbox" /><span>启用</span></label>
          <div class="sheet-actions">
            <button class="btn ghost" @click="addOpen = false">取消</button>
            <button class="btn primary" :disabled="addBusy" @click="saveCustomMcp">{{ addBusy ? '保存中…' : '保存' }}</button>
          </div>
        </div>
      </div>

      <!-- Skill 安装确认 -->
      <div v-if="askSkill" class="sheet-mask enter-flat" @click.self="askSkill = null">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle"><CoomiIcon name="wrench" :size="17" />安装 Skill「{{ askSkill.name }}」？</div>
          <p class="sdesc">{{ askSkill.description }}</p>
          <div class="sinfo">
            <span v-if="askSkill.repository"><CoomiIcon name="globe" :size="13" />{{ askSkill.repository }}</span>
            <span><CoomiIcon name="folder" :size="13" />安装到 skills 目录</span>
            <span><CoomiIcon name="refresh" :size="13" />重启引擎或新开会话后生效</span>
          </div>
          <div class="sheet-actions">
            <button class="btn ghost" @click="askSkill = null">取消</button>
            <button class="btn primary" :disabled="busy !== null" @click="proceedSkill">
              {{ busy === askSkill.id ? '安装中…' : '确认安装' }}
            </button>
          </div>
        </div>
      </div>

      <!-- MCP 安装参数表单 -->
      <div v-if="installingMcp" class="sheet-mask enter-flat" @click.self="closeInstallForm">
        <div class="sheet">
          <div class="grip" />
          <div class="stitle">配置 {{ installingMcp.name }}</div>
          <p class="sdesc">{{ installingMcp.description }}</p>
          <label v-for="p in installingMcp.required_parameters" :key="p.key" class="field">
            <span>{{ p.label }}<em v-if="!p.secret" class="req">必填</em></span>
            <input
              v-model="installValues[p.key]"
              :type="p.secret ? 'password' : 'text'"
              :placeholder="p.key"
              autocomplete="off"
            />
          </label>
          <p v-if="installingMcp.required_parameters.length === 0" class="sdesc">该 MCP 无需额外配置，直接安装即可。</p>
          <div class="sheet-actions">
            <button class="btn ghost" @click="closeInstallForm">取消</button>
            <button class="btn primary" :disabled="busy !== null || !installReady" @click="installMcp">
              {{ busy === installingMcp.id ? '安装中…' : installReady ? '安装' : '请填写必填项' }}
            </button>
          </div>
        </div>
      </div>
    </main>
  </div>
  <EnvRepairSheet
    v-if="repairOpen"
    :auto-start="repairAutoStart"
    @close="repairOpen = false"
    @ready="onRepairReady"
    @failure="onRepairFailure"
  />
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: 14px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6));
  -webkit-overflow-scrolling: touch; overscroll-behavior-y: contain;
}
.tabs { display: flex; gap: var(--sp-2); margin-bottom: 14px; }
.market-search {
  display: flex; align-items: center; gap: var(--sp-2);
  height: 42px; margin: -2px 0 var(--sp-3); padding: 0 var(--sp-3);
  border-radius: var(--r-card); background: var(--bg); color: var(--text-3);
  box-shadow: var(--shadow-1);
}
.market-search input {
  flex: 1; min-width: 0; border: 0; outline: 0;
  background: none; color: var(--text); font-size: var(--fs-body);
}
.market-search input::placeholder { color: var(--text-3); }
.market-search button {
  display: grid; place-items: center; flex-shrink: 0;
  width: 24px; height: 24px; border-radius: 50%;
  background: var(--fill-strong); color: var(--text-2);
}
.market-toolbar { display: flex; gap: var(--sp-2); margin: -2px 0 var(--sp-3); }
.market-toolbar .market-search { flex: 1; margin: 0; }
.market-source {
  display: flex; align-items: center; gap: 6px; flex-shrink: 0;
  height: 42px; padding: 0 10px;
  border-radius: var(--r-card); background: var(--bg);
  color: var(--text-2); box-shadow: var(--shadow-1);
}
.market-source select {
  max-width: 130px; border: 0; outline: 0;
  background: none; color: var(--text); font-size: var(--fs-sub);
}
.local-install {
  display: inline-flex; align-items: center; gap: 6px; min-height: 40px; padding: 0 14px;
  border: 1px dashed var(--blue-border, var(--blue));
  border-radius: var(--r-card);
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-sub); font-weight: 600;
}
.local-install:disabled { opacity: .6; }
.visually-hidden {
  position: absolute; width: 1px; height: 1px; overflow: hidden;
  clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap;
}
.submit-extension {
  display: flex; align-items: center; justify-content: space-between;
  flex: 1; min-width: 0;
  min-height: 40px; padding: 0 13px;
  border: 1px solid var(--border); border-radius: var(--r-card);
  background: var(--bg); color: var(--blue); font-size: var(--fs-sub); font-weight: 600;
  text-decoration: none;
}
.submit-extension:active { background: var(--blue-soft); }
.seg {
  display: flex; gap: 2px; margin-bottom: var(--sp-3); padding: 3px;
  border-radius: var(--r-pill); background: var(--fill);
  align-self: flex-start;
}
.segitem {
  display: inline-flex; align-items: center; gap: 5px;
  min-height: 30px; padding: 0 13px; border: 0; border-radius: var(--r-pill);
  background: none; font-size: var(--fs-label); font-weight: 600; color: var(--text-3);
}
.segitem.on { background: var(--bg); color: var(--blue); box-shadow: var(--shadow-1); }
.tab {
  flex: 1; display: flex; align-items: center; justify-content: center; gap: 6px;
  min-height: 42px; border-radius: var(--r-md);
  background: var(--fill-strong); color: var(--text-2);
  font-size: var(--fs-body); font-weight: 500;
}
.tab.on { background: var(--blue-soft); color: var(--blue); }
.cnt {
  min-width: 18px; height: 18px; padding: 0 5px; border-radius: var(--r-pill);
  display: inline-flex; align-items: center; justify-content: center;
  background: var(--fill); font-size: var(--fs-caption); font-weight: 600;
}
.tab.on .cnt { background: var(--blue); color: #fff; }

.notice {
  margin: 0 0 var(--sp-3); padding: 10px var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); font-size: var(--fs-sub); line-height: 1.6; color: var(--text);
}
.notice.err { background: var(--danger-soft, #ffeceb); color: var(--danger, #d43d2e); }
.notice.env-missing { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; background: var(--orange-soft); color: var(--orange); }
.notice.env-missing span { flex: 1 1 auto; min-width: 0; }
.notice.env-missing button {
  flex: none; min-height: 30px; padding: 0 var(--sp-3);
  border: 1px solid color-mix(in srgb, var(--orange) 45%, var(--border));
  border-radius: var(--r-pill); background: var(--bg); color: var(--orange);
  font-size: var(--fs-caption); font-weight: 600;
}
.hint { margin: 18px 0; text-align: center; font-size: var(--fs-sub); color: var(--text-3); }
.add-row { margin: 0 0 10px; }
.add-btn {
  display: inline-flex; align-items: center; gap: 6px; min-height: 36px; padding: 0 14px; border-radius: var(--r-md);
  border: 1px dashed var(--blue-border, var(--blue));
  background: var(--blue-soft); color: var(--blue);
  font-size: var(--fs-sub); font-weight: 600;
}
.form-row {
  display: flex; flex-direction: column; gap: 6px;
  margin: 10px 0; font-size: var(--sp-3); color: var(--text-2);
}
.form-row input, .form-row select {min-height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--fill);
  color: var(--text); font-size: var(--fs-body); outline: none; width: 100%;
}
.form-row.check { flex-direction: row; align-items: center; gap: var(--sp-2); }
.form-row.check input { width: auto; height: auto; }

.cards { display: flex; flex-direction: column; gap: var(--sp-2); }
.card {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  padding: 10px var(--sp-3); border-radius: var(--r-card);
  background: var(--bg); box-shadow: var(--shadow-1);
}
/* 卡片头部：整行可点击，折叠时只显示名称。 */
.card-head {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 0;
  padding: 0; border: 0; background: none; text-align: left;
}
.tile {
  flex-shrink: 0; width: 38px; height: 38px; border-radius: var(--r-md);
  display: flex; align-items: center; justify-content: center;
  background: var(--fill-strong); color: var(--text-2);
}
.tile.on { background: var(--blue-soft); color: var(--blue); }
.cname { flex: 1; min-width: 0; font-size: var(--fs-body); font-weight: 600; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  flex-shrink: 0; padding: 1.5px var(--sp-2); border-radius: var(--r-pill);
  font-size: var(--fs-caption); font-weight: 600;
}
.badge.ok { background: var(--ok-soft, #e6f4ea); color: var(--ok, #2e9e5b); }
.badge.off { background: var(--fill); color: var(--text-2); }
.badge.plain { background: var(--fill); color: var(--text-3); }
.badge.vrf { display: inline-flex; align-items: center; gap: 3px; background: var(--blue-soft); color: var(--blue); }
.chev { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.chev.open { transform: rotate(90deg); }
.hint.sub { font-size: var(--fs-caption); }
.hint-link { color: var(--blue); font-weight: 600; }
.cmeta.repo { color: var(--blue); }
/* 热度徽章行 */
.heat {
  display: flex; flex-wrap: wrap; gap: 6px var(--sp-3); margin-top: var(--sp-2);
  font-size: var(--fs-caption); color: var(--text-3);
}
.heat span { display: inline-flex; align-items: center; gap: var(--sp-1); }
.stars { color: var(--orange, #e8a317); font-size: var(--fs-label); letter-spacing: 1px; flex-shrink: 0; }
.progress {
  width: 100%; height: 3px; border-radius: 2px; background: var(--fill);
  overflow: hidden; margin-top: var(--sp-2);
}
.progress i {
  display: block; height: 100%; width: 40%;
  background: var(--blue); border-radius: 2px;
  animation: bar var(--dur-loop) var(--ease-in-out) infinite;
}
/* bar：不确定进度条扫描。保留依据 = 准入测试 —— 表达「目录/市场数据加载中」（进行中语义），
   且只动 transform，不触发布局；单一定义无重复。 */
@keyframes bar {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(250%); }
}
.act.link {
  display: inline-flex; align-items: center; justify-content: center; text-decoration: none;
  background: var(--fill-strong); color: var(--text);
}
/* 展开详情：flex-basis 100% 全宽换行，与头部隔开。 */
.detail {
  flex-basis: 100%; min-width: 0;
  display: flex; flex-direction: column; gap: 2px;
  margin-top: var(--sp-1); padding-top: 9px; border-top: 1px dashed var(--border);
}
.cdesc {
  margin: 0; font-size: var(--fs-label); line-height: 1.55; color: var(--text-2);
  word-break: break-word;
}
.cmeta {
  display: inline-flex; align-items: center; gap: var(--sp-1); margin-top: var(--sp-1);
  font-size: var(--fs-caption); color: var(--text-3);
}
.cmeta.path { display: block; word-break: break-all; }
.dops { display: flex; gap: var(--sp-2); margin-top: 9px; }
.act {
  flex-shrink: 0; min-width: 62px; min-height: 34px; padding: 0 14px; border-radius: var(--r-pill);
  background: var(--blue); color: #fff; font-size: var(--fs-sub); font-weight: 600;
}
.act:active { opacity: 0.85; }
.act:disabled { opacity: 0.5; }
.act.danger { background: var(--danger-soft); color: var(--danger); }
.done { flex-shrink: 0; width: 28px; height: 28px; display: flex; align-items: center; justify-content: center; border-radius: 50%; background: var(--ok-soft, #e6f4ea); color: var(--ok, #2e9e5b); }

/* ── 弹层 ── */
.sheet-mask {
  position: fixed; inset: 0; z-index: 90;
  display: flex; align-items: flex-end; justify-content: center;
  background: rgba(0, 0, 0, 0.45);
  padding: var(--sp-3);
}
.sheet {
  width: 100%; max-width: 460px; padding: 10px 18px 18px;
  border-radius: var(--r-card); background: var(--bg);
  box-shadow: var(--shadow-2);
  /* 浮层弹入：modalIn（已收敛 global.css，语义 = enter-pop），遮罩淡入由 .enter-flat 类负责 */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.grip { width: 36px; height: 4px; margin: 0 auto var(--sp-3); border-radius: 2px; background: var(--fill-strong); }
.stitle {
  display: flex; align-items: center; gap: var(--sp-2);
  font-size: var(--fs-body-lg); font-weight: 600; color: var(--text);
}
.sdesc { margin: var(--sp-2) 0 0; font-size: var(--fs-label); line-height: 1.65; color: var(--text-2); }
.sinfo {
  display: flex; flex-direction: column; gap: 6px; margin-top: var(--sp-3);
  padding: 10px var(--sp-3); border-radius: var(--r-md); background: var(--fill);
  font-size: var(--fs-label); color: var(--text-2);
}
.sinfo span { display: flex; align-items: center; gap: 6px; }
.field { display: flex; flex-direction: column; gap: 5px; margin-top: var(--sp-3); font-size: var(--fs-label); color: var(--text-2); }
.req { margin-left: 5px; padding: 0 5px; border-radius: 4px; background: var(--blue-soft); color: var(--blue); font-style: normal; font-size: var(--fs-caption); font-weight: 600; }
.field input {
  min-height: 42px; padding: 0 var(--sp-3); border-radius: var(--r-md); border: 1px solid var(--border);
  background: var(--bg-input); color: var(--text); font-size: var(--fs-body-lg);
}
.sheet-actions { display: flex; gap: 10px; margin-top: 18px; }
.sheet-actions .btn { flex: 1; }
.btn { min-height: 42px; border-radius: var(--r-md); font-size: var(--fs-body); font-weight: 600; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.btn.danger-solid { background: var(--danger, #d43d2e); color: #fff; }
.btn:disabled { opacity: 0.6; }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
