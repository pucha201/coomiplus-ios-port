<script setup lang="ts">
/**
 * 拓展中心。
 *
 * 设计目标（对标 Claude Desktop / Cursor / Cherry Studio）：
 *  - 一级只分「发现 / 已安装」，类型用 chips，不再套两层 tab；
 *  - 搜索始终可见，卡片直接给状态和动作，不藏在展开层；
 *  - 安装是一条路径：零配置一键装，需要配置的一次填完，安装有日志与进度；
 *  - 装完自动启用、热重载，不再要求重启引擎；
 *  - 高级能力保留：JSON 导入、MCP 配置编辑、Skill 链接安装、本地 ZIP。
 */
import { computed, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import EnvRepairSheet from '@/components/EnvRepairSheet.vue'
import RuntimeEnvSheet from '@/components/RuntimeEnvSheet.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import { apiGet, authedFetch } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { zhName, zhDesc, softenEn } from '@/utils/catalogZh'

type Tab = 'discover' | 'installed'
type Kind = 'all' | 'mcp' | 'skill'
type Source = 'all' | 'catalog' | 'market'

interface RequiredParameter { key: string; label: string; secret?: boolean }
interface RawMcp {
  id: string; name: string; description: string; transport?: string
  command?: string; args?: string[]; env?: Record<string, string>
  url?: string; required_parameters?: RequiredParameter[]
  requires?: string[]; platforms?: string[]
  installed?: boolean; enabled?: boolean; available?: boolean; unavailable_reason?: string
  version?: string; publisher?: string; registry_name?: string; repository?: string
}
interface RawSkill {
  id: string; name: string; description: string; repository?: string
  ref?: string; subdir?: string; author?: string; tags?: string[]
  license?: string; verified?: boolean; installed?: boolean; enabled?: boolean
  available?: boolean; unavailable_reason?: string; platforms?: string[]
  version?: string; publisher?: string
}
interface Item {
  kind: 'mcp' | 'skill'
  id: string
  name: string
  description: string
  transport?: string
  command?: string
  args?: string[]
  env?: Record<string, string>
  url?: string
  requiredParameters?: RequiredParameter[]
  requires?: string[]
  platforms?: string[]
  repository?: string
  gitRef?: string
  subdir?: string
  author?: string
  tags?: string[]
  license?: string
  verified?: boolean
  available: boolean
  unavailableReason?: string
  installed: boolean
  enabled: boolean
  status?: string
  error?: string
  toolsCount?: number
  path?: string
  source?: string
  sourceId?: string
  sourceName?: string
  version?: string
  publisher?: string
  registryName?: string
}

const router = useRouter()
const tab = ref<Tab>('discover')
const kind = ref<Kind>('all')
const query = ref('')
const loading = ref(true)
const error = ref('')
const notice = ref('')
const source = ref<Source>('all')

const rawCatalogMcp = ref<RawMcp[]>([])
const rawCatalogSkills = ref<RawSkill[]>([])
const installedMcp = ref<any[]>([])
const installedSkills = ref<any[]>([])

const marketMcp = ref<Item[]>([])
const marketSkills = ref<Item[]>([])
const marketSources = ref<{ id: string; name: string; url: string; kind: string; builtin: boolean }[]>([])
const activeMarketSource = ref('official')
const marketLoading = ref(false)
const marketUpdatedAt = ref('')
const marketStatus = ref<{ name?: string; kind?: string; count?: number; error?: string } | null>(null)

const activeMarket = computed(() => marketSources.value.find(item => item.id === activeMarketSource.value))
const activeMarketKind = computed(() => activeMarket.value?.kind || 'coomi')
const activeMarketName = computed(() => activeMarket.value?.name || 'Coomi 官方源')
const catalogCount = computed(() => rawCatalogMcp.value.length + rawCatalogSkills.value.length)
const marketCount = computed(() => marketMcp.value.length + marketSkills.value.length)
const installedCount = computed(() => installedMcp.value.length + installedSkills.value.length)

function installedMcpFor(id: string) {
  return installedMcp.value.find(item => String(item.id || '').toLowerCase() === id.toLowerCase())
}
function installedSkillFor(id: string) {
  return installedSkills.value.find(item => String(item.id || '').toLowerCase() === id.toLowerCase())
}

function catalogMcpItem(raw: RawMcp): Item {
  const installed = installedMcpFor(raw.id)
  return {
    kind: 'mcp',
    id: raw.id,
    name: zhName(raw.id, raw.name),
    description: zhDesc(raw.id, raw.description || ''),
    transport: raw.transport || 'stdio',
    command: raw.command || '',
    args: raw.args || [],
    env: raw.env || {},
    url: raw.url || '',
    requiredParameters: raw.required_parameters || [],
    requires: raw.requires || [],
    platforms: raw.platforms || [],
    available: raw.available !== false,
    unavailableReason: raw.unavailable_reason || '',
    installed: Boolean(installed || raw.installed),
    enabled: Boolean(installed?.enabled ?? raw.enabled),
    status: installed?.status || '',
    error: installed?.error || '',
    toolsCount: installed?.tools_count || 0,
    path: installed?.path || '',
    source: 'catalog',
    sourceName: '内置',
  }
}

function catalogSkillItem(raw: RawSkill): Item {
  const installed = installedSkillFor(raw.id)
  return {
    kind: 'skill',
    id: raw.id,
    name: zhName(raw.id, raw.name),
    description: zhDesc(raw.id, raw.description || ''),
    repository: raw.repository || '',
    gitRef: raw.ref || 'main',
    subdir: raw.subdir || '',
    platforms: raw.platforms || [],
    available: raw.available !== false,
    unavailableReason: raw.unavailable_reason || '',
    installed: Boolean(installed || raw.installed),
    enabled: Boolean(installed?.enabled ?? raw.enabled),
    path: installed?.path || '',
    source: 'catalog',
    sourceName: '内置',
  }
}

function marketItem(raw: any, itemKind: 'mcp' | 'skill'): Item {
  const installed = itemKind === 'mcp' ? installedMcpFor(raw.id) : installedSkillFor(raw.id)
  return {
    kind: itemKind,
    id: raw.id,
    name: zhName(raw.id, raw.name || raw.id),
    description: zhDesc(raw.id, softenEn(raw.description || '')),
    transport: raw.transport || (raw.command ? 'stdio' : (raw.url ? 'http' : 'stdio')),
    command: raw.command || '',
    args: raw.args || [],
    env: raw.env || {},
    url: raw.url || '',
    requiredParameters: raw.required_parameters || [],
    requires: raw.requires || [],
    platforms: raw.platforms || [],
    repository: raw.repository || '',
    gitRef: raw.ref || 'main',
    subdir: raw.subdir || '',
    author: raw.author || '',
    tags: raw.tags || [],
    license: raw.license || '',
    verified: Boolean(raw.verified),
    available: raw.available !== false,
    unavailableReason: raw.unavailable_reason || '',
    installed: Boolean(installed || raw.installed),
    enabled: Boolean(installed?.enabled),
    status: installed?.status || '',
    error: installed?.error || '',
    toolsCount: installed?.tools_count || 0,
    path: installed?.path || '',
    source: 'market',
    sourceId: raw.source || activeMarketSource.value,
    sourceName: raw.source || activeMarketName.value,
    version: raw.version || '',
    publisher: raw.publisher || '',
    registryName: raw.registry_name || '',
  }
}

function installedItem(raw: any, itemKind: 'mcp' | 'skill'): Item {
  const catalog: any = itemKind === 'mcp'
    ? rawCatalogMcp.value.find(entry => entry.id.toLowerCase() === String(raw.id || '').toLowerCase())
    : rawCatalogSkills.value.find(entry => entry.id.toLowerCase() === String(raw.id || '').toLowerCase())
  return {
    kind: itemKind,
    id: String(raw.id || raw.name || ''),
    name: catalog ? zhName(catalog.id, catalog.name) : (raw.name || raw.id),
    description: catalog ? zhDesc(catalog.id, catalog.description || '') : (raw.description || ''),
    transport: raw.transport || catalog?.transport || (itemKind === 'mcp' ? 'stdio' : undefined),
    command: raw.command || catalog?.command || '',
    args: catalog?.args || [],
    env: catalog?.env || {},
    requiredParameters: catalog?.required_parameters || [],
    requires: catalog?.requires || [],
    repository: catalog?.repository || '',
    available: true,
    installed: true,
    enabled: Boolean(raw.enabled),
    status: raw.status || '',
    error: raw.error || '',
    toolsCount: raw.tools_count || 0,
    path: raw.path || '',
    source: raw.source || (catalog ? 'catalog' : 'manual'),
    sourceName: catalog ? '内置' : '自定义',
  }
}

function itemKey(item: Item): string {
  return `${item.kind}:${item.id.toLowerCase()}`
}

const discoverItems = computed<Item[]>(() => {
  const catalog = [
    ...rawCatalogMcp.value.map(catalogMcpItem),
    ...rawCatalogSkills.value.map(catalogSkillItem),
  ]
  const market = [...marketMcp.value, ...marketSkills.value]
  if (source.value === 'catalog') return catalog
  if (source.value === 'market') return market
  // 全部：内置优先，社区同 id 去重；内置目录永远可离线打开。
  const seen = new Set(catalog.map(itemKey))
  return [...catalog, ...market.filter(item => !seen.has(itemKey(item)))]
})

const installedItems = computed<Item[]>(() => [
  ...installedMcp.value.map(item => installedItem(item, 'mcp')),
  ...installedSkills.value.map(item => installedItem(item, 'skill')),
])

const visibleItems = computed<Item[]>(() => {
  const base = tab.value === 'installed' ? installedItems.value : discoverItems.value
  const needle = query.value.trim().toLowerCase()
  const filtered = base.filter(item => {
    if (kind.value !== 'all' && item.kind !== kind.value) return false
    if (!needle) return true
    return [item.id, item.name, item.description, item.repository, item.author, item.publisher, ...(item.tags || [])]
      .some(value => String(value || '').toLowerCase().includes(needle))
  })
  return filtered.sort((left, right) => {
    if (tab.value === 'installed') {
      const leftBad = left.status === 'error' ? 0 : 1
      const rightBad = right.status === 'error' ? 0 : 1
      if (leftBad !== rightBad) return leftBad - rightBad
      if (left.enabled !== right.enabled) return left.enabled ? -1 : 1
    } else {
      if (left.available !== right.available) return left.available ? -1 : 1
      if (left.installed !== right.installed) return left.installed ? 1 : -1
    }
    return left.name.localeCompare(right.name, 'zh-CN')
  })
})

const emptyText = computed(() => {
  if (query.value.trim()) return `没有找到“${query.value.trim()}”相关的拓展。`
  if (tab.value === 'installed') return '还没有安装任何拓展。'
  if (source.value === 'market') {
    if (marketStatus.value?.error) return marketStatus.value.error
    return '这个源暂时没有可展示的条目，可以换源或在「源管理」里添加自己的 registry。'
  }
  return '目录为空。'
})


async function readJson(res: Response): Promise<any> {
  const text = await res.text()
  try { return text ? JSON.parse(text) : {} } catch { return { error: text } }
}
async function parseRes(res: Response): Promise<any> {
  const data = await readJson(res)
  if (!res.ok) throw new Error(data.error || data.message || `请求失败（HTTP ${res.status}）`)
  if (data && typeof data === 'object' && data.error && !data.ok) throw new Error(String(data.error))
  return data
}

/** 把「响应不是 JSON / 一坨 HTML」统一收成一句人话。 */
function friendlyError(raw: string): string {
  const text = (raw || '').trim()
  if (!text) return '未知错误'
  if (text.startsWith('<') || /<!doctype/i.test(text)) {
    return '电脑端返回了网页而不是数据，通常是引擎没连上或版本不匹配'
  }
  return text.length > 200 ? text.slice(0, 200) + '…' : text
}

async function refreshAll() {
  loading.value = true
  error.value = ''
  try {
    const [catalog, installed] = await Promise.all([
      apiGet<{ mcp?: RawMcp[]; skills?: RawSkill[] }>('/api/catalog'),
      apiGet<{ mcp?: any[]; skills?: any[] }>('/api/runtime/installed'),
    ])
    rawCatalogMcp.value = catalog.mcp || []
    rawCatalogSkills.value = catalog.skills || []
    installedMcp.value = installed.mcp || []
    installedSkills.value = installed.skills || []
    // 市场条目在加载时把 installed 快照进去了；安装/删除后必须重新拉一次，
    // 否则卡片还显示“安装”。
    if (source.value !== 'catalog' && (marketMcp.value.length || marketSkills.value.length)) {
      await loadMarket()
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

async function loadSources() {
  try {
    const data = await parseRes(await authedFetch('/api/registry/sources'))
    marketSources.value = data.sources || []
    if (data.active) activeMarketSource.value = data.active
  } catch { /* 源列表失败不影响内置目录 */ }
}

let searchTimer: ReturnType<typeof setTimeout> | null = null

async function loadMarket() {
  marketLoading.value = true
  error.value = ''
  try {
    const params = new URLSearchParams()
    params.set('source', activeMarketSource.value)
    // 官方 MCP Registry 条目太多，搜索交给服务端；Coomi 源本地过滤即可。
    if (query.value.trim() && activeMarketKind.value === 'mcp-registry') {
      params.set('q', query.value.trim())
    }
    const data = await parseRes(await authedFetch('/api/registry?' + params.toString()))
    const remote = data.remote || {}
    marketMcp.value = (remote.mcps || []).map((item: any) => marketItem(item, 'mcp'))
    marketSkills.value = (remote.skills || []).map((item: any) => marketItem(item, 'skill'))
    marketUpdatedAt.value = remote.updated_at || ''
    marketStatus.value = data.registry_status || null
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    marketLoading.value = false
  }
}

/** 来源按钮上的字：全部 / 内置 / 当前社区源名。 */
function sourceLabelOfCurrent(): string {
  if (source.value === 'catalog') return '内置'
  if (source.value === 'market') return activeMarketName.value
  return '全部来源'
}

async function switchSource(next: Source) {
  source.value = next
  notice.value = ''
  if (next !== 'catalog') {
    if (marketSources.value.length === 0) await loadSources()
    if (next === 'market' || marketMcp.value.length + marketSkills.value.length === 0) {
      await loadMarket()
    }
  }
}

/** 弹层里的「显示范围」：选完即收起，回到列表。 */
async function pickScope(next: Source) {
  await switchSource(next)
  sourcesOpen.value = false
}

function switchTab(next: Tab) {
  tab.value = next
  notice.value = ''
}

watch(query, () => {
  if (searchTimer) clearTimeout(searchTimer)
  if (source.value !== 'catalog' && activeMarketKind.value === 'mcp-registry') {
    searchTimer = setTimeout(() => { void loadMarket() }, 450)
  }
})

// ── 安装进度 ──
const progressOpen = ref(false)
const progressTitle = ref('')
const progressPhase = ref('排队中')
const progressLog = ref('')
const progressError = ref('')
const progressElapsed = ref(0)
const progressDone = ref(false)
const progressRetry = ref<(() => void) | null>(null)
let pollHandle: ReturnType<typeof setInterval> | null = null

function stopPolling() {
  if (pollHandle) clearInterval(pollHandle)
  pollHandle = null
}

function lastLogLine(): string {
  const lines = progressLog.value.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.length ? String(lines[lines.length - 1]) : ''
}

async function trackTask(
  taskId: string,
  title: string,
  after: (() => Promise<void>) | null,
  successText = '安装完成，已自动启用。',
) {
  stopPolling()
  progressOpen.value = true
  progressTitle.value = title
  progressPhase.value = '排队中'
  progressLog.value = ''
  progressError.value = ''
  progressElapsed.value = 0
  progressDone.value = false
  const started = Date.now()
  const tick = async () => {
    try {
      const detail = await apiGet<any>(`/api/task-details/${encodeURIComponent(taskId)}`)
      const task = detail.task || {}
      const status = String(task.status || '')
      if (status) progressPhase.value = status
      if (task.error) progressError.value = String(task.error)
      progressElapsed.value = Math.round((Date.now() - started) / 1000)
      try {
        const logRes = await authedFetch(`/api/tasks/${encodeURIComponent(taskId)}/log?lines=80`)
        if (logRes.ok) {
          const log = await readJson(logRes)
          if (Array.isArray(log.lines)) progressLog.value = log.lines.join('\n')
        }
      } catch { /* 日志晚一点出现不影响状态 */ }
      if (['completed', 'failed', 'cancelled', 'interrupted'].includes(status)) {
        stopPolling()
        progressDone.value = true
        progressPhase.value = status === 'completed' ? '完成' : '失败'
        if (status === 'completed') {
          progressError.value = ''
          try {
            await after?.()
            notice.value = successText
          } catch (reason) {
            progressError.value = reason instanceof Error ? reason.message : String(reason)
          }
        } else if (!progressError.value) {
          progressError.value = lastLogLine() || '安装失败'
        }
      }
    } catch (reason) {
      progressError.value = reason instanceof Error ? reason.message : String(reason)
    }
  }
  pollHandle = setInterval(() => { void tick() }, 900)
  await tick()
}

function closeProgress() {
  stopPolling()
  progressOpen.value = false
}
function retryInstall() {
  const retry = progressRetry.value
  progressOpen.value = false
  stopPolling()
  retry?.()
}

async function enableAfter(kind: 'mcp' | 'skill', id: string) {
  const resource = kind === 'mcp' ? 'mcp' : 'skills'
  try {
    await parseRes(await authedFetch(`/api/catalog/${resource}/${encodeURIComponent(id)}/enabled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: true }),
    }))
  } catch { /* 安装成功但启用失败时，下面 refresh 的状态会显示出来 */ }
}

async function reindexSkills() {
  try { await parseRes(await authedFetch('/api/plugins/reindex-skills', { method: 'POST' })) } catch { /* best effort */ }
}

// ── MCP 配置 ──
const configOpen = ref(false)
const configMode = ref<'install' | 'edit'>('install')
const configItem = ref<Item | null>(null)
const configId = ref('')
const installValues = reactive<Record<string, string>>({})
const config = reactive({
  name: '', transport: 'stdio', command: '', argsText: '', url: '',
  envText: '', headersText: '', cwd: '', enabled: true,
})
const configBusy = ref(false)

const transportOptions = [
  { value: 'stdio', label: 'stdio（本地命令）' },
  { value: 'http', label: 'HTTP / Streamable' },
  { value: 'sse', label: 'SSE' },
]

function parseLines(text: string): string[] {
  return text.split('\n').map(line => line.trim()).filter(Boolean)
}
function parseKeyValues(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of parseLines(text)) {
    if (line.startsWith('#')) continue
    const index = line.indexOf('=')
    if (index <= 0) continue
    const key = line.slice(0, index).trim()
    if (key) out[key] = line.slice(index + 1).trim()
  }
  return out
}
function kvText(values: Record<string, string> | undefined): string {
  return Object.entries(values || {}).map(([key, value]) => `${key}=${value}`).join('\n')
}
function substitute(text: string, values: Record<string, string>): string {
  return String(text || '').replace(/\{\{(\w+)\}\}/g, (_, key: string) => values[key] ?? '')
}
function sanitizeId(raw: string): string {
  let out = ''
  for (const ch of (raw || '').trim().toLowerCase()) {
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) out += ch
    else if (out.length > 0 && !out.endsWith('-')) out += '-'
  }
  return out.replace(/^-+/, '').replace(/-+$/, '') || 'mcp-server'
}

function fillConfig(item: Item | null, mode: 'install' | 'edit') {
  configMode.value = mode
  configItem.value = item
  configId.value = item?.id || ''
  for (const parameter of item?.requiredParameters || []) installValues[parameter.key] = ''
  config.name = item?.id || item?.name || ''
  config.transport = item?.transport || 'stdio'
  config.command = item?.command || ''
  config.argsText = (item?.args || []).join('\n')
  config.url = item?.url || ''
  config.envText = kvText(item?.env)
  config.headersText = ''
  config.cwd = ''
  config.enabled = true
}

function openInstallConfig(item: Item) {
  fillConfig(item, 'install')
  configOpen.value = true
}

async function openEditConfig(item: Item) {
  fillConfig(item, 'edit')
  try {
    const data = await apiGet<{ servers?: Record<string, any> }>('/api/settings/mcp')
    const servers = data.servers || {}
    const key = Object.keys(servers).find(name =>
      name.toLowerCase() === item.id.toLowerCase() || name.toLowerCase() === item.name.toLowerCase(),
    )
    if (key) {
      const server = servers[key] || {}
      configId.value = key
      config.name = key
      config.transport = server.transport || 'stdio'
      config.command = server.command || ''
      config.argsText = (server.args || []).join('\n')
      config.url = server.url || ''
      config.envText = kvText(server.env)
      config.headersText = kvText(server.headers)
      config.cwd = server.cwd || ''
      config.enabled = server.enabled !== false
    }
  } catch (reason) {
    notice.value = '读取现有配置失败：' + (reason instanceof Error ? reason.message : String(reason))
  }
  configOpen.value = true
}

function buildMcpPayload(item: Item): Record<string, unknown> {
  const values = { ...installValues }
  const args = config.argsText.trim()
    ? parseLines(config.argsText).map(value => substitute(value, values))
    : (item.args || []).map(value => substitute(value, values))
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(item.env || {})) env[key] = substitute(value, values)
  for (const [key, value] of Object.entries(parseKeyValues(config.envText))) {
    env[key] = substitute(value, values)
  }
  const headers: Record<string, string> = {}
  for (const [key, value] of Object.entries(parseKeyValues(config.headersText))) {
    headers[key] = substitute(value, values)
  }
  const payload: Record<string, unknown> = {
    // 目录条目固定用目录 id 作为配置键：翻译后的展示名不能变成 mcp_servers.json 的键。
    name: item.source === 'catalog' ? item.id : (config.name.trim() || item.id || item.name),
    transport: config.transport,
    command: config.command.trim() || item.command || '',
    args,
    env,
    url: config.url.trim() || item.url || '',
    cwd: config.cwd.trim(),
    enabled: config.enabled,
    headers,
  }
  return payload
}

function hasAdvancedConfig(item: Item): boolean {
  return Boolean(
    config.headersText.trim()
    || config.cwd.trim()
    || config.envText.trim()
    || config.argsText.trim() !== (item.args || []).join('\n').trim(),
  )
}

async function saveMcpConfig(item: Item, mode: 'install' | 'edit') {
  const values = { ...installValues }
  const missing = (item.requiredParameters || []).filter(parameter => !String(values[parameter.key] || '').trim())
  if (item.kind === 'mcp' && mode === 'install' && missing.length > 0) {
    notice.value = `请填写：${missing.map(parameter => parameter.label).join('、')}`
    return
  }
  const payload = buildMcpPayload(item)
  if (mode === 'install' && !String(payload.name || '').trim()) {
    notice.value = '请填写名称（作为 mcp_servers.json 的键）'
    return
  }
  if (payload.transport === 'stdio' && !String(payload.command || '').trim()) {
    notice.value = 'stdio 需要 command'
    return
  }
  if ((payload.transport === 'http' || payload.transport === 'sse') && !String(payload.url || '').trim()) {
    notice.value = 'HTTP / SSE 需要 url'
    return
  }
  if (mode === 'install' && item.source === 'catalog') {
    await installCatalogMcp(item, values, hasAdvancedConfig(item) ? payload : null)
    return
  }
  if (mode === 'install') {
    await installRemoteMcp(item, payload)
    return
  }
  configBusy.value = true
  notice.value = ''
  try {
    const id = sanitizeId(configId.value || item.id || config.name)
    const data = await putMcpConfig(id, payload)
    configOpen.value = false
    if (data.error) {
      notice.value = `已保存「${data.name || item.name}」，但连接失败：${data.error}`
      const repairing = await autoRepairFor(String(data.error), () => { void saveMcpConfig(item, mode) })
      if (repairing) notice.value = `已保存「${data.name || item.name}」，检测到缺少运行时，正在自动安装依赖；完成后会自动重试连接。`
    } else {
      notice.value = `已保存并连接「${data.name || item.name}」，工具 ${data.tools_count || 0} 个。`
    }
    await refreshAll()
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    notice.value = '保存失败：' + message
    await autoRepairFor(message, () => { void saveMcpConfig(item, mode) })
  } finally {
    configBusy.value = false
  }
}

async function putMcpConfig(id: string, payload: Record<string, unknown>): Promise<any> {
  const res = await authedFetch(`/api/catalog/mcp/${encodeURIComponent(id)}/configure`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const data = await readJson(res)
  if (!res.ok && res.status !== 502) {
    throw new Error(data.error || `保存失败（HTTP ${res.status}）`)
  }
  return data
}

/// 社区/自定义 MCP：先落地为「停用」，把 npx/uvx 包预下载完再启用。
/// 首启冷下载经常超过 MCP 60s 握手上限，这是「装了但连不上」的主要来源。
async function installRemoteMcp(item: Item, payload: Record<string, unknown>) {
  configOpen.value = false
  configBusy.value = true
  installingId.value = installKey(item)
  notice.value = ''
  const key = String(payload.name || item.id)
  progressRetry.value = () => { void installRemoteMcp(item, payload) }
  try {
    if (payload.transport === 'stdio') {
      await putMcpConfig(key, { ...payload, enabled: false })
      try {
        const prep = await parseRes(await authedFetch(`/api/catalog/mcp/${encodeURIComponent(key)}/prepare`, { method: 'POST' }))
        if (prep.task_id) {
          await trackTask(prep.task_id, `准备 ${item.name} 的运行依赖`, null, '依赖已就绪。')
        }
      } catch (reason) {
        notice.value = `配置已保存；依赖预下载未执行：${reason instanceof Error ? reason.message : String(reason)}`
      }
      await enableAfter('mcp', key)
      await testConnection({ ...item, id: key }, true)
      await refreshAll()
      return
    }
    const data = await putMcpConfig(key, payload)
    if (data.error) {
      notice.value = `已保存「${data.name || item.name}」，但连接失败：${data.error}${mcpErrorHint(data.error)}`
      await autoRepairFor(String(data.error), () => { void installRemoteMcp(item, payload) })
    } else {
      notice.value = `已保存并连接「${data.name || item.name}」，工具 ${data.tools_count || 0} 个。`
    }
    await refreshAll()
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    notice.value = '保存失败：' + message
    await autoRepairFor(message, () => { void installRemoteMcp(item, payload) })
  } finally {
    configBusy.value = false
    installingId.value = ''
  }
}

async function saveConfigSheet() {
  if (!configItem.value) return
  await saveMcpConfig(configItem.value, configMode.value)
}

async function installCatalogMcp(item: Item, values: Record<string, string>, advanced: Record<string, unknown> | null) {
  configOpen.value = false
  notice.value = ''
  installingId.value = installKey(item)
  progressRetry.value = () => { void installCatalogMcp(item, values, advanced) }
  try {
    const data = await parseRes(await authedFetch('/api/catalog/mcp/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: item.id, values }),
    }))
    if (!data.task_id) throw new Error('安装任务没有返回 task_id')
    await trackTask(data.task_id, `安装 ${item.name}`, async () => {
      if (advanced) {
        const id = sanitizeId(item.id)
        const res = await authedFetch(`/api/catalog/mcp/${encodeURIComponent(id)}/configure`, {
          method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(advanced),
        })
        const extra = await readJson(res)
        if (!res.ok && res.status !== 502) throw new Error(extra.error || '写入高级配置失败')
        if (extra.error) notice.value = `已安装，但连接失败：${extra.error}`
      }
      await enableAfter('mcp', item.id)
      await refreshAll()
    })
    const installed = installedMcpFor(item.id)
    if (installed?.status === 'error' && installed.error) {
      notice.value = `已安装，但连接失败：${installed.error}${mcpErrorHint(installed.error)}`
    }
  } catch (reason) {
    progressOpen.value = false
    stopPolling()
    const message = reason instanceof Error ? reason.message : String(reason)
    notice.value = '安装失败：' + message
    await autoRepairFor(message, () => { void installCatalogMcp(item, values, advanced) })
  } finally {
    installingId.value = ''
  }
}

async function installMcpDirect(item: Item) {
  await saveMcpConfig(item, 'install')
}

async function installSkillCatalog(item: Item) {
  notice.value = ''
  installingId.value = installKey(item)
  progressRetry.value = () => { void installSkillCatalog(item) }
  try {
    const data = await parseRes(await authedFetch('/api/catalog/skills/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: item.id }),
    }))
    if (!data.task_id) throw new Error('安装任务没有返回 task_id')
    await trackTask(data.task_id, `安装 ${item.name}`, async () => {
      await enableAfter('skill', item.id)
      await reindexSkills()
      await refreshAll()
    })
  } catch (reason) {
    progressOpen.value = false
    stopPolling()
    const message = reason instanceof Error ? reason.message : String(reason)
    notice.value = '安装失败：' + message
    await autoRepairFor(message, () => { void installSkillCatalog(item) })
  } finally {
    installingId.value = ''
  }
}

async function installSkillRemote(item: Item) {
  notice.value = ''
  installingId.value = installKey(item)
  progressRetry.value = () => { void installSkillRemote(item) }
  try {
    const res = await authedFetch('/api/catalog/skills/install-remote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: item.id, name: item.name, description: item.description,
        repository: item.repository || '', ref: item.gitRef || 'main', subdir: item.subdir || '',
        url: item.repository ? undefined : item.id,
      }),
    })
    const data = await parseRes(res)
    if (data.task_id) {
      await trackTask(data.task_id, `安装 ${item.name}`, async () => {
        await enableAfter('skill', item.id)
        await reindexSkills()
        await refreshAll()
      }, `已安装并启用 Skill「${item.name}」。`)
    } else {
      await enableAfter('skill', item.id)
      await reindexSkills()
      await refreshAll()
      notice.value = `已安装并启用 Skill「${item.name}」。`
    }
  } catch (reason) {
    const message = reason instanceof Error ? reason.message : String(reason)
    notice.value = '安装失败：' + message
    await autoRepairFor(message, () => { void installSkillRemote(item) })
  } finally {
    installingId.value = ''
  }
}

function installItem(item: Item) {
  notice.value = ''
  if (item.kind === 'skill') {
    if (item.source === 'market' || item.repository) void installSkillRemote(item)
    else void installSkillCatalog(item)
    return
  }
  if (item.requiredParameters?.length) {
    openInstallConfig(item)
    return
  }
  if (item.source === 'catalog') {
    void installCatalogMcp(item, {}, null)
  } else {
    fillConfig(item, 'install')
    void installMcpDirect(item)
  }
}

async function toggleEnabled(item: Item, next: boolean) {
  const resource = item.kind === 'mcp' ? 'mcp' : 'skills'
  try {
    await parseRes(await authedFetch(`/api/catalog/${resource}/${encodeURIComponent(item.id)}/enabled`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: next }),
    }))
    notice.value = `${next ? '已启用' : '已停用'}「${item.name}」。`
    await refreshAll()
  } catch (reason) {
    notice.value = `${next ? '启用' : '停用'}失败：` + (reason instanceof Error ? reason.message : String(reason))
  }
}

async function reconnectMcp() {
  notice.value = '正在重连 MCP…'
  try {
    const data = await parseRes(await authedFetch('/api/mcp/reload', { method: 'POST' }))
    notice.value = `MCP 已重连：${data.servers || 0} 个服务，${data.tools || 0} 个工具。`
    await refreshAll()
  } catch (reason) {
    notice.value = '重连失败：' + (reason instanceof Error ? reason.message : String(reason))
  }
}

const mcpBusyId = ref('')
const installingId = ref('')

function installKey(item: Item): string {
  return `${item.kind}:${item.id}`
}
function isInstalling(item: Item): boolean {
  return installingId.value === installKey(item)
}
async function retryItem(item: Item) {
  if (item.kind === 'mcp') {
    if (item.command) await prepareMcp(item)
    else await testConnection(item)
    return
  }
  if (item.source === 'market' || item.repository) await installSkillRemote(item)
  else await installSkillCatalog(item)
}

function mcpErrorHint(message?: string): string {
  const text = String(message || '')
  if (!text) return ''
  if (/ECONNREFUSED|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|ECONNRESET|getaddrinfo|network|timed out|超时/i.test(text)) {
    return '（网络或远程服务不可达，检查网络 / 代理后重试）'
  }
  if (/npm ERR|EACCES|ENOENT|not found|找不到命令|Cannot find (module|package)/i.test(text)) {
    return '（依赖没有下载成功，点「准备依赖」重试）'
  }
  if (/401|403|invalid.*token|unauthorized|api.?key/i.test(text)) {
    return '（凭证无效，点「配置」检查环境变量）'
  }
  return ''
}

async function testConnection(item: Item, silent = false): Promise<boolean> {
  mcpBusyId.value = item.id
  try {
    const data = await parseRes(await authedFetch(`/api/catalog/mcp/${encodeURIComponent(item.id)}/test`, { method: 'POST' }))
    if (data.ok) {
      notice.value = `「${item.name}」连接正常：${data.tools_count || 0} 个工具。`
    } else {
      notice.value = `「${item.name}」连接失败：${data.error || '未知错误'}${mcpErrorHint(data.error)}`
    }
    await refreshAll()
    return Boolean(data.ok)
  } catch (reason) {
    if (!silent) {
      notice.value = '测试连接失败：' + (reason instanceof Error ? reason.message : String(reason))
    }
    return false
  } finally {
    mcpBusyId.value = ''
  }
}

async function prepareMcp(item: Item) {
  if (mcpBusyId.value) return
  mcpBusyId.value = item.id
  notice.value = ''
  try {
    const data = await parseRes(await authedFetch(`/api/catalog/mcp/${encodeURIComponent(item.id)}/prepare`, { method: 'POST' }))
    if (!data.task_id) throw new Error('准备任务没有返回 task_id')
    await trackTask(data.task_id, `准备 ${item.name} 的运行依赖`, async () => {
      await testConnection(item, true)
    }, '依赖已就绪，连接结果见上方提示。')
  } catch (reason) {
    notice.value = '准备依赖失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    mcpBusyId.value = ''
  }
}

async function rollbackSkill(item: Item) {
  try {
    await parseRes(await authedFetch(`/api/catalog/skills/${encodeURIComponent(item.id)}/rollback`, { method: 'POST' }))
    notice.value = `已回滚「${item.name}」。`
    await refreshAll()
  } catch (reason) {
    notice.value = '回滚失败：' + (reason instanceof Error ? reason.message : String(reason))
  }
}

// ── 删除 ──
const deleteTarget = ref<Item | null>(null)
const deleteBusy = ref(false)
async function confirmDelete() {
  const item = deleteTarget.value
  if (!item) return
  deleteBusy.value = true
  try {
    const resource = item.kind === 'mcp' ? 'mcp' : 'skills'
    await parseRes(await authedFetch(`/api/catalog/${resource}/${encodeURIComponent(item.id)}`, { method: 'DELETE' }))
    notice.value = `已删除「${item.name}」。`
    deleteTarget.value = null
    await refreshAll()
  } catch (reason) {
    notice.value = '删除失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    deleteBusy.value = false
  }
}

// ── 详情 ──
const detailItem = ref<Item | null>(null)
function openDetail(item: Item) { detailItem.value = item }
function closeDetail() { detailItem.value = null }

// ── 导入 JSON / 自定义 MCP / Skill URL ──
const importOpen = ref(false)
const importText = ref('')
const importBusy = ref(false)
const skillUrlOpen = ref(false)
const skillUrl = ref('')
const skillUrlBusy = ref(false)

function openCustomMcp() {
  const item: Item = {
    kind: 'mcp', id: '', name: '', description: '', transport: 'stdio',
    command: '', args: [], env: {}, available: true, installed: false,
    enabled: true, source: 'manual',
  }
  fillConfig(item, 'install')
  config.name = ''
  config.command = ''
  configOpen.value = true
}

function normalizeImported(raw: any): Record<string, any> {
  const transport = String(raw.transport || raw.type || (raw.url ? 'http' : 'stdio')).toLowerCase()
  return {
    ...raw,
    transport: transport === 'sse' || transport === 'http' ? transport : 'stdio',
    args: Array.isArray(raw.args) ? raw.args.map(String) : [],
    env: raw.env && typeof raw.env === 'object' ? raw.env : {},
    headers: raw.headers && typeof raw.headers === 'object' ? raw.headers : {},
  }
}

async function importJson() {
  let parsed: any
  try { parsed = JSON.parse(importText.value) } catch { notice.value = 'JSON 格式不正确'; return }
  const sourceServers = parsed?.mcpServers || parsed?.servers || parsed
  if (!sourceServers || typeof sourceServers !== 'object' || Array.isArray(sourceServers)) {
    notice.value = '没有找到 mcpServers / servers 对象'
    return
  }
  importBusy.value = true
  try {
    const current = await apiGet<{ servers?: Record<string, any> }>('/api/settings/mcp')
    const merged = { ...(current.servers || {}) }
    let count = 0
    for (const [name, raw] of Object.entries(sourceServers)) {
      if (!raw || typeof raw !== 'object') continue
      merged[name] = normalizeImported(raw)
      count += 1
    }
    if (!count) throw new Error('没有可导入的 MCP 条目')
    await parseRes(await authedFetch('/api/settings/mcp', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ servers: merged }),
    }))
    await parseRes(await authedFetch('/api/mcp/reload', { method: 'POST' }))
    importOpen.value = false
    importText.value = ''
    notice.value = `已导入 ${count} 个 MCP，并完成热重载。`
    await refreshAll()
  } catch (reason) {
    notice.value = '导入失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    importBusy.value = false
  }
}

async function installSkillFromUrl() {
  const url = skillUrl.value.trim()
  if (!url) { notice.value = '请填写 Skill 的 URL 或 GitHub 仓库'; return }
  skillUrlBusy.value = true
  try {
    await parseRes(await authedFetch('/api/catalog/skills/install-remote', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    }))
    await reindexSkills()
    await refreshAll()
    skillUrlOpen.value = false
    skillUrl.value = ''
    notice.value = 'Skill 已安装。'
  } catch (reason) {
    notice.value = '安装失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    skillUrlBusy.value = false
  }
}

// 本地 ZIP：Android 走原生 SAF，桌面浏览器走 input[type=file]
const localInput = ref<HTMLInputElement | null>(null)
const localBusy = ref(false)
function openLocalPicker() {
  if ((window as any).CoomiAndroid?.importFiles) {
    const onImported = (event: Event) => {
      window.removeEventListener('coomi:files-imported', onImported)
      const paths = (event as CustomEvent<{ paths?: string[] }>).detail?.paths || []
      if (paths.length === 1) void installLocalPath(paths[0])
      else notice.value = paths.length ? '一次只能安装一个 Skill 压缩包' : '未选择文件'
    }
    window.addEventListener('coomi:files-imported', onImported)
    ;(window as any).CoomiAndroid.importFiles()
    return
  }
  localInput.value?.click()
}
async function installLocalPath(path: string) {
  if (!/\.zip$/i.test(path) && !/\.skill\.json$/i.test(path)) {
    notice.value = '请选择 .zip（Skill 包）文件'
    return
  }
  localBusy.value = true
  try {
    const res = await authedFetch('/api/fs/raw?path=' + encodeURIComponent(path))
    if (!res.ok) throw new Error(`读取文件失败（HTTP ${res.status}）`)
    const bytes = new Uint8Array(await res.arrayBuffer())
    await installZipBytes(bytes, path)
  } catch (reason) {
    notice.value = '安装失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    localBusy.value = false
  }
}
async function onLocalFile(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  localBusy.value = true
  try {
    await installZipBytes(new Uint8Array(await file.arrayBuffer()), file.name)
  } catch (reason) {
    notice.value = '安装失败：' + (reason instanceof Error ? reason.message : String(reason))
  } finally {
    localBusy.value = false
  }
}
async function installZipBytes(bytes: Uint8Array, fileName: string) {
  const base = fileName.replace(/\.skill\.json$/i, '').replace(/\.zip$/i, '').trim()
  const id = sanitizeId(base || 'local-skill')
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as number[])
  }
  await parseRes(await authedFetch('/api/catalog/skills/install-local', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, name: base || id, zip_base64: btoa(binary) }),
  }))
  await reindexSkills()
  await refreshAll()
  notice.value = `已安装 Skill「${base || id}」。`
}

// ── 缺依赖补全 ──
const envMissing = ref<string[]>([])
const canRepairEnv = ref(false)
const repairOpen = ref(false)
const repairAutoStart = ref(false)
const envOpen = ref(false)

function onEnvRepair() {
  envOpen.value = false
  envMissing.value = []
  canRepairEnv.value = true
  repairAutoStart.value = true
  repairOpen.value = true
}

function looksLikeMissingRuntime(message: string): boolean {
  return /本机缺少运行环境|缺少运行环境|找不到命令|command not found|\bnot found\b|No such file|ENOENT|Cannot find module|spawn .*ENOENT|npx|uvx|npm|node|git/i.test(message)
}

function missingRuntimeLabels(message: string): string[] {
  const matched = /本机缺少运行环境：(.+?)；/.exec(message)
  if (matched) return matched[1].split('、').map(value => value.trim()).filter(Boolean)
  return ['Node.js（npm/npx）', 'uv（uvx）', 'Git']
}

async function handleMissingEnv(missing: string[]) {
  envMissing.value = missing
  canRepairEnv.value = false
  try {
    const runtime = await apiGet<{ runtime?: { backend?: string } }>('/api/runtime/v2')
    if (runtime.runtime?.backend === 'proot_linux') {
      canRepairEnv.value = true
      repairOpen.value = true
      repairAutoStart.value = true
      notice.value = `检测到缺少 ${missing.join('、')}，正在自动安装（Node.js / Python / git / uv，日志见补全面板）。`
      return
    }
  } catch { /* 读不到就只给文字 */ }
  notice.value = `安装需要 ${missing.join('、')}，请先在系统里安装对应运行时。`
}

/** 安装/连接失败且原因像“缺运行时”时，自动开补全并记住这次操作用于补全后重试。 */
async function autoRepairFor(message: string, retry: () => void): Promise<boolean> {
  if (!looksLikeMissingRuntime(message)) return false
  progressRetry.value = retry
  await handleMissingEnv(missingRuntimeLabels(message))
  return canRepairEnv.value
}
function onRepairReady() {
  repairOpen.value = false
  envMissing.value = []
  canRepairEnv.value = false
  progressRetry.value?.()
}
function onRepairFailure(message: string) {
  notice.value = '依赖补全失败：' + message
}

// ── 源管理 ──
const sourcesOpen = ref(false)
const sourceBusy = ref(false)
const sourceError = ref('')
const newSource = reactive({ name: '', url: '', kind: 'coomi' })
const sourceKindOptions = [
  { value: 'coomi', label: 'Coomi registry.json' },
  { value: 'mcp-registry', label: '官方 MCP Registry' },
]

function openSources() {
  sourcesOpen.value = true
  sourceError.value = ''
}

async function chooseMarketSource(id: string) {
  if (sourceBusy.value) return
  sourceBusy.value = true
  sourceError.value = ''
  try {
    activeMarketSource.value = id
    source.value = 'market'
    await loadMarket()
    if (marketStatus.value?.error && marketCount.value === 0) {
      sourceError.value = marketStatus.value.error
      return
    }
    sourcesOpen.value = false
  } catch (reason) {
    sourceError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    sourceBusy.value = false
  }
}

async function addSource() {
  const name = newSource.name.trim()
  const url = newSource.url.trim()
  if (!name || !url) {
    sourceError.value = '请填写源名称和 URL'
    return
  }
  sourceBusy.value = true
  sourceError.value = ''
  try {
    const data = await parseRes(await authedFetch('/api/registry/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, url, kind: newSource.kind, activate: true }),
    }))
    newSource.name = ''
    newSource.url = ''
    await loadSources()
    activeMarketSource.value = data.source?.id || activeMarketSource.value
    source.value = 'market'
    await loadMarket()
    sourcesOpen.value = false
    notice.value = `已添加源「${data.source?.name || name}」。`
  } catch (reason) {
    sourceError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    sourceBusy.value = false
  }
}

async function deleteSource(sourceItem: { id: string; name: string; builtin: boolean }) {
  if (sourceItem.builtin) return
  sourceBusy.value = true
  sourceError.value = ''
  try {
    await parseRes(await authedFetch(`/api/registry/sources/${encodeURIComponent(sourceItem.id)}`, { method: 'DELETE' }))
    await loadSources()
    if (activeMarketSource.value === sourceItem.id) {
      activeMarketSource.value = 'official'
      if (source.value === 'market') await loadMarket()
    }
    notice.value = `已删除源「${sourceItem.name}」。`
  } catch (reason) {
    sourceError.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    sourceBusy.value = false
  }
}

function sourceLabel(item: Item): string {
  if (item.source === 'manual') return '自定义'
  if (item.source === 'catalog') return '内置'
  return item.sourceName || '社区'
}

function needsConfig(item: Item): boolean {
  return Boolean(item.requiredParameters?.length)
}

function statusText(item: Item): string {
  if (!item.installed) return item.available ? '' : '本机不可用'
  if (!item.enabled) return '已停用'
  if (item.status === 'running') return '已连接'
  if (item.status === 'error') return '连接失败'
  if (item.status === 'idle') return '已配置'
  return '已安装'
}
function statusTone(item: Item): string {
  if (!item.installed) return item.available ? 'plain' : 'off'
  if (!item.enabled) return 'off'
  if (item.status === 'running') return 'ok'
  if (item.status === 'error') return 'error'
  if (item.status === 'idle') return 'warn'
  return 'plain'
}
function requiresText(item: Item): string {
  return (item.requires || []).join(' · ')
}
function canInstall(item: Item): boolean {
  return item.available !== false
}

function goDashboard() {
  goBack(router, '/settings')
}

onMounted(async () => {
  await loadSources()
  await refreshAll()
  if (source.value !== 'catalog') await loadMarket()
})
onBeforeUnmount(() => {
  stopPolling()
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<template>
  <SettingsPage title="拓展" subtitle="技能与 MCP" :back="goDashboard">
    <template #actions>
      <button class="icon-action" title="环境检测" aria-label="环境检测" @click="envOpen = true">
        <CoomiIcon name="cpu" :size="17" />
      </button>
      <button class="icon-action" title="刷新" aria-label="刷新" @click="refreshAll">
        <CoomiIcon name="refresh" :size="17" />
      </button>
    </template>

    <div>
      <div class="seg" role="tablist">
        <button :class="['segitem', { on: tab === 'discover' }]" @click="switchTab('discover')">发现</button>
        <button :class="['segitem', { on: tab === 'installed' }]" @click="switchTab('installed')">
          已安装<span class="count">{{ installedCount }}</span>
        </button>
      </div>

      <label class="search">
        <CoomiIcon name="search" :size="16" />
        <input v-model="query" placeholder="搜索 MCP / Skill" aria-label="搜索拓展" autocomplete="off" />
        <button v-if="query" type="button" aria-label="清空搜索" @click="query = ''">
          <CoomiIcon name="close" :size="14" />
        </button>
      </label>

      <div class="filters">
        <div class="filter-scroll" role="tablist" aria-label="类型筛选">
          <button :class="['chip', { on: kind === 'all' }]" @click="kind = 'all'">全部</button>
          <button :class="['chip', { on: kind === 'mcp' }]" @click="kind = 'mcp'">MCP</button>
          <button :class="['chip', { on: kind === 'skill' }]" @click="kind = 'skill'">Skills</button>
        </div>
        <button
          v-if="tab === 'discover'"
          :class="['src-manage', { on: source !== 'all' }]"
          :aria-label="`来源：${sourceLabelOfCurrent()}，点击切换`"
          @click="openSources"
        >
          <CoomiIcon name="globe" :size="15" />
          <span>{{ sourceLabelOfCurrent() }}</span>
        </button>
      </div>

      <div v-if="tab === 'discover' && source !== 'catalog' && marketStatus?.error && marketCount === 0" class="notice err market-err">
        <span>{{ marketStatus.error }}</span>
        <span class="market-err-actions">
          <button @click="loadMarket">重试</button>
          <button @click="openSources">换源</button>
        </span>
      </div>

      <div class="toolbar">
        <template v-if="tab === 'discover'">
          <button class="tool" @click="openCustomMcp"><CoomiIcon name="plus" :size="14" />添加 MCP</button>
          <button class="tool" @click="importOpen = true"><CoomiIcon name="folder" :size="14" />导入 JSON</button>
          <button class="tool" @click="skillUrlOpen = true"><CoomiIcon name="link" :size="14" />Skill 链接</button>
          <button class="tool" :disabled="localBusy" @click="openLocalPicker">
            <CoomiIcon name="wrench" :size="14" />{{ localBusy ? '安装中…' : '本地 Skill' }}
          </button>
        </template>
        <template v-else>
          <button class="tool" @click="reconnectMcp"><CoomiIcon name="refresh" :size="14" />重连 MCP</button>
          <button class="tool" @click="refreshAll"><CoomiIcon name="refresh" :size="14" />刷新状态</button>
        </template>
      </div>
      <input ref="localInput" type="file" accept=".zip" class="visually-hidden" @change="onLocalFile" />

      <p v-if="notice" class="notice">{{ notice }}</p>
      <div v-if="envMissing.length" class="notice env-missing">
        <span>安装需要 {{ envMissing.join('、') }}，当前环境缺少。</span>
        <button v-if="canRepairEnv" @click="repairOpen = true">查看补全</button>
      </div>
      <!-- 引擎掉线时会返回整页 HTML：只报一句人话，不把 HTML 倒进界面 -->
      <p v-if="error" class="notice err">加载失败：{{ friendlyError(error) }}</p>

      <div v-if="loading || marketLoading" class="skeleton-list" aria-label="加载中">
        <div v-for="n in 4" :key="n" class="skeleton" />
      </div>
      <div v-else-if="visibleItems.length === 0" class="empty">
        <p>{{ emptyText }}</p>
        <button v-if="source !== 'catalog' && !query" class="empty-act" @click="loadMarket">重新加载</button>
      </div>

      <div v-else class="cards">
        <article v-for="item in visibleItems" :key="item.kind + ':' + item.id" class="card enter-item">
          <button class="card-main" @click="openDetail(item)">
            <span class="tile" :class="item.kind">
              <CoomiIcon :name="item.kind === 'mcp' ? 'plug' : 'wrench'" :size="18" />
            </span>
            <span class="info">
              <span class="name-row">
                <span class="name">{{ item.name }}</span>
                <span v-if="item.verified" class="badge verify"><CoomiIcon name="shield" :size="10" />已验证</span>
                <span v-if="needsConfig(item) && !item.installed" class="badge warn">需配置</span>
                <span v-if="statusText(item)" class="badge" :class="statusTone(item)">{{ statusText(item) }}</span>
              </span>
              <span class="desc">{{ item.description || (item.kind === 'mcp' ? '本机配置的 MCP Server' : '本机安装的 Skill') }}</span>
              <span class="meta">
                <span class="badge src" :class="'src-' + (item.source || 'catalog')">{{ sourceLabel(item) }}</span>
                <span>{{ item.kind === 'mcp' ? (item.transport || 'stdio') : 'Skill' }}</span>
                <span v-if="item.kind === 'mcp' && item.toolsCount">{{ item.toolsCount }} 个工具</span>
                <span v-if="requiresText(item)">需要 {{ requiresText(item) }}</span>
                <span v-if="item.publisher">{{ item.publisher }}</span>
                <span v-if="item.version">v{{ item.version }}</span>
                <span v-if="item.unavailableReason" class="off-reason">{{ item.unavailableReason }}</span>
              </span>
              <span v-if="item.error" class="item-error">{{ item.error }}</span>
            </span>
          </button>
          <div class="card-actions">
            <template v-if="item.installed">
              <template v-if="item.kind === 'mcp'">
                <button v-if="item.status === 'error'" class="act primary" :disabled="mcpBusyId === item.id" @click="retryItem(item)">
                  {{ mcpBusyId === item.id ? '处理中…' : '重试连接' }}
                </button>
                <button v-else class="act primary" @click="openEditConfig(item)">管理</button>
              </template>
              <button v-else class="act" :class="item.enabled ? 'ghost' : 'primary'" @click="toggleEnabled(item, !item.enabled)">
                {{ item.enabled ? '停用' : '启用' }}
              </button>
            </template>
            <template v-else>
              <button v-if="!canInstall(item)" class="act ghost" disabled :title="item.unavailableReason || '本机不可用'">本机不可用</button>
              <button v-else class="act primary install-act" :disabled="isInstalling(item)" @click="installItem(item)">
                <span v-if="isInstalling(item)" class="spinner" aria-hidden="true" />
                {{ isInstalling(item) ? '安装中' : (item.kind === 'mcp' && item.requiredParameters?.length ? '配置安装' : '安装') }}
              </button>
            </template>
          </div>
        </article>
      </div>
    </div>

    <!-- 详情 -->
    <div v-if="detailItem" class="mask" @click.self="closeDetail">
      <section class="sheet">
        <div class="grip" />
        <header class="sheet-head">
          <span class="tile" :class="detailItem.kind">
            <CoomiIcon :name="detailItem.kind === 'mcp' ? 'plug' : 'wrench'" :size="20" />
          </span>
          <div class="sheet-title">
            <h2>{{ detailItem.name }}</h2>
            <p>{{ detailItem.kind === 'mcp' ? 'MCP Server' : 'Skill' }}<span v-if="detailItem.author"> · {{ detailItem.author }}</span></p>
          </div>
        </header>
        <p class="sheet-desc">{{ detailItem.description || '暂无描述。' }}</p>
        <div class="facts">
          <span><b>来源</b>{{ sourceLabel(detailItem) }}</span>
          <span v-if="detailItem.transport"><b>传输</b>{{ detailItem.transport }}</span>
          <span v-if="detailItem.publisher"><b>发布者</b>{{ detailItem.publisher }}</span>
          <span v-if="detailItem.version"><b>版本</b>{{ detailItem.version }}</span>
          <span v-if="detailItem.repository"><b>仓库</b>{{ detailItem.repository }}</span>
          <span v-if="detailItem.requires?.length"><b>依赖</b>{{ requiresText(detailItem) }}</span>
          <span v-if="detailItem.requiredParameters?.length"><b>必填</b>{{ detailItem.requiredParameters.map(parameter => parameter.label).join('、') }}</span>
          <span v-if="detailItem.kind === 'mcp' && detailItem.toolsCount"><b>工具</b>{{ detailItem.toolsCount }} 个</span>
          <span v-if="detailItem.path" class="path"><b>路径</b>{{ detailItem.path }}</span>
          <span v-if="detailItem.available === false"><b>状态</b>{{ detailItem.unavailableReason || '本机不可用' }}</span>
        </div>
        <p v-if="detailItem.error" class="detail-error">{{ detailItem.error }}{{ mcpErrorHint(detailItem.error) }}</p>
        <div class="sheet-actions">
          <button class="btn ghost" @click="closeDetail">关闭</button>
          <template v-if="detailItem.installed">
            <template v-if="detailItem.kind === 'mcp'">
              <button class="btn ghost" :disabled="mcpBusyId === detailItem.id" @click="testConnection(detailItem)">
                {{ mcpBusyId === detailItem.id ? '测试中…' : '测试连接' }}
              </button>
              <button v-if="detailItem.status === 'error'" class="btn ghost" :disabled="mcpBusyId === detailItem.id" @click="prepareMcp(detailItem)">准备依赖</button>
              <button class="btn primary" @click="closeDetail(); openEditConfig(detailItem)">配置</button>
            </template>
            <button v-else class="btn primary" @click="closeDetail(); toggleEnabled(detailItem, !detailItem.enabled)">
              {{ detailItem.enabled ? '停用' : '启用' }}
            </button>
            <button v-if="detailItem.kind === 'skill' && detailItem.source !== 'manual'" class="btn ghost" @click="closeDetail(); rollbackSkill(detailItem)">回滚</button>
            <button class="btn danger" @click="deleteTarget = detailItem; closeDetail()">删除</button>
          </template>
          <template v-else>
            <button class="btn primary" :disabled="!canInstall(detailItem)" @click="closeDetail(); installItem(detailItem)">
              {{ detailItem.requiredParameters?.length ? '配置并安装' : '安装' }}
            </button>
            <button v-if="detailItem.kind === 'mcp'" class="btn ghost" @click="closeDetail(); openInstallConfig(detailItem)">高级配置</button>
          </template>
        </div>
      </section>
    </div>

    <!-- 安装 / 编辑配置 -->
    <div v-if="configOpen" class="mask" @click.self="configOpen = false">
      <section class="sheet tall">
        <div class="grip" />
        <h2 class="stitle">{{ configMode === 'edit' ? '配置' : '安装' }} {{ configItem?.name || 'MCP Server' }}</h2>
        <p class="sdesc">配置会写入 mcp_servers.json 并立即尝试连接，不需要重启引擎。</p>

        <div v-if="configItem?.requiredParameters?.length" class="params">
          <label v-for="parameter in configItem.requiredParameters" :key="parameter.key" class="field">
            <span>{{ parameter.label }}<em class="req">必填</em></span>
            <input
              v-model="installValues[parameter.key]"
              :type="parameter.secret ? 'password' : 'text'"
              :placeholder="parameter.key"
              autocomplete="off"
            />
          </label>
        </div>

        <label class="field"><span>名称</span><input v-model="config.name" placeholder="server-name" autocomplete="off" /></label>
        <label class="field">
          <span>传输方式</span>
          <UiSelect v-model="config.transport" :options="transportOptions" block />
        </label>
        <template v-if="config.transport === 'stdio'">
          <label class="field"><span>command</span><input v-model="config.command" placeholder="npx / uvx / 路径" autocomplete="off" /></label>
          <label class="field">
            <span>args（每行一个）</span>
            <textarea v-model="config.argsText" rows="3" placeholder="-y&#10;@scope/package" />
          </label>
        </template>
        <template v-else>
          <label class="field"><span>url</span><input v-model="config.url" placeholder="https://example.com/mcp" autocomplete="off" /></label>
          <label class="field">
            <span>headers（每行 KEY=VALUE）</span>
            <textarea v-model="config.headersText" rows="2" placeholder="Authorization=Bearer ..." />
          </label>
        </template>
        <details class="advanced">
          <summary>高级：环境变量 / 工作目录</summary>
          <label class="field">
            <span>env（每行 KEY=VALUE）</span>
            <textarea v-model="config.envText" rows="3" placeholder="API_KEY=..." />
          </label>
          <label class="field"><span>cwd（可选）</span><input v-model="config.cwd" placeholder="留空使用默认目录" autocomplete="off" /></label>
        </details>
        <label class="check"><input v-model="config.enabled" type="checkbox" /><span>保存后立即启用</span></label>

        <div v-if="configMode === 'edit' && configItem" class="edit-extra">
          <button class="btn ghost" @click="toggleEnabled(configItem, !configItem.enabled); configOpen = false">
            {{ configItem.enabled ? '停用此 MCP' : '启用此 MCP' }}
          </button>
        </div>

        <div class="sheet-actions">
          <button class="btn ghost" @click="configOpen = false">取消</button>
          <button class="btn primary" :disabled="configBusy" @click="saveConfigSheet">
            {{ configBusy ? '保存中…' : configMode === 'edit' ? '保存并重连' : '安装' }}
          </button>
        </div>
      </section>
    </div>

    <!-- 安装进度 -->
    <div v-if="progressOpen" class="mask" @click.self="closeProgress">
      <section class="sheet tall">
        <div class="grip" />
        <h2 class="stitle">{{ progressDone ? '安装结果' : '正在安装' }}：{{ progressTitle }}</h2>
        <div class="progress-meta">
          <span class="phase">{{ progressPhase }}</span>
          <span>{{ progressElapsed }}s</span>
        </div>
        <pre v-if="progressLog" class="log">{{ progressLog }}</pre>
        <p v-else class="sdesc">正在下载、解压并写入配置，日志会实时出现在这里。</p>
        <p v-if="progressError" class="detail-error">{{ progressError }}</p>
        <div class="sheet-actions">
          <button class="btn ghost" @click="closeProgress">{{ progressDone ? '关闭' : '后台继续' }}</button>
          <button v-if="progressError || progressDone && progressPhase === '失败'" class="btn primary" @click="retryInstall">重试</button>
        </div>
      </section>
    </div>

    <!-- 导入 JSON -->
    <div v-if="importOpen" class="mask" @click.self="importOpen = false">
      <section class="sheet tall">
        <div class="grip" />
        <h2 class="stitle">导入 MCP JSON</h2>
        <p class="sdesc">支持 Claude Desktop / Cursor 的 <code>mcpServers</code> 或 <code>servers</code> 格式。导入后会立即热重载。</p>
        <textarea v-model="importText" class="json-input" rows="10" placeholder='{"mcpServers":{"my-server":{"command":"npx","args":["-y","pkg"]}}}' />
        <div class="sheet-actions">
          <button class="btn ghost" @click="importOpen = false">取消</button>
          <button class="btn primary" :disabled="importBusy" @click="importJson">{{ importBusy ? '导入中…' : '导入' }}</button>
        </div>
      </section>
    </div>

    <!-- Skill URL -->
    <div v-if="skillUrlOpen" class="mask" @click.self="skillUrlOpen = false">
      <section class="sheet">
        <div class="grip" />
        <h2 class="stitle">从链接安装 Skill</h2>
        <p class="sdesc">支持 GitHub 仓库、SKILL.md 清单或 Skill 压缩包链接。</p>
        <label class="field"><span>URL / owner/repo</span><input v-model="skillUrl" placeholder="https://github.com/owner/skill-repo" autocomplete="off" /></label>
        <div class="sheet-actions">
          <button class="btn ghost" @click="skillUrlOpen = false">取消</button>
          <button class="btn primary" :disabled="skillUrlBusy" @click="installSkillFromUrl">{{ skillUrlBusy ? '安装中…' : '安装' }}</button>
        </div>
      </section>
    </div>

    <!-- 删除确认 -->
    <div v-if="deleteTarget" class="mask" @click.self="deleteTarget = null">
      <section class="sheet">
        <div class="grip" />
        <h2 class="stitle">删除「{{ deleteTarget.name }}」？</h2>
        <p class="sdesc">会移除配置或 Skill 目录，不可恢复。如果只是暂时不用，请返回并选择“停用”。</p>
        <div class="sheet-actions">
          <button class="btn ghost" @click="deleteTarget = null">取消</button>
          <button class="btn danger" :disabled="deleteBusy" @click="confirmDelete">{{ deleteBusy ? '删除中…' : '确认删除' }}</button>
        </div>
      </section>
    </div>

    <!-- 源管理 -->
    <div v-if="sourcesOpen" class="mask" @click.self="sourcesOpen = false">
      <section class="sheet tall">
        <div class="grip" />
        <header class="sheet-head">
          <span class="tile mcp"><CoomiIcon name="globe" :size="20" /></span>
          <div class="sheet-title">
            <h2>源管理</h2>
            <p>内置目录始终可用；社区源可切换、添加、删除。</p>
          </div>
        </header>

        <div class="src-scope" role="tablist" aria-label="显示范围">
          <button :class="['scope', { on: source === 'all' }]" @click="pickScope('all')">
            全部来源<span class="src-count">{{ catalogCount + marketCount }}</span>
          </button>
          <button :class="['scope', { on: source === 'catalog' }]" @click="pickScope('catalog')">
            仅内置<span class="src-count">{{ catalogCount }}</span>
          </button>
          <button :class="['scope', { on: source === 'market' }]" @click="pickScope('market')">
            仅社区<span class="src-count">{{ marketCount }}</span>
          </button>
        </div>

        <div class="src-list">
          <button
            v-for="entry in marketSources"
            :key="entry.id"
            :class="['src-item', { on: entry.id === activeMarketSource }]"
            @click="chooseMarketSource(entry.id)"
          >
            <span class="src-dot" />
            <span class="src-info">
              <b>{{ entry.name }}</b>
              <small>{{ entry.kind === 'mcp-registry' ? '官方 MCP Registry · 可搜索 2 万+ 条目' : 'Coomi registry.json' }}</small>
              <small class="src-url">{{ entry.url }}</small>
            </span>
            <span v-if="entry.builtin" class="badge">内置</span>
            <span v-if="entry.id === activeMarketSource" class="badge ok">当前</span>
            <span
              v-if="!entry.builtin"
              class="src-del"
              role="button"
              :aria-label="'删除源 ' + entry.name"
              @click.stop="deleteSource(entry)"
            ><CoomiIcon name="trash" :size="14" /></span>
          </button>
        </div>

        <div class="src-add">
          <h3>添加自定义源</h3>
          <p class="sdesc">支持 Coomi registry.json，或官方 MCP Registry 的 <code>/v0/servers</code> 地址。</p>
          <label class="field"><span>名称</span><input v-model="newSource.name" placeholder="我的 registry" autocomplete="off" /></label>
          <label class="field"><span>URL</span><input v-model="newSource.url" placeholder="https://example.com/registry.json" autocomplete="off" /></label>
          <label class="field"><span>类型</span><UiSelect v-model="newSource.kind" :options="sourceKindOptions" block /></label>
          <p v-if="sourceError" class="detail-error">{{ sourceError }}</p>
          <div class="sheet-actions">
            <button class="btn ghost" @click="sourcesOpen = false">关闭</button>
            <button class="btn ghost" :disabled="sourceBusy" @click="loadMarket">刷新当前源</button>
            <button class="btn primary" :disabled="sourceBusy" @click="addSource">
              {{ sourceBusy ? '处理中…' : '添加并使用' }}
            </button>
          </div>
        </div>
      </section>
    </div>

    <RuntimeEnvSheet
      :open="envOpen"
      @close="envOpen = false"
      @repair="onEnvRepair"
    />

    <EnvRepairSheet
      v-if="repairOpen"
      :auto-start="repairAutoStart"
      @close="repairOpen = false"
      @ready="onRepairReady"
      @failure="onRepairFailure"
    />
  </SettingsPage>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }

.icon-action {
  display: grid; place-items: center;
  width: var(--sp-8); height: var(--sp-8);
  border-radius: var(--r-pill); background: var(--fill); color: var(--text-2);
}
.seg {
  display: grid; grid-auto-flow: column; grid-auto-columns: minmax(0, 1fr);
  gap: var(--sp-1); margin-bottom: var(--sp-3); padding: var(--sp-1);
  border-radius: var(--r-md); background: var(--fill);
}
.segitem {
  display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1);
  min-height: 38px; padding: 0 var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: none; color: var(--text-2); font-size: var(--fs-sub); font-weight: 500;
}
.segitem.on {
  background: var(--bg); color: var(--blue); font-weight: 600;
  box-shadow: 0 1px 3px rgba(23, 32, 54, .08);
}
.count {
  min-width: var(--sp-5); padding: 0 var(--sp-1); border-radius: var(--r-pill);
  background: var(--fill-strong); color: var(--text-3); font-size: var(--fs-caption);
}
.search {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: 44px; padding: 0 var(--sp-3) 0 var(--sp-4);
  border-radius: var(--r-pill); color: var(--text-3);
  background: color-mix(in srgb, var(--text) 5%, transparent);
}
.search input {
  flex: 1; min-width: 0; border: 0; outline: 0;
  background: none; color: var(--text); font-size: var(--fs-body);
}
.search button {
  display: grid; place-items: center; width: var(--sp-6); height: var(--sp-6);
  border-radius: 50%; background: var(--fill-strong); color: var(--text-2);
}
/* 一行横向滚动的筛选：类型与来源放同一层，不再叠第二排 tab。 */
.filters { display: flex; align-items: center; gap: var(--sp-2); margin: var(--sp-3) 0; }
.filter-scroll {
  flex: 1; min-width: 0; display: flex; align-items: center; gap: var(--sp-2);
  overflow-x: auto; scrollbar-width: none;
}
.filter-scroll::-webkit-scrollbar { display: none; }
.filter-sep { flex: none; width: 1px; height: 18px; background: var(--border); }
.chip {
  flex: none; display: inline-flex; align-items: center; gap: var(--sp-1);
  min-height: var(--sp-8); padding: 0 var(--sp-3); border-radius: var(--r-pill);
  border: 1px solid var(--border); background: var(--bg); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600;
}
.chip.on { border-color: transparent; background: var(--blue); color: #fff; }
.chip.on .src-count { opacity: .8; }
.src-count { font-size: var(--fs-caption); font-variant-numeric: tabular-nums; opacity: .7; }
.src-manage {
  display: inline-flex; align-items: center; gap: var(--sp-1); flex: none; max-width: 45%;
  min-height: var(--sp-8); padding: 0 var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2); font-size: var(--fs-sub); font-weight: 600;
}
.src-manage.on { border-color: var(--blue-border); color: var(--blue); background: var(--blue-soft); }
.src-manage span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
/* 弹层顶部：来源范围（全部 / 仅内置 / 仅社区） */
.src-scope { display: flex; gap: var(--sp-2); margin-bottom: var(--sp-3); }
.scope {
  flex: 1; display: inline-flex; align-items: center; justify-content: center; gap: var(--sp-1);
  min-height: var(--sp-8); border-radius: var(--r-pill);
  background: var(--fill); color: var(--text-3); font-size: var(--fs-sub); font-weight: 600;
}
.scope.on { background: var(--blue-soft); color: var(--blue); }
.market-err { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); flex-wrap: wrap; }
.market-err-actions { display: inline-flex; gap: var(--sp-2); }
.market-err-actions button {
  min-height: var(--sp-7); padding: 0 var(--sp-3); border-radius: var(--r-pill);
  background: var(--bg); color: var(--danger); font-size: var(--fs-caption); font-weight: 600;
}
.empty { display: flex; flex-direction: column; align-items: center; gap: var(--sp-3); margin: var(--sp-6) 0; color: var(--text-3); font-size: var(--fs-sub); text-align: center; }
.empty p { margin: 0; max-width: 34em; line-height: var(--lh-sub); }
.empty-act {
  min-height: var(--sp-8); padding: 0 var(--sp-4); border-radius: var(--r-pill);
  background: var(--fill-strong); color: var(--text); font-size: var(--fs-sub); font-weight: 600;
}
.toolbar {
  display: flex; gap: var(--sp-2); margin-bottom: var(--sp-3);
  overflow-x: auto; scrollbar-width: none;
}
.toolbar::-webkit-scrollbar { display: none; }
/* 卡与行：与设置页同一套（20 圆角、2px 间隙、无分割线） */
.card, .group {
  border-radius: var(--r-sheet); background: var(--bg);
  border: 1px solid color-mix(in srgb, var(--border) 60%, transparent);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .04), 0 6px 18px rgba(23, 32, 54, .05);
  overflow: hidden;
}
.tool {
  display: inline-flex; align-items: center; gap: var(--sp-1); flex: none;
  min-height: var(--sp-8); padding: 0 var(--sp-3); border-radius: var(--r-pill);
  border: 1px dashed var(--border); background: var(--bg); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600;
}
.tool:disabled { opacity: .55; }
.notice {
  margin: 0 0 var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font-size: var(--fs-sub); line-height: var(--lh-sub);
  word-break: break-word;
}
.notice.err { background: var(--danger-soft); color: var(--danger); }
.notice.env-missing { display: flex; align-items: center; gap: var(--sp-2); flex-wrap: wrap; background: var(--orange-soft); color: var(--orange); }
.notice.env-missing button {
  min-height: var(--sp-7); padding: 0 var(--sp-3); border-radius: var(--r-pill);
  border: 1px solid color-mix(in srgb, var(--orange) 45%, var(--border));
  background: var(--bg); color: var(--orange); font-size: var(--fs-caption); font-weight: 600;
}
.skeleton-list { display: flex; flex-direction: column; gap: var(--sp-2); }
.skeleton { height: var(--sp-9); border-radius: var(--r-card); background: var(--fill); animation: pulse var(--dur-loop) var(--ease-in-out) infinite; }
.empty { margin: var(--sp-6) 0; text-align: center; color: var(--text-3); font-size: var(--fs-sub); }
.cards { display: grid; grid-template-columns: 1fr; gap: var(--sp-2); }
@media (min-width: 760px) { .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
.card {
  display: flex; align-items: stretch; gap: var(--sp-2);
  padding: var(--sp-4); border: 1px solid var(--border); border-radius: var(--r-card); background: var(--bg);
  box-shadow: var(--shadow-1); min-width: 0;
}
.card-main {
  flex: 1; min-width: 0; display: flex; align-items: flex-start; gap: var(--sp-2);
  padding: 0; border: 0; background: none; text-align: left;
}
.tile {
  flex-shrink: 0; width: var(--sp-9); height: var(--sp-9); border-radius: var(--r-md);
  display: grid; place-items: center; background: var(--fill-strong); color: var(--text-2);
}
.tile.mcp { background: var(--blue-soft); color: var(--blue); }
.tile.skill { background: var(--ok-soft); color: var(--ok); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.name-row { display: flex; align-items: center; gap: var(--sp-1); min-width: 0; flex-wrap: wrap; }
.name { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: var(--fs-body); font-weight: 600; }
.desc {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: var(--text-2); font-size: var(--fs-label); line-height: var(--lh-label);
}
.meta { display: flex; flex-wrap: wrap; gap: var(--sp-1) var(--sp-2); color: var(--text-3); font-size: var(--fs-caption); }
.item-error {
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden;
  color: var(--danger); font-size: var(--fs-caption); line-height: var(--lh-caption);
}
.badge {
  flex-shrink: 0; padding: 1px var(--sp-2); border-radius: var(--r-pill);
  font-size: var(--fs-caption); font-weight: 600; background: var(--fill); color: var(--text-3);
}
.badge.ok { background: var(--ok-soft); color: var(--ok); }
.badge.error { background: var(--danger-soft); color: var(--danger); }
.badge.warn { background: var(--orange-soft); color: var(--orange); }
.badge.off { background: var(--fill); color: var(--text-3); }
.badge.plain { background: var(--fill); color: var(--text-3); }
.badge.verify { display: inline-flex; align-items: center; gap: 2px; background: var(--blue-soft); color: var(--blue); }
.badge.src { background: var(--fill); color: var(--text-3); font-weight: 500; }
.badge.src-market { background: var(--blue-soft); color: var(--blue); }
.badge.src-manual { background: var(--orange-soft); color: var(--orange); }
.off-reason {
  display: -webkit-box; -webkit-line-clamp: 1; -webkit-box-orient: vertical; overflow: hidden;
  color: var(--orange);
}
.card-actions { display: flex; flex-direction: column; justify-content: center; gap: var(--sp-1); flex-shrink: 0; }
.act {
  min-height: var(--sp-8); padding: 0 var(--sp-3); border-radius: var(--r-pill);
  font-size: var(--fs-sub); font-weight: 600; white-space: nowrap;
}
.act.primary { background: var(--blue); color: #fff; }
.act.ghost { background: var(--fill-strong); color: var(--text); }
.act.danger { background: var(--danger-soft); color: var(--danger); }
.act:disabled { opacity: .5; }
.install-act { display: inline-flex; align-items: center; justify-content: center; gap: 6px; }
.spinner {
  width: 13px; height: 13px; flex-shrink: 0;
  border: 2px solid color-mix(in srgb, currentColor 30%, transparent);
  border-top-color: currentColor; border-radius: 50%;
  animation: spin 700ms linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.visually-hidden { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

.mask {
  position: fixed; inset: 0; z-index: var(--z-sheet);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .45);
}
.sheet {
  width: 100%; max-width: 560px; max-height: 88vh; overflow-y: auto;
  padding: var(--sp-2) var(--sp-4) var(--sp-4);
  border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-2);
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.sheet.tall { max-height: 92vh; }
.grip { width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-3); border-radius: var(--r-pill); background: var(--fill-strong); }
.sheet-head { display: flex; align-items: center; gap: var(--sp-2); }
.sheet-title { min-width: 0; }
.sheet-title h2 { margin: 0; color: var(--text); font-size: var(--fs-strong); font-weight: 700; }
.sheet-title p { margin: 2px 0 0; color: var(--text-3); font-size: var(--fs-caption); }
.sheet-desc { margin: var(--sp-3) 0 0; color: var(--text-2); font-size: var(--fs-sub); line-height: var(--lh-sub); white-space: pre-wrap; }
.facts { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); padding: var(--sp-3); border-radius: var(--r-md); background: var(--fill); }
.facts span { display: flex; gap: var(--sp-2); color: var(--text-2); font-size: var(--fs-label); line-height: var(--lh-label); }
.facts b { flex-shrink: 0; color: var(--text-3); font-weight: 600; }
.facts .path { word-break: break-all; }
.detail-error { margin: var(--sp-3) 0 0; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--danger-soft); color: var(--danger); font-size: var(--fs-label); line-height: var(--lh-label); word-break: break-word; }
.stitle { margin: 0; color: var(--text); font-size: var(--fs-strong); font-weight: 700; }
.sdesc { margin: var(--sp-2) 0 0; color: var(--text-2); font-size: var(--fs-label); line-height: var(--lh-label); }
.params { margin-top: var(--sp-3); }
.field { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-3); color: var(--text-2); font-size: var(--fs-label); }
.field input, .field textarea, .json-input {
  width: 100%; padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--bg-input); color: var(--text);
  font-size: var(--fs-body); outline: none;
}
.field textarea { resize: vertical; min-height: var(--sp-8); }
.json-input { margin-top: var(--sp-3); font-family: var(--font-mono); font-size: var(--fs-label); }
.req { margin-left: var(--sp-1); padding: 0 var(--sp-1); border-radius: var(--r-pill); background: var(--blue-soft); color: var(--blue); font-style: normal; font-size: var(--fs-caption); font-weight: 600; }
.advanced { margin-top: var(--sp-3); padding: var(--sp-2) var(--sp-3); border-radius: var(--r-md); background: var(--fill); }
.advanced summary { color: var(--text-2); font-size: var(--fs-sub); font-weight: 600; cursor: pointer; }
.check { display: flex; align-items: center; gap: var(--sp-2); margin-top: var(--sp-3); color: var(--text-2); font-size: var(--fs-sub); }
.check input { width: auto; }
.edit-extra { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); }
.progress-meta { display: flex; justify-content: space-between; margin-top: var(--sp-3); color: var(--text-3); font-size: var(--fs-label); }
.phase { color: var(--blue); font-weight: 600; }
.log {
  max-height: 36vh; overflow: auto; margin: var(--sp-3) 0 0; padding: var(--sp-3);
  border-radius: var(--r-md); background: #0f141b; color: #c8d3e0;
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: var(--lh-label);
  white-space: pre-wrap; word-break: break-word;
}
.sheet-actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-4); flex-wrap: wrap; }
.btn { flex: 1; min-width: 120px; min-height: var(--sp-9); border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.btn.primary { background: var(--blue); color: #fff; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.btn.danger { background: var(--danger-soft); color: var(--danger); }
.btn:disabled { opacity: .55; }
.card { transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out); }
.card:hover { border-color: color-mix(in srgb, var(--blue) 26%, var(--border)); box-shadow: var(--shadow-2); }
.card-main { cursor: pointer; }
.card:has(.card-main:focus-visible) { border-color: var(--blue-border); box-shadow: 0 0 0 3px var(--blue-soft); }

.src-list { display: flex; flex-direction: column; gap: var(--sp-2); margin-top: var(--sp-4); }
.src-item {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  padding: var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); text-align: left;
  transition: border-color var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.src-item.on { border-color: var(--blue-border); background: var(--blue-soft); }
.src-dot {
  flex-shrink: 0; width: var(--sp-2); height: var(--sp-2); border-radius: 50%;
  background: var(--border-strong); box-shadow: 0 0 0 3px var(--fill);
}
.src-item.on .src-dot { background: var(--blue); box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 18%, transparent); }
.src-info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.src-info b { color: var(--text); font-size: var(--fs-sub); font-weight: 600; }
.src-info small { color: var(--text-3); font-size: var(--fs-caption); line-height: var(--lh-caption); }
.src-info .src-url { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; opacity: .7; }
.src-del {
  display: grid; place-items: center; flex-shrink: 0;
  width: var(--sp-7); height: var(--sp-7); border-radius: var(--r-pill);
  color: var(--text-3); background: var(--fill);
}
.src-del:hover { color: var(--danger); background: var(--danger-soft); }
.src-add {
  margin-top: var(--sp-4); padding-top: var(--sp-4);
  border-top: 1px solid var(--border);
}
.src-add h3 { margin: 0; color: var(--text); font-size: var(--fs-sub); font-weight: 700; }
.src-add code {
  padding: 1px var(--sp-1); border-radius: 4px;
  background: var(--fill); font-family: var(--font-mono); font-size: .92em;
}
@keyframes pulse { 0%, 100% { opacity: .55; } 50% { opacity: 1; } }
@keyframes modalIn { from { opacity: 0; transform: translateY(var(--sp-2)); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .sheet, .skeleton { animation: none; } }
:root[data-motion='off'] .sheet, :root[data-motion='off'] .skeleton { animation: none; }
</style>
