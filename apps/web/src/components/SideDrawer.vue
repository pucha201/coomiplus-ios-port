<script setup lang="ts">
/**
 * 左侧会话抽屉。
 * DeepSeek 的抽屉是「推开主内容」而不是盖住，主体的位移由 ChatView 负责，
 * 这里只管面板自己的滑入、搜索、分组列表和行内操作。
 */
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useDeviceStore } from '@/stores/device'
import { useConfigStore } from '@/stores/config'
import { formatSessionTime, useSessionsStore, type SessionMeta } from '@/stores/sessions'
import {
  readManualGroups, writeManualGroups, newGroupId,
  readCollapsed, setCollapsed,
  type ManualGroup,
} from '@/utils/sessionGroupStore'
import { GLOBAL_SESSION_ID } from '@/bridge/life'
import { pickDirectory } from '@/utils/folderPicker'
import CoomiIcon from './CoomiIcon.vue'
import DeviceSwitcherSheet from './DeviceSwitcherSheet.vue'

const props = defineProps<{ open: boolean; fraction?: number; widthRatio?: number }>()
const emit = defineEmits<{ close: [] }>()

const router = useRouter()
const session = useSessionStore()
const device = useDeviceStore()
const sessions = useSessionsStore()
const config = useConfigStore()

const menuFor = ref<SessionMeta | null>(null)
/** 多选：null = 普通浏览；Set = 选择模式（侧栏头部换成批量操作条）。 */
const selected = ref<Set<string> | null>(null)
const selecting = computed(() => selected.value !== null)
function startSelecting(seed?: string): void {
  const next = new Set<string>()
  if (seed) next.add(seed)
  selected.value = next
  menuFor.value = null
}
function stopSelecting(): void {
  selected.value = null
}
function toggleSelect(id: string): void {
  if (!selected.value) return
  const next = new Set(selected.value)
  if (next.has(id)) next.delete(id); else next.add(id)
  selected.value = next
}
function isSelected(id: string): boolean { return selected.value?.has(id) ?? false }
const selectedCount = computed(() => selected.value?.size ?? 0)

/** 批量：归档 / 取消归档。 */
async function archiveSelection(archived: boolean): Promise<void> {
  const ids = [...(selected.value ?? [])]
  if (!ids.length) return
  for (const id of ids) await sessions.setArchived(id, archived)
  bumpGroups()
  stopSelecting()
}
/** 批量：删除。走原生页已有的删除链路（会同时清工作目录与传输通道）。 */
async function deleteSelection(): Promise<void> {
  const ids = [...(selected.value ?? [])]
  if (!ids.length) return
  for (const id of ids) session.deleteSession(id)
  stopSelecting()
}
/** 批量：移入分组（复用二级 sheet，目标是把整批移过去）。 */
const batchMoveOpen = ref(false)
const renamingId = ref('')
const renameText = ref('')
const deviceSheetOpen = ref(false)
const deviceLabel = computed(() => {
  if (device.mode === 'local') return '本机'
  return device.activeDevice?.name || '选择电脑'
})
const deviceOnline = computed(() =>
  device.mode === 'local' || device.activeDevice?.reachability === 'online',
)

const isEmpty = computed(() => sessions.flat.length === 0)

// ── 分组：手动分组置顶，其余按工作目录分（与桌面同一份逻辑与数据） ──

/** 版本号：任何分组读写后自增，逼下面的 computed 重算（localStorage 不是响应式的）。 */
const groupRev = ref(0)
function bumpGroups(): void { groupRev.value += 1 }

const manualGroups = computed<ManualGroup[]>(() => {
  void groupRev.value
  return readManualGroups()
})
const collapsed = computed<Record<string, boolean>>(() => {
  void groupRev.value
  return readCollapsed()
})

/** 搜索结果：跨分组平铺，不做分组。沿用 store 已过滤好的 filtered。 */
const searching = computed(() => sessions.query.trim().length > 0)

/** 目录名（分组标签）：取最后一段，避免整条 /data/data/... 撑爆侧栏。 */
function dirLabel(path: string): string {
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean)
  return parts[parts.length - 1] || path
}

interface DrawerSection {
  key: string
  label: string
  rows: SessionMeta[]
  manual?: ManualGroup
}

/**
 * 浏览态分组：手动分组置顶，其余按**项目根**归组。
 *
 * 规则（与目录语义对齐）：
 *  · 会话 cwd 为空、等于项目根、或位于 `<root>/<session-id>` 下 → 归入「对话」；
 *  · 用户显式选了别的目录 → 以该目录单独成组（标签取末段）。
 *
 * 以前这里直接平铺，用户反馈「对话」折叠栏消失、侧栏没有层级；恢复分组后
 * 默认项目下的所有会话只出现一个「对话」组，不会因为根目录变化长出一排伪项目。
 */
const sections = computed<DrawerSection[]>(() => {
  if (searching.value) return []
  const out: DrawerSection[] = []
  const grouped = new Set(manualGroups.value.map(group => group.id))
  for (const group of manualGroups.value) {
    const rows = sessions.filtered.filter(m => m.groupId === group.id)
    if (rows.length) out.push({ key: 'manual:' + group.id, label: group.name, rows, manual: group })
  }
  const rest = sessions.filtered.filter(m => !m.groupId || !grouped.has(m.groupId))
  const root = (sessions.currentCwd || '').replace(/\/+$/, '')
  const defaults: SessionMeta[] = []
  const dirs = new Map<string, SessionMeta[]>()
  for (const meta of rest) {
    const cwd = (meta.cwd || '').replace(/\/+$/, '')
    const insideRoot = !cwd || !root || cwd === root || cwd.startsWith(root + '/')
    if (insideRoot) { defaults.push(meta); continue }
    const list = dirs.get(cwd) ?? []
    list.push(meta)
    dirs.set(cwd, list)
  }
  if (defaults.length) out.push({ key: 'dir:default', label: '对话', rows: defaults })
  for (const [dir, rows] of [...dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.push({ key: 'dir:' + dir, label: dirLabel(dir), rows })
  }
  return out
})

/** 当前会话所在分组名（「移入分组」二级菜单的副标题）。 */
const currentGroupName = computed(() => {
  const meta = menuFor.value
  if (!meta) return ''
  if (meta.groupId) return manualGroups.value.find(group => group.id === meta.groupId)?.name || '未分组'
  return '未分组'
})

/** 二级 sheet：先把动作收进去，再展开分组列表（分组多时不再铺满整个菜单）。 */
const groupPickerFor = ref<SessionMeta | null>(null)
function openGroupPicker(): void {
  groupPickerFor.value = menuFor.value
}
function closeGroupPicker(): void {
  groupPickerFor.value = null
  closeMenu()
}

function toggleCollapse(key: string): void {
  const next = !collapsed.value[key]
  setCollapsed(key, next)
  bumpGroups()
}

// ── 分组操作 ──

/**
 * 应用内命名弹层：WebView 没有 WebChromeClient，window.prompt 一律返回 null，
 * 直接用它等于“点了没反应”。所有分组/项目重命名都走这里。
 */
const nameDialog = ref<{ title: string; value: string; apply: (value: string) => void } | null>(null)
function askName(title: string, value: string, apply: (value: string) => void): void {
  nameDialog.value = { title, value, apply }
}
function submitName(): void {
  const dialog = nameDialog.value
  if (!dialog) return
  const value = dialog.value.trim()
  nameDialog.value = null
  if (value) dialog.apply(value)
}

/** 新建分组，并把菜单当前那条会话移进去（菜单里有会话时）。 */
function createGroupAndMove(): void {
  const target = menuFor.value
  askName('新建分组', '', name => {
    const groups = readManualGroups()
    const group: ManualGroup = { id: newGroupId(), name, order: groups.length }
    writeManualGroups([...groups, group])
    if (target) moveTo(target.id, group.id)
    bumpGroups()
  })
  groupPickerFor.value = null
  closeMenu()
}

function moveTo(sessionId: string, groupId: string | undefined): void {
  sessions.setGroup(sessionId, groupId)
  bumpGroups()
}

function renameGroup(group: ManualGroup): void {
  askName('重命名分组', group.name, name => {
    writeManualGroups(readManualGroups().map(g => (g.id === group.id ? { ...g, name } : g)))
    bumpGroups()
  })
}

/** 解散分组：组里的会话退回按项目分组，会话本身不删。 */
function dissolveGroup(group: ManualGroup): void {
  for (const meta of sessions.metas) {
    if (meta.groupId === group.id) sessions.setGroup(meta.id, undefined)
  }
  writeManualGroups(readManualGroups().filter(g => g.id !== group.id))
  bumpGroups()
  closeMenu()
}

/** 工作目录摘要：截断到 ~24 字符，完整路径放 title。 */
const cwdShort = computed(() => {
  // 只认会话自己的幕布目录：项目根不是工作目录，拿它顶上会让冷启动先显示
  // `<root>` 再跳到 `<root>/<session-id>`（用户看到的「重启闪回」）。
  const value = session.cwd || ''
  if (!value) return '目录未定'
  return value.length > 26 ? '…' + value.slice(-25) : value
})

/** 全局常驻会话：标题跟随生命体开关/名称，未读显示数字徽标，永不消失。 */
const globalMeta = computed(() =>
  sessions.ensure(GLOBAL_SESSION_ID, config.digitalLifeEnabled ? '数字生命体' : '全局对话'),
)
const globalTitle = computed(() => {
  const metaTitle = globalMeta.value.title
  if (session.lifeUnreadName) return session.lifeUnreadName
  if (config.digitalLifeEnabled) {
    return metaTitle && metaTitle !== '新对话' ? metaTitle : '数字生命体'
  }
  return metaTitle && metaTitle !== '新对话' ? metaTitle : '全局对话'
})
const globalRunning = computed(() => sessions.isRunning(GLOBAL_SESSION_ID))
const isGlobalMeta = (m: SessionMeta | null) => m?.id === GLOBAL_SESSION_ID

// 抽屉一关就把临时态清掉；打开时的「后台运行中」刷新放到滑开动画之后，
// 避免 store 更新让整张列表在动画帧里重渲染（打开卡顿的固定来源之一）。
let runningTimer: number | undefined
watch(() => props.open, v => {
  window.clearTimeout(runningTimer)
  if (!v) {
    menuFor.value = null; renamingId.value = ''
    return
  }
  runningTimer = window.setTimeout(() => { sessions.refreshRunning() }, 400)
})
onBeforeUnmount(() => window.clearTimeout(runningTimer))

/**
 * 点会话：先关抽屉，下一帧再切会话。
 * 同一帧里既播抽屉退场、又整树换掉对话内容，两边抢帧就是可见的「闪一下」。
 * 分到下一帧后抽屉先走退场，会话在揭幕门后完成恢复/测量，互不打扰。
 */
function pick(id: string) {
  if (renamingId.value) return
  emit('close')
  requestAnimationFrame(() => { void session.openSession(id) })
}

function startNew() {
  session.newSession()
  emit('close')
}

function closeMenu() { menuFor.value = null; groupPickerFor.value = null; renamingId.value = ''; renameText.value = '' }

/** WebView 里 window.prompt 默认被吞掉，所以重命名走行内输入框。 */
async function beginRename() {
  const m = menuFor.value
  if (!m) return
  renamingId.value = m.id
  renameText.value = m.title
  await nextTick()
  const el = document.querySelector<HTMLInputElement>('.cm-rename')
  el?.focus()
  el?.select()
}

function cancelRename() { renamingId.value = ''; renameText.value = '' }

async function commitRename() {
  if (!renamingId.value) return
  const id = renamingId.value
  if (await sessions.rename(id, renameText.value)) { renamingId.value = ''; menuFor.value = null }
}

async function doArchive() {
  if (!menuFor.value) return
  const archived = !menuFor.value.archived
  if (await sessions.setArchived(menuFor.value.id, archived)) {
    bumpGroups()
    closeMenu()
  }
}

async function doPin() {
  if (!menuFor.value) return
  if (await sessions.togglePin(menuFor.value.id)) closeMenu()
}

async function doClear() {
  if (!menuFor.value) return
  if (await session.clearSessionData(menuFor.value.id)) closeMenu()
}

function doDelete() {
  if (!menuFor.value) return
  session.deleteSession(menuFor.value.id)
  closeMenu()
}

function go(path: string) {
  emit('close')
  router.push(path)
}

/** 选择工作目录：Android 走原生 SAF 目录选择（pickDirectory 桥），其余环境用应用内选择器。 */
async function pickCwd() {
  const bridge = (window as any).CoomiAndroid
  if (bridge?.pickDirectory) {
    const onSelected = (e: Event) => {
      window.removeEventListener('coomi:folder-selected', onSelected as any)
      const path = (e as CustomEvent<{ path?: string }>).detail?.path
      if (path) void applyCwd(path)
    }
    window.addEventListener('coomi:folder-selected', onSelected as any)
    bridge.pickDirectory()
    return
  }
  const path = await pickDirectory(session.cwd || '')
  if (path) await applyCwd(path)
}

async function applyCwd(path: string) {
  const ok = await session.setSessionCwd(path)
  if (!ok) alert('切换工作目录失败（目录不存在或无权限）')
}


/**
 * 控制台 = 网页设置首页（#/settings）。
 * 以前走原生 CoomiDashboardActivity；控制台改成网页宿主后，再调 openDashboard
 * 会绕一圈回到同一个网页，还多一次 Activity 切换。这里直接进路由。
 */
function openDashboard() {
  emit('close')
  const drawerApi = (window as unknown as { __coomiDrawer?: { reset?: () => void } }).__coomiDrawer
  drawerApi?.reset?.()
  document.documentElement.style.setProperty('--cp-f', '0')
  window.setTimeout(() => { void router.push('/settings') }, 90)
}
</script>

<template>
  <div
    class="drawer-root"
    :class="{ open }"
  >
    <div class="scrim" @click="emit('close')" />

    <aside class="panel" role="dialog" aria-label="会话历史">
      <button class="device-head" @click="deviceSheetOpen = true">
        <span class="device-icon"><CoomiIcon :name="device.mode === 'local' ? 'phone' : 'cpu'" :size="16" /></span>
        <span class="device-name">{{ deviceLabel }}</span>
        <span class="device-state" :class="{ online: deviceOnline }" />
        <CoomiIcon name="chevronDown" :size="13" class="device-chev" />
      </button>

      <header class="dhead">
        <!-- 选择模式：搜索框换成批量操作条（与 dsh-go 的 SelectionActionBar 同义）。 -->
        <div v-if="selecting" class="selbar">
          <button class="sel-x" aria-label="退出多选" @click="stopSelecting">
            <CoomiIcon name="close" :size="16" />
          </button>
          <span class="sel-count">已选 {{ selectedCount }}</span>
          <button class="sel-act" :disabled="!selectedCount" @click="archiveSelection(true)">归档</button>
          <button class="sel-act danger" :disabled="!selectedCount" @click="deleteSelection">删除</button>
        </div>
        <div v-else class="sfield">
          <CoomiIcon name="search" :size="17" />
          <input v-model="sessions.query" type="text" placeholder="搜索历史会话" enterkeyhint="search" />
          <button v-if="sessions.query" class="clr" aria-label="清空" @click="sessions.query = ''">
            <CoomiIcon name="close" :size="12" />
          </button>
        </div>
      </header>

      <button class="newrow" @click="startNew">
        <span class="nicon"><CoomiIcon name="pencil" :size="22" /></span>
        <span>开启新对话</span>
      </button>
      <div class="entry-row">
        <button class="entry" @click="go('/files')">
          <CoomiIcon name="folder" :size="20" />
          <span>文件</span>
        </button>
        <button class="entry" @click="go('/catalog')">
          <CoomiIcon name="cube" :size="20" />
          <span>拓展</span>
        </button>
      </div>
      <button class="cwdrow" title="切换工作目录" @click="pickCwd">
        <CoomiIcon name="folder" :size="20" />
        <span class="cwdtext">{{ cwdShort }}</span>
      </button>
      <button class="taskrow" @click="go('/tasks')">
        <CoomiIcon name="subtask" :size="20" />
        <span>任务中心</span>
        <span v-if="sessions.runningIds.size" class="task-count">{{ sessions.runningIds.size }}</span>
      </button>
      <button v-if="sessions.archived.length" class="taskrow" @click="go('/sessions/archived')">
        <CoomiIcon name="broom" :size="20" />
        <span>已归档</span>
        <span class="task-count">{{ sessions.archived.length }}</span>
      </button>

      <div class="list">
        <div
          v-if="true"
          class="row global-row"
          :class="{ cur: session.sessionId === GLOBAL_SESSION_ID }"
          @click="pick(GLOBAL_SESSION_ID)"
        >
          <span class="gicon"><CoomiIcon name="lifeRings" :size="20" /></span>
          <div class="rmain">
            <p class="rtitle">{{ globalTitle }}</p>
            <p class="rmeta">
              <span>{{ formatSessionTime(globalMeta.updatedAt) }}</span>
              <span v-if="session.lifeUnread.length" class="global-badge" aria-label="生命体未读消息">{{ session.lifeUnread.length }}</span>
              <span v-if="globalRunning" class="rspin" aria-label="后台运行中" />
            </p>
          </div>
          <button class="rmore" aria-label="更多" @click.stop="menuFor = globalMeta">
            <CoomiIcon name="more" :size="20" />
          </button>
        </div>
        <!-- 本地模式常驻「全局对话」行，它本身就是一条会话；再挂「还没有历史会话」
             会自相矛盾。空态只留给云端 / 本地之外确实一条都没有的情况。 -->
        <p v-if="isEmpty" class="empty-sm">
          还没有历史会话。<br />随便说点什么，标题会用你的第一句话。
        </p>
        <!-- 搜索态：跨分组平铺，不分节（分组只用于浏览，不用于检索） -->
        <template v-if="searching">
          <div
            v-for="m in sessions.flat"
            :key="m.id"
            class="row"
            :class="{ cur: m.id === session.sessionId, sel: isSelected(m.id) }"
            @click="selecting ? toggleSelect(m.id) : pick(m.id)"
          >
            <span v-if="selecting" class="check" :class="{ on: isSelected(m.id) }" aria-hidden="true">
              <CoomiIcon v-if="isSelected(m.id)" name="check" :size="11" />
            </span>
            <div class="rmain">
              <input
                v-if="renamingId === m.id"
                v-model="renameText"
                class="rename"
                @click.stop
                @keyup.enter="commitRename"
                @blur="commitRename"
              />
              <p v-else class="rtitle">{{ m.title }}</p>
              <p class="rmeta">
                <CoomiIcon v-if="m.pinned" name="pin" :size="11" />
                <span>{{ formatSessionTime(m.updatedAt) }}</span>
                <span v-if="sessions.isRunning(m.id)" class="rspin" aria-label="后台运行中" />
              </p>
            </div>
            <button class="rmore" aria-label="更多" @click.stop="menuFor = m">
              <CoomiIcon name="more" :size="20" />
            </button>
          </div>
        </template>

        <!-- 浏览态：手动分组置顶 → 项目分组（默认项目统一收进「对话」） -->
        <template v-else>
          <section v-for="section in sections" :key="section.key" class="grp">
            <div class="ghead">
              <button class="gfold" @click="toggleCollapse(section.key)">
                <CoomiIcon
                  name="chevronRight"
                  :size="12"
                  class="gchev"
                  :class="{ open: !collapsed[section.key] }"
                />
                <span class="gname">{{ section.label }}</span>
                <span class="gcount">{{ section.rows.length }}</span>
              </button>
              <button
                v-if="section.manual"
                class="gmenu"
                aria-label="分组操作"
                @click.stop="renameGroup(section.manual)"
              >
                <CoomiIcon name="more" :size="16" />
              </button>
            </div>
            <template v-if="!collapsed[section.key]">
              <div
                v-for="m in section.rows"
                :key="m.id"
                class="row"
                :class="{ cur: m.id === session.sessionId, sel: isSelected(m.id) }"
                @click="selecting ? toggleSelect(m.id) : pick(m.id)"
              >
                <span v-if="selecting" class="check" :class="{ on: isSelected(m.id) }" aria-hidden="true">
                  <CoomiIcon v-if="isSelected(m.id)" name="check" :size="11" />
                </span>
                <div class="rmain">
                  <input
                    v-if="renamingId === m.id"
                    v-model="renameText"
                    class="rename"
                    @click.stop
                    @keyup.enter="commitRename"
                    @blur="commitRename"
                  />
                  <p v-else class="rtitle">{{ m.title }}</p>
                  <p class="rmeta">
                    <CoomiIcon v-if="m.pinned" name="pin" :size="11" />
                    <span>{{ formatSessionTime(m.updatedAt) }}</span>
                    <span v-if="sessions.isRunning(m.id)" class="rspin" aria-label="后台运行中" />
                  </p>
                </div>
                <button class="rmore" aria-label="更多" @click.stop="menuFor = m">
                  <CoomiIcon name="more" :size="20" />
                </button>
              </div>
            </template>
          </section>
        </template>
      </div>

      <footer class="dfoot">
        <button class="frow console" @click="openDashboard">
          <CoomiIcon name="terminal" :size="20" />
          <span class="fname">CoomiPlus 控制台</span>
        </button>
        <span class="dfoot-end" aria-hidden="true"></span>
      </footer>
    </aside>

    <!-- 行内「更多」面板：第二类语义（--expand-*，forwards）。
         以前只有 sheet-rise（backwards），关掉的那一帧直接消失；
         这里用 <Transition> 把收起也补上，且打开/收起各一条 keyframes。 -->
    <!-- 会话菜单：使用 rc33 的底部弹层（.cm-sheet），重命名在同一弹层内完成 -->
    <Teleport to="body">
      <Transition name="cm-sheet">
      <div v-if="menuFor && !groupPickerFor" class="cm-sheet-root is-open">
        <div class="cm-backdrop" @click="closeMenu" />
        <section class="cm-sheet" role="dialog" aria-modal="true">
          <div class="cm-grab" />
          <div class="cm-sheet__head">
            <div class="cm-sheet__title">{{ renamingId ? '重命名会话' : menuFor.title }}</div>
            <button class="cm-sheet__x" aria-label="关闭" @click="closeMenu">×</button>
          </div>
          <div class="cm-sheet__body">
            <template v-if="renamingId">
              <input v-model="renameText" class="cm-rename" @keyup.enter="commitRename" />
              <div class="cm-sheet__foot" style="display:flex;gap:10px;padding:12px 0 4px">
                <button class="cm-btn" @click="cancelRename">取消</button>
                <button class="cm-btn cm-btn--primary" @click="commitRename">保存</button>
              </div>
            </template>
            <template v-else>
              <button class="cm-item" @click="beginRename">
                <span class="cm-item__ico"><CoomiIcon name="pencil" :size="18" /></span>
                <span class="cm-item__body"><span class="cm-item__t">重命名</span></span>
              </button>
              <template v-if="isGlobalMeta(menuFor)">
                <button class="cm-item" @click="doClear">
                  <span class="cm-item__ico"><CoomiIcon name="trash" :size="18" /></span>
                  <span class="cm-item__body"><span class="cm-item__t">清空会话数据</span><span class="cm-item__s">全局常驻会话：可清空，不可删除</span></span>
                </button>
              </template>
              <template v-else>
                <button class="cm-item" @click="startSelecting(menuFor!.id)">
                  <span class="cm-item__ico"><CoomiIcon name="todo" :size="18" /></span>
                  <span class="cm-item__body"><span class="cm-item__t">多选</span></span>
                </button>
                <button class="cm-item" @click="doArchive">
                  <span class="cm-item__ico"><CoomiIcon name="broom" :size="18" /></span>
                  <span class="cm-item__body">
                    <span class="cm-item__t">{{ menuFor?.archived ? '取消归档' : '归档' }}</span>
                    <span class="cm-item__s">收进「已归档」，不删除</span>
                  </span>
                </button>
                <button class="cm-item" @click="doPin">
                  <span class="cm-item__ico"><CoomiIcon name="pin" :size="18" /></span>
                  <span class="cm-item__body"><span class="cm-item__t">{{ menuFor.pinned ? '取消置顶' : '置顶' }}</span></span>
                </button>
                <!-- 分组：二级 sheet 选择。以前把所有分组直接铺在菜单里，
                     分组一多菜单就长得看不到底，也看不出这是一个动作。 -->
                <button class="cm-item" @click="openGroupPicker">
                  <span class="cm-item__ico"><CoomiIcon name="folder" :size="18" /></span>
                  <span class="cm-item__body">
                    <span class="cm-item__t">移入分组</span>
                    <span class="cm-item__s">当前：{{ currentGroupName }}</span>
                  </span>
                  <CoomiIcon name="chevronRight" :size="14" class="cm-item__chev" />
                </button>
                <button class="cm-item" @click="doDelete">
                  <span class="cm-item__ico"><CoomiIcon name="trash" :size="18" /></span>
                  <span class="cm-item__body"><span class="cm-item__t">删除会话</span></span>
                </button>
              </template>
            </template>
          </div>
        </section>
      </div>
      </Transition>
    </Teleport>
    <!-- 二级 sheet：移入分组。
         只在这里列出全部分组；主菜单永远只有一行入口，分组再多也不会把菜单撑长。 -->
    <Teleport to="body">
      <Transition name="cm-sheet">
        <div v-if="groupPickerFor" class="cm-sheet-root is-open cm-sheet-root--sub">
          <div class="cm-backdrop" @click="closeGroupPicker" />
          <section class="cm-sheet" role="dialog" aria-modal="true">
            <div class="cm-grab" @click="closeGroupPicker" />
            <div class="cm-sheet__head">
              <div class="cm-sheet__title">移入分组</div>
              <button class="cm-sheet__x" aria-label="关闭" @click="closeGroupPicker">×</button>
            </div>
            <div class="cm-sheet__body">
              <button class="cm-item" @click="createGroupAndMove">
                <span class="cm-item__ico"><CoomiIcon name="plus" :size="18" /></span>
                <span class="cm-item__body"><span class="cm-item__t">新建分组并移入</span></span>
              </button>
              <button
                v-for="group in manualGroups"
                :key="group.id"
                class="cm-item"
                @click="moveTo(groupPickerFor!.id, group.id); closeGroupPicker()"
              >
                <span class="cm-item__ico"><CoomiIcon name="folder" :size="18" /></span>
                <span class="cm-item__body"><span class="cm-item__t">{{ group.name }}</span></span>
                <CoomiIcon
                  v-if="groupPickerFor?.groupId === group.id"
                  name="check"
                  :size="16"
                  class="cm-item__check"
                />
              </button>
              <p v-if="!manualGroups.length" class="cm-empty">还没有分组。新建一个，把会话收进去。</p>
              <button
                v-if="groupPickerFor?.groupId"
                class="cm-item"
                @click="moveTo(groupPickerFor!.id, undefined); closeGroupPicker()"
              >
                <span class="cm-item__ico"><CoomiIcon name="folder" :size="18" /></span>
                <span class="cm-item__body"><span class="cm-item__t">移出分组</span></span>
              </button>
            </div>
          </section>
        </div>
      </Transition>
    </Teleport>
    <!-- 命名弹层：分组/项目重命名都用它（window.prompt 在 WebView 里返回 null） -->
    <Teleport to="body">
      <div v-if="nameDialog" class="cm-sheet-root is-open">
        <div class="cm-backdrop" @click="nameDialog = null" />
        <section class="cm-sheet" role="dialog" aria-modal="true">
          <div class="cm-grab" />
          <div class="cm-sheet__head">
            <div class="cm-sheet__title">{{ nameDialog.title }}</div>
            <button class="cm-sheet__x" aria-label="关闭" @click="nameDialog = null">×</button>
          </div>
          <div class="cm-sheet__body">
            <input v-model="nameDialog.value" class="cm-rename" @keyup.enter="submitName" />
            <div class="cm-sheet__foot" style="display:flex;gap:10px;padding:12px 0 4px">
              <button class="cm-btn" @click="nameDialog = null">取消</button>
              <button class="cm-btn cm-btn--primary" @click="submitName">保存</button>
            </div>
          </div>
        </section>
      </div>
    </Teleport>

    <Teleport to="body">
      <DeviceSwitcherSheet :open="deviceSheetOpen" @close="deviceSheetOpen = false" />
    </Teleport>
  </div>
</template>

<style scoped>
/* 二级 sheet 的附加元素 */
.cm-item__chev { margin-left: auto; color: var(--text-3); flex: none; }
.cm-item__check { margin-left: auto; color: var(--blue); flex: none; }
.cm-empty {
  margin: var(--sp-2) 0 var(--sp-1);
  padding: 0 2px;
  font-size: var(--fs-label); color: var(--text-3);
}

/* 会话菜单/命名弹层：打开与收起都有过渡（以前是 v-if 硬切） */
.cm-sheet-enter-active, .cm-sheet-leave-active { transition: opacity 180ms var(--ease-out); }
.cm-sheet-enter-active :deep(.cm-sheet), .cm-sheet-leave-active :deep(.cm-sheet) {
  transition: transform 220ms cubic-bezier(.22, .68, .19, 1);
}
.cm-sheet-enter-from, .cm-sheet-leave-to { opacity: 0; }
.cm-sheet-enter-from :deep(.cm-sheet), .cm-sheet-leave-to :deep(.cm-sheet) { transform: translateY(18px); }

/* 只保留 rc33 补丁没有定义的结构与细节；其余样式全部交给 vendor/rc33-ui */
/* 连接条出现时面板要下移 28px（让开顶部的本地/云端切换）。规则放在
   styles/global.css：选择器要从 #app 的 .banner 往下找 .panel，scoped 的
   :global() 会在编译时吞掉后面的选择器，只有全局样式表能写完整。 */
.drawer-root { position: fixed; inset: 0; pointer-events: none; }
.drawer-root.open { pointer-events: auto; }
/* 面板是静止底图：关闭态放在屏外（-100%），打开态回到 0 位；
   露出多少完全由 ChatView 里卡片滑开的距离决定，面板自身不参与滑入动画。
   宽度与卡片位移共用 --drawer-w，保证滑开后正好对齐、不漏出底图缝隙。 */
.drawer-root .panel {
  width: var(--drawer-w, min(82vw, 336px));
  /* 与对话页拉开层次：对话页底是 --bg（白/近黑），面板用低一档的 --page，
     再加一条右缘细线与阴影。以前两边同为 --bg、只靠 .10 的中继阴影，
     浅色下几乎看不见，用户的原话是「融在一块」。 */
  background: var(--page);
  transform: translate3d(-100%, 0, 0);
  visibility: hidden;
}
.drawer-root.open .panel { visibility: visible; transform: none; }
.drawer-root .scrim { position: absolute; inset: 0; }
.drawer-root .panel {
  position: absolute; inset: 0 auto 0 0;
  display: flex; flex-direction: column;
  padding-top: var(--safe-top);
}


/* 补丁只定义了外观，布局骨架仍需这里提供（rc33 原本由基础样式给） */
.drawer-root .dhead { display: flex; align-items: center; gap: var(--sp-1); }
.device-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: calc(100% - 20px);
  margin: var(--sp-3) 10px var(--sp-1);
  padding: var(--sp-1) 2px;
  border: 0;
  border-radius: var(--r-sm);
  background: none;
  color: var(--text);
  text-align: left;
}
.device-head:active { background: var(--fill-press); }
.device-icon {
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  color: var(--text-3);
  flex-shrink: 0;
}
.device-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: var(--fs-strong);
  font-weight: 650;
  letter-spacing: -.01em;
}
.device-state {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.device-state.online { background: var(--ok); box-shadow: 0 0 0 3px color-mix(in srgb, var(--ok) 18%, transparent); }
.device-chev { color: var(--text-3); flex-shrink: 0; }
.drawer-root .sfield { display: flex; flex: 1; align-items: center; gap: 7px; padding: 0 10px; }
.drawer-root .sfield input {
  flex: 1; min-width: 0; border: 0; background: none; outline: none;
  font: inherit; font-size: var(--fs-body); color: var(--text);
}
.drawer-root .sfield input::placeholder { color: var(--text-3); }
.drawer-root .clr {
  display: grid; place-items: center; width: 18px; height: 18px;
  border: 0; border-radius: 50%; background: var(--border-strong); color: #fff;
}
.drawer-root .newrow { display: flex; align-items: center; }
.drawer-root .nicon {
  display: grid; place-items: center; width: 26px; height: 26px;
  border-radius: 50%; background: color-mix(in srgb, #fff 18%, transparent);
}
.drawer-root .cwdrow, .drawer-root .taskrow {
  display: flex; align-items: center; gap: var(--sp-3);
}
.drawer-root .cwdtext { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-root .row { display: flex; align-items: center; gap: var(--sp-1); }
.drawer-root .list { flex: 1; min-height: 0; overflow-y: auto; -webkit-overflow-scrolling: touch; }
/* 底部行不许被列表压缩：以前没有 flex:none，会话多的时候「控制台」被挤到只剩一条缝。 */
.drawer-root .dfoot {
  display: flex; align-items: stretch; flex: none;
  padding-bottom: calc(env(safe-area-inset-bottom, 0px) + 6px);
  /* vendor 给 .dfoot 铺了 --bg 白底：面板底是 --page，底部就出现一条更白的带子。
     让它跟面板同色（透明，由 .panel 的底色透上来）。 */
  background: transparent !important;
}
.drawer-root .dfoot .frow {
  display: flex; align-items: center; gap: var(--sp-3); flex: 1; min-width: 0;
  min-height: 48px; border: 0; background: none;
}
.drawer-root .dfoot .fname { flex: 1; text-align: left; }
/* 新建对话与底部入口都按 48px 触控高度、22px 图标放大。 */
.drawer-root .newrow { min-height: 48px; }
.drawer-root .nicon { width: 34px; height: 34px; }

.drawer-root .cm-devrow { background: color-mix(in srgb, var(--blue) 12%, var(--bg)) !important;
  border-color: color-mix(in srgb, var(--blue) 38%, var(--border)) !important; }
.drawer-root .cm-devrow__t { color: var(--blue) !important; font-weight: 700 !important; }
.drawer-root .cm-devrow__ico { background: color-mix(in srgb, var(--blue) 16%, transparent) !important; color: var(--blue) !important; }

/* 分组折叠头（对齐桌面端列表收纳） */
.drawer-root .group-head {
  display: flex; align-items: center; gap: 6px; width: 100%;
  border: 0; background: none; text-align: left; cursor: pointer;
}
.drawer-root .group-head .gchev { transition: transform var(--dur-fast) var(--ease-out); transform: rotate(-90deg); }
.drawer-root .group-head .gchev.open { transform: rotate(0deg); }
.drawer-root .group-head .gcount { margin-left: auto; color: var(--text-3); font-size: var(--fs-caption); }

/* 四个入口两列排布：以前挤成一行，中文标签被裁成「协同…」「群聊…」。 */
.selbar {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: 44px; padding: 0 var(--sp-1);
}
.sel-x {
  display: grid; place-items: center; flex: none; width: 32px; height: 32px;
  border-radius: 50%; background: var(--fill); color: var(--text-2);
}
.sel-count { flex: 1; min-width: 0; font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.sel-act {
  flex: none; min-height: 30px; padding: 0 var(--sp-3); border-radius: var(--r-pill);
  background: var(--fill-strong); color: var(--text); font-size: var(--fs-label); font-weight: 600;
}
.sel-act.danger { color: var(--danger); background: var(--danger-soft); }
.sel-act:disabled { opacity: .4; }
.check {
  display: grid; place-items: center; flex: none; width: 20px; height: 20px;
  margin-right: 2px; border-radius: 50%;
  border: 1.5px solid var(--border-strong); color: var(--bg);
}
.check.on { border-color: var(--blue); background: var(--blue); }

.entry-row {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2);
  padding: 0 var(--sp-3) var(--sp-2); flex: none;
}
.entry-row .entry {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: 44px; min-width: 0; padding: 0 var(--sp-2);
  border: 0; border-radius: var(--r-md); background: var(--fill);
  color: var(--text); font-size: var(--fs-sub); text-align: left;
}
.entry-row .entry span {
  min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.entry-row .entry:active { background: var(--fill-press); }

/* 会话行里补丁未覆盖的细节。
 *
 * 瘦身：原来一行是「标题 + meta + preview」三行，实测约 62px。
 * 现在改成单行标题 + 右侧时间，preview 副文整条删掉（识别会话靠标题，
 * preview 在这里信息密度太低，纯占高度）。目标行高 ~42px，一屏多 3–4 条。 */
.rmain {
  flex: 1; min-width: 0;
  display: flex; align-items: center; gap: 6px;
}
.rtitle {
  flex: 1; min-width: 0;
  font-size: var(--fs-sub); line-height: 1.25;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.rmeta {
  flex: none; display: flex; align-items: center; gap: var(--sp-1);
  margin: 0; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap;
}
/* 卡片高度收紧：44 → 36（v2 再缩一档），padding 用半档令牌。 */
.drawer-root .row {
  min-height: 36px;
  padding: var(--sp-1) var(--sp-2);
  border-radius: var(--r-md);
}
/* 「更多」保持 28px 触控区，默认透明，当前行/悬停才显形 —— 不占视觉重量。 */
.rmore {
  flex: none; display: grid; place-items: center;
  width: 28px; height: 28px; border: 0; border-radius: 50%;
  background: none; color: var(--text-3);
  opacity: 0; transition: opacity 120ms var(--ease-out);
}
.drawer-root .row.cur .rmore,
.drawer-root .row:hover .rmore { opacity: 1; }
.rmore:active { background: var(--fill-press); }

/* ── 分组标题行 ──
   规格：高 36、上下留 8/4、--fill 底、圆角 10、描边一条、13/500 --text-2。
   以前只有 13px 灰字，和会话行糊在一起，用户看不出这是可折叠的头。 */
.grp { display: flex; flex-direction: column; }
.grp + .grp { margin-top: 2px; }
/* 分组头不再套一个描边方框：与 dsh-go 一样只留一行标签，靠留白分组。
   框在窄屏上会和会话行抢注意力，看起来像「一组里又有一个卡片」。 */
.ghead {
  display: flex; align-items: center; gap: 2px;
  width: 100%; min-height: 30px;
  margin: var(--sp-3) 0 2px;
  padding: 0 var(--sp-1);
  border: 0;
  border-radius: 0;
  background: transparent;
}
.gfold {
  display: flex; align-items: center; gap: 6px;
  flex: 1; min-width: 0; min-height: 34px; padding: 0 2px;
  border: 0; background: none; text-align: left;
  font-size: var(--fs-sub); font-weight: 500; color: var(--text-2);
}
.gfold:active { opacity: .7; }
.gmenu {
  flex: none; display: grid; place-items: center;
  width: 26px; height: 26px; padding: 0;
  border: 0; border-radius: 50%; background: none;
  color: var(--text-3); opacity: .9;
}
.gmenu:active { background: var(--fill-press); }
.gchev { flex: none; color: var(--text-3); transition: transform var(--dur-base) var(--ease-out); }
.gchev.open { transform: rotate(90deg); }
.gname {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  text-transform: none;
  font-weight: 500; color: var(--text-2);
}
.gcount {
  flex: none; min-width: 18px; padding: 0 5px;
  border-radius: var(--r-pill); background: var(--bg);
  color: var(--text-3);
  font-size: var(--fs-caption); font-weight: 600; text-align: center;
}
.global-row .gicon {
  flex: none; display: grid; place-items: center;
  width: 30px; height: 30px; margin-right: 6px;
  border-radius: 50%; color: var(--accent);
  background: color-mix(in srgb, var(--accent-soft) 60%, var(--bg));
}
.global-badge {
  display: inline-grid; place-items: center;
  min-width: 16px; min-height: 16px; padding: 0 var(--sp-1);
  border-radius: var(--r-sm); background: var(--accent); color: #fff;
  font-size: var(--fs-caption); font-weight: 600; line-height: 1;
}
.rspin {
  flex: none; width: 7px; height: 7px; border-radius: 50%;
  background: var(--blue);
  animation: coomi-breathe var(--dur-loop) var(--ease-in-out) infinite;
}
.task-count {
  margin-left: auto; min-width: 22px; padding: 2px 7px;
  border-radius: var(--r-pill); background: var(--blue); color: #fff;
  font-size: var(--fs-caption); text-align: center;
}

/* 重命名输入（rc33 弹层内） */
.dfoot-end { display: none; }
.cm-rename {
  width: 100%; min-height: 44px; padding: 0 var(--sp-3); box-sizing: border-box;
  border: 1px solid var(--blue-border); border-radius: var(--r-md);
  background: var(--bg); color: var(--text); font: inherit; font-size: var(--fs-body);
  outline: none;
}
.cm-rename:focus { box-shadow: 0 0 0 3px color-mix(in srgb, var(--blue) 18%, transparent); }
@media (prefers-reduced-motion: reduce) { .rspin { animation: none; opacity: 1; } }
</style>
