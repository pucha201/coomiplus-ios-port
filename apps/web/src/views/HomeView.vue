<script setup lang="ts">
/**
 * 独立首页 — 类 QQ 底栏三 Tab（消息 / 通讯录 / 我的）。
 * 项目化：先选项目，再看该项目的群 / 通讯录；支持旧版数据清理。
 */
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import { useGroupChatStore } from '@/features/collab-chat/stores/groupChatStore'
import type { RoomMember, SpeakMode } from '@/features/collab-chat/types/groupChat'
import { useConfigStore } from '@/stores/config'

const router = useRouter()
const store = useGroupChatStore()
const config = useConfigStore()

const createOpen = ref(false)
const createBusy = ref(false)
const form = ref({
  name: '', topic: '', speakMode: 'round_robin' as SpeakMode, members: [] as RoomMember[],
})
const pendingDelete = ref<{ id: string; name: string } | null>(null)
/** 无项目时先弹这个 */
const projectOpen = ref(false)
const projectBusy = ref(false)
const projectForm = ref({ name: '', description: '' })
/** 无项目的全屏引导（先创建一个项目） */
const setupOpen = ref(false)
/** 项目列表抽屉 */
const projListOpen = ref(false)
/** 删除整个角色确认 */
const pendingDeleteIdentity = ref<{ id: string; name: string } | null>(null)

const models = computed(() =>
  config.providers.flatMap(p =>
    (p.models.length ? p.models : [p.model]).filter(Boolean)
      .map(m => ({ value: `${p.id}:${m}`, label: `${p.name} · ${m}` })),
))

const modeOptions = [
  { value: 'round_robin', label: '轮流发言' },
  { value: 'open', label: '开放抢麦' },
  { value: 'host', label: '主持指定' },
]
const iconOptions = [
  { value: 'chat', label: '聊天' },
  { value: 'terminal', label: '代码' },
  { value: 'shield', label: '审查' },
  { value: 'people', label: '协作' },
  { value: 'sparkle', label: '创意' },
  { value: 'target', label: '目标' },
]
const modelOptions = computed(() => [
  { value: '', label: '默认模型' },
  ...models.value,
])

const runningCount = computed(() => store.summaries.filter(r => r.status === 'running').length)

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}
function modeLabel(m: SpeakMode): string {
  if (m === 'open') return '抢麦'
  if (m === 'host') return '主持'
  return '轮流'
}

function openRoom(id: string) {
  router.push(`/im/${id}`)
}
function openDm(id: string) {
  router.push(`/im/dm/${id}`)
}
function openAiChat() {
  router.push('/')
}
function openCollab() {
  router.push('/collab')
}
function openSettings() {
  router.push('/settings')
}

/** 建群前：确保有活跃项目，无则弹项目创建。 */
async function ensureProjectThen(fn: () => void) {
  const p = await store.ensureProject()
  if (p) {
    // 预拉通讯录，供重名检测 / 沿用记忆询问
    if (!store.identities.length) await store.loadIdentities(p.id)
    fn()
  } else {
    createOpen.value = false
    projectOpen.value = true
  }
}
function openCreate() {
  void ensureProjectThen(() => {
    form.value = {
      name: '', topic: '', speakMode: 'round_robin', members: [
        { id: 'coder', name: '执行者', modelSelector: models.value[0]?.value || '', prompt: '负责实现与改码，简洁汇报结果。', color: '#2d61c6', icon: 'terminal', quota: 0, persona: '', speakingStyle: '', values: '' },
        { id: 'reviewer', name: '审查者', modelSelector: models.value[1]?.value || models.value[0]?.value || '', prompt: '只读审查，指出问题与建议，不改代码。', color: '#d47458', icon: 'shield', quota: 0, persona: '', speakingStyle: '', values: '' },
      ],
    }
    createOpen.value = true
  })
}
async function submitProject() {
  if (!projectForm.value.name.trim()) return
  projectBusy.value = true
  try {
    const p = await store.createProject(projectForm.value.name.trim(), projectForm.value.description.trim())
    if (p) {
      projectOpen.value = false
      projectForm.value = { name: '', description: '' }
      if (setupOpen.value) {
        // 全屏引导路径：创建成功后关闭遮罩，加载房间列表
        setupOpen.value = false
        void store.loadRooms()
      } else {
        openCreate()
      }
    }
  } finally {
    projectBusy.value = false
  }
}
function askDeleteIdentity(m: { id: string; name: string }) {
  pendingDeleteIdentity.value = m
}
async function confirmDeleteIdentity() {
  const target = pendingDeleteIdentity.value
  const pid = store.activeProject?.id
  if (!target || !pid) return
  const r = await store.deleteIdentity(pid, target.id)
  if (r) {
    pendingDeleteIdentity.value = null
    // 成员可能被从各群移除，刷新房间摘要
    void store.loadRooms()
  } else {
    alert(store.error || '删除失败，请重试')
    pendingDeleteIdentity.value = null
  }
}
function switchProject(e: Event) {
  const id = (e.target as HTMLSelectElement).value
  if (id && id !== store.activeProject?.id) void store.activateProject(id)
}
function openProjectList() {
  projListOpen.value = true
  void store.loadProjects()
}
function pickProject(pid: string) {
  if (pid !== store.activeProject?.id) void store.activateProject(pid)
  projListOpen.value = false
}
function startCreateProject() {
  projListOpen.value = false
  projectOpen.value = true
}
async function removeProject(pid: string, name: string) {
  if (!confirm(`删除项目「${name}」？其中的群聊、记忆与单聊将一并删除，不可恢复。`)) return
  const ok = await store.deleteProject(pid)
  if (!ok) alert(store.error || '删除失败')
  void store.loadProjects()
}
function addMember() {
  const palette = ['#2d61c6', '#d47458', '#1f9d6b', '#8b5cf6', '#db2777']
  const icons = ['chat', 'terminal', 'shield', 'people', 'sparkle', 'target']
  const i = form.value.members.length
  form.value.members.push({
    id: `m${Date.now()}_${i}`, name: `成员${i + 1}`, modelSelector: models.value[0]?.value || '', prompt: '参与讨论，给出有帮助的回复。', color: palette[i % palette.length], icon: icons[i % icons.length], quota: 8, persona: '', speakingStyle: '', values: '',
  })
}
function removeMember(i: number) {
  if (form.value.members.length <= 1) return
  form.value.members.splice(i, 1)
}
async function submitCreate() {
  if (!form.value.name.trim() || form.value.members.length < 1) return
  createBusy.value = true
  try {
    // 重名成员 → 询问沿用记忆 / 覆盖人设
    let overwritePersona = false
    if (store.identities.length) {
      const dup = form.value.members.find(m =>
        m.name.trim() && store.identities.some(i => i.nameKey === m.name.trim().toLowerCase() || i.name === m.name.trim()),
      )
      if (dup) {
        const reuse = confirm(`成员「${dup.name}」已存在，沿用其记忆？\n（取消则覆盖人设）`)
        overwritePersona = !reuse
      }
    }
    const data = await store.createRoom(
      form.value.name.trim(), form.value.topic.trim(), form.value.speakMode, form.value.members.map(m => ({ ...m, modelSelector: m.modelSelector || models.value[0]?.value || '' })),
      {
        projectId: store.activeProject?.id, overwritePersona,
      },
    )
    if (data?.room) {
      createOpen.value = false
      openRoom(data.room.id)
    }
  } finally {
    createBusy.value = false
  }
}
function askDelete(room: { id: string; name: string } | null) {
  if (!room) return
  pendingDelete.value = room
}
async function confirmDelete() {
  if (!pendingDelete.value) return
  await store.removeRoom(pendingDelete.value.id)
  pendingDelete.value = null
}

let poll: ReturnType<typeof setInterval> | null = null
onMounted(async () => {
  // 清掉上一页残留的网络错误（如 Failed to fetch）
  store.error = ''
  // 先拉项目列表；无项目则显示全屏创建引导（不自动建）
  await store.loadProjects()
  if (!store.activeProject) {
    setupOpen.value = true
  } else {
    void store.loadRooms()
  }
  if (config.providers.length === 0) void config.fetchProviders()
  // 有 running 才轮询摘要列表；通讯录切 tab 时再拉 identities
  poll = setInterval(() => {
    if (store.summaries.some(r => r.status === 'running')) void store.loadRooms()
  }, 3000)
})
onUnmounted(() => {
  if (poll) clearInterval(poll)
  poll = null
})
watch(() => store.homeTab, tab => {
  if (tab === 'contacts') void store.loadIdentities()
})
</script>

<template>
  <main class="page">
    <!-- QQ 顶栏 -->
    <header class="top">
      <div class="top-main">
        <h1>{{ store.homeTab === 'messages' ? '消息' : store.homeTab === 'contacts' ? '通讯录' : '我的' }}</h1>
        <p v-if="store.homeTab === 'messages'">
          {{ store.summaries.length }} 个群 · 与协同/主会话完全隔离
        </p>
        <p v-else-if="store.homeTab === 'contacts'">{{ store.contacts.length }} 位 AI 成员</p>
        <p v-else>独立群聊空间</p>
      </div>
      <button class="icon-btn" aria-label="AI 对话" @click="openAiChat">
        <CoomiIcon name="chat" :size="18" />
      </button>
      <button class="icon-btn primary" aria-label="新建群聊" @click="openCreate">
        <CoomiIcon name="plus" :size="18" />
      </button>
    </header>

    <!-- 项目选择条：点击打开项目列表 -->
    <button v-if="store.activeProject" class="proj-bar proj-btn" type="button" @click="openProjectList">
      <CoomiIcon name="folder" :size="14" />
      <span class="proj-name">{{ store.activeProject.name }}</span>
      <span v-if="store.projects.length > 1" class="proj-count">{{ store.projects.length }} 个项目</span>
      <span v-else class="proj-count">{{ store.summaries.length }} 群</span>
      <CoomiIcon name="chevronRight" :size="14" />
    </button>

    <!-- 搜索（消息 tab） -->
    <div v-if="store.homeTab !== 'me'" class="search">
      <CoomiIcon name="search" :size="15" />
      <input v-model="store.query" :placeholder="store.homeTab === 'messages' ? '搜索群聊' : '搜索成员'" />
      <button v-if="store.query" class="clr" @click="store.query = ''">
        <CoomiIcon name="close" :size="12" />
      </button>
    </div>

    <section class="body">
      <!-- ── 消息 ── -->
      <template v-if="store.homeTab === 'messages'">
        <!-- 列表骨架代替「加载中…」：行高与 .row 一致，数据到达时整列不跳位 -->
        <UiSkeleton v-if="store.loading && !store.summaries.length" variant="list" :rows="6" />
        <p v-else-if="store.error" class="empty-sm err">{{ store.error }}</p>

        <!-- 空态统一走 <UiEmpty>：结构 = 插画 + 标题 + 一句说明 + 一个动作。
             插画走 #art 槽（本地已有的圆点插画），其余四级结构与全 app 一致。 -->
        <UiEmpty
          v-else-if="!store.filteredSummaries.length"
          :title="store.query ? '没有匹配的群' : '还没有群聊'"
          :desc="store.query ? '换个关键词试试' : '创建一个群，邀请 AI 成员轮流 / 抢麦讨论。会话与协同工作台互不共享。'"
        >
          <template #art>
            <div class="orb-wrap">
              <span class="orb a" /><span class="orb b" /><span class="orb c" />
              <CoomiIcon name="chat" :size="30" />
            </div>
          </template>
          <button v-if="!store.query" class="btn primary" @click="openCreate">创建群聊</button>
        </UiEmpty>

        <template v-else>
          <button class="ai-entry enter-item" @click="openAiChat">
            <span class="av ai"><CoomiIcon name="sparkle" :size="18" /></span>
            <span class="meta">
              <span class="line1"><strong>AI 对话</strong><time>单聊</time></span>
              <span class="line2">主聊天会话 · 不与群聊共享</span>
            </span>
            <CoomiIcon name="chevronRight" :size="16" class="chev" />
          </button>

          <div
            v-for="c in store.conversations"
            :key="c.id"
            class="row enter-item"
            role="button"
            tabindex="0"
            @click="openRoom(c.id)"
            @keydown.enter="openRoom(c.id)"
          >
            <span class="av" :style="{ background: c.color }">{{ c.title.slice(0, 1) }}</span>
            <span class="meta">
              <span class="line1">
                <strong>{{ c.title }}</strong>
                <em class="mode" :class="c.speakMode">{{ modeLabel(c.speakMode) }}</em>
                <time>{{ fmtTime(c.updatedAtMs) }}</time>
              </span>
              <span class="line2">
                <span class="preview">{{ c.preview }}</span>
                <span v-if="c.running" class="run-dot" />
              </span>
            </span>
            <span v-if="c.badge" class="badge">{{ c.badge > 99 ? '99+' : c.badge }}</span>
            <button class="row-more" aria-label="删除" @click.stop="askDelete({ id: c.id, name: c.title })">
              <CoomiIcon name="more" :size="16" />
            </button>
          </div>
        </template>
      </template>

      <!-- ── 通讯录（来自项目 identities；仅首页层级，群聊页内无入口） ── -->
      <template v-else-if="store.homeTab === 'contacts'">
        <p v-if="!store.contacts.length" class="empty-sm">还没有成员，先创建群聊吧</p>
        <div
          v-for="m in store.contacts"
          :key="m.id"
          class="row contact enter-item"
          role="button"
          tabindex="0"
          @click="openDm(m.id)"
          @keydown.enter="openDm(m.id)"
        >
          <span class="av sm" :style="{ background: m.color }">{{ m.name.slice(0, 1) }}</span>
          <span class="meta">
            <span class="line1">
              <strong>{{ m.name }}</strong>
              <span v-if="m.dmUnread" class="badge">{{ m.dmUnread > 99 ? '99+' : m.dmUnread }}</span>
            </span>
            <span class="line2">{{ m.rooms.length ? `在 ${m.rooms.join('、')}` : (m.persona || '单聊联系人') }}</span>
          </span>
          <span class="tag">{{ m.modelSelector ? m.modelSelector.split(':').pop() : '默认' }}</span>
          <button class="row-more" aria-label="删除角色" @click.stop="askDeleteIdentity({ id: m.id, name: m.name })">
            <CoomiIcon name="more" :size="16" />
          </button>
        </div>
      </template>

      <!-- ── 我的 ── -->
      <template v-else>
        <div class="me-card enter-flat">
          <span class="av me"><CoomiIcon name="user" :size="22" /></span>
          <div>
            <strong>CoomiPlus</strong>
            <p>基于 MA协同引擎构建 · 会话不与协同共享</p>
          </div>
        </div>
        <div class="stats">
          <div class="stat"><b>{{ store.summaries.length }}</b><span>群聊</span></div>
          <div class="stat"><b>{{ store.contacts.length }}</b><span>成员</span></div>
          <div class="stat"><b>{{ runningCount }}</b><span>讨论中</span></div>
        </div>
        <div class="menu">
          <button class="menu-item" @click="openCreate">
            <CoomiIcon name="plusCircle" :size="17" />
            <span>新建群聊</span>
            <CoomiIcon name="chevronRight" :size="15" class="chev" />
          </button>
          <button class="menu-item" @click="openAiChat">
            <CoomiIcon name="chat" :size="17" />
            <span>打开 AI 对话</span>
            <CoomiIcon name="chevronRight" :size="15" class="chev" />
          </button>
          <button class="menu-item" @click="openCollab">
            <CoomiIcon name="team" :size="17" />
            <span>协同工作台（独立）</span>
            <CoomiIcon name="chevronRight" :size="15" class="chev" />
          </button>
          <button class="menu-item" @click="router.push('/files')">
            <CoomiIcon name="folder" :size="17" />
            <span>文件</span>
            <CoomiIcon name="chevronRight" :size="15" class="chev" />
          </button>
          <button class="menu-item" @click="openSettings">
            <CoomiIcon name="settings" :size="17" />
            <span>设置</span>
            <CoomiIcon name="chevronRight" :size="15" class="chev" />
          </button>
        </div>
        <p class="note">群聊房与主聊天会话、协同任务数据物理隔离，互不串音。</p>
      </template>
    </section>

    <!-- 底栏 QQ Tab -->
    <nav class="tabs">
      <button :class="{ on: store.homeTab === 'messages' }" @click="store.homeTab = 'messages'">
        <CoomiIcon name="chat" :size="20" />
        <span>消息</span>
        <i v-if="runningCount" class="dot" />
      </button>
      <button :class="{ on: store.homeTab === 'contacts' }" @click="store.homeTab = 'contacts'">
        <CoomiIcon name="people" :size="20" />
        <span>通讯录</span>
      </button>
      <button :class="{ on: store.homeTab === 'me' }" @click="store.homeTab = 'me'">
        <CoomiIcon name="user" :size="20" />
        <span>我的</span>
      </button>
    </nav>

    <!-- 新建群聊 sheet -->
    <div v-if="createOpen" class="mask enter-flat" @click.self="createOpen = false">
      <div class="sheet" @click.stop>
        <div class="grip" />
        <h2>新建群聊</h2>
        <label class="fld"><span>群名称</span>
          <input v-model="form.name" placeholder="例如：产品评审组" maxlength="24" />
        </label>
        <label class="fld"><span>话题（可选）</span>
          <input v-model="form.topic" placeholder="讨论焦点，成员会围绕它发言" maxlength="80" />
        </label>
        <label class="fld"><span>发言模式</span>
          <UiSelect v-model="form.speakMode" :options="modeOptions" block />
        </label>
        <div class="members-head">
          <span>成员（{{ form.members.length }}）</span>
          <button type="button" @click="addMember">+ 添加</button>
        </div>
        <div v-for="(m, i) in form.members" :key="m.id" class="member">
          <input v-model="m.name" class="mname" maxlength="12" />
          <UiSelect v-model="m.icon" :options="iconOptions" size="sm" class="micon" />
          <UiSelect v-model="m.modelSelector" :options="modelOptions" size="sm" class="msel" placeholder="默认模型" />
          <input v-model.number="m.quota" class="mq" type="number" min="0" max="99" title="发言上限 0=不限" />
          <button v-if="form.members.length > 1" class="del" @click="removeMember(i)">×</button>
          <input v-model="m.persona" class="mpersona" placeholder="人设（可选）" maxlength="200" />
          <input v-model="m.speakingStyle" class="mpersona" placeholder="说话风格（可选）" maxlength="80" />
          <input v-model="m.values" class="mpersona" placeholder="价值观（可选）" maxlength="120" />
        </div>
        <p class="hint">配额 0 = 不限次；轮流模式每次只让下一位发言。会话仅存本机群聊目录。</p>
        <div class="actions">
          <button class="btn ghost" @click="createOpen = false">取消</button>
          <button class="btn primary" :disabled="createBusy || !form.name.trim()" @click="submitCreate">
            {{ createBusy ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 删除确认 -->
    <div v-if="pendingDelete" class="mask center enter-flat" @click.self="pendingDelete = null">
      <div class="confirm" @click.stop>
        <h3>删除「{{ pendingDelete.name }}」？</h3>
        <p>聊天记录将一并删除，且无法恢复。</p>
        <div class="actions">
          <button class="btn ghost" @click="pendingDelete = null">取消</button>
          <button class="btn danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <!-- 新建项目 -->
    <div v-if="projectOpen" class="mask center enter-flat" @click.self="projectOpen = false">
      <div class="confirm" @click.stop>
        <h3>创建项目</h3>
        <p>项目是一组群聊 / 通讯录 / 单聊的隔离空间。</p>
        <input v-model="projectForm.name" class="proj-input" placeholder="项目名，例如：我的工作台" maxlength="24" />
        <input v-model="projectForm.description" class="proj-input" placeholder="描述（可选）" maxlength="80" />
        <div class="actions">
          <button class="btn ghost" @click="projectOpen = false">取消</button>
          <button class="btn primary" :disabled="projectBusy || !projectForm.name.trim()" @click="submitProject">
            {{ projectBusy ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <!-- 项目列表 -->
    <div v-if="projListOpen" class="mask center enter-flat" @click.self="projListOpen = false">
      <div class="confirm proj-list" @click.stop>
        <h3>项目列表</h3>
        <p>选择要进入的项目，或创建新项目。</p>
        <div class="proj-rows">
          <div
            v-for="p in store.projects"
            :key="p.id"
            class="proj-row"
            :class="{ on: p.id === store.activeProject?.id }"
            role="button"
            tabindex="0"
            @click="pickProject(p.id)"
            @keydown.enter="pickProject(p.id)"
          >
            <CoomiIcon name="folder" :size="16" />
            <span class="meta">
              <strong>{{ p.name }}</strong>
              <small>{{ p.roomCount ?? 0 }} 群 · {{ p.identityCount ?? 0 }} 成员</small>
            </span>
            <span v-if="p.id === store.activeProject?.id" class="tag">当前</span>
            <button
              v-else
              class="del"
              type="button"
              @click.stop="removeProject(p.id, p.name)"
            >删除</button>
          </div>
        </div>
        <div class="actions">
          <button class="btn ghost" @click="projListOpen = false">关闭</button>
          <button class="btn primary" @click="startCreateProject">新建项目</button>
        </div>
      </div>
    </div>

    <!-- 删除角色确认 -->
    <div v-if="pendingDeleteIdentity" class="mask center enter-flat" @click.self="pendingDeleteIdentity = null">
      <div class="confirm" @click.stop>
        <h3>删除角色「{{ pendingDeleteIdentity.name }}」？</h3>
        <p>将从本项目所有群聊中移除，并删除记忆与单聊，不可恢复。</p>
        <div class="actions">
          <button class="btn ghost" @click="pendingDeleteIdentity = null">取消</button>
          <button class="btn danger" @click="confirmDeleteIdentity">删除</button>
        </div>
      </div>
    </div>

    <!-- 无项目：全屏创建引导 -->
    <div v-if="setupOpen" class="setup-mask enter-flat">
      <div class="setup-card">
        <div class="orb-wrap">
          <span class="orb a" /><span class="orb b" /><span class="orb c" />
          <CoomiIcon name="folder" :size="30" />
        </div>
        <h2>先创建一个项目</h2>
        <p>项目是一组群聊 / 通讯录 / 单聊的隔离空间。</p>
        <input v-model="projectForm.name" class="proj-input" placeholder="项目名，例如：我的工作台" maxlength="24" />
        <input v-model="projectForm.description" class="proj-input" placeholder="描述（可选）" maxlength="80" />
        <button
          class="btn primary setup-go"
          :disabled="projectBusy || !projectForm.name.trim()"
          @click="submitProject"
        >
          {{ projectBusy ? '创建中…' : '创建项目' }}
        </button>
      </div>
    </div>

    <!-- 新消息 toast（右上角滑入） -->
    <div class="toast-wrap">
      <div
        v-for="t in store.toasts"
        :key="t.key"
        class="toast"
        role="button"
        tabindex="0"
        @click="openRoom(t.roomId); store.openToast(t)"
        @keydown.enter="openRoom(t.roomId); store.openToast(t)"
      >
        <strong>{{ t.title }}</strong>
        <p>{{ t.text }}</p>
      </div>
    </div>
  </main>
</template>

<style scoped>
.page {
  display: flex; flex-direction: column; height: 100%;
  background: var(--page); position: relative; overflow: hidden;
}

.top {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  padding-top: calc(var(--sp-3) + env(safe-area-inset-top, 0px));
  background: var(--bg);
  border-bottom: 1px solid var(--border);
}
.top-main { flex: 1; min-width: 0; }
.top-main h1 { margin: 0; font-size: var(--fs-heading); font-weight: 700; color: var(--text); }
.top-main p { margin: 1px 0 0; font-size: var(--fs-caption); color: var(--text-3); }
.icon-btn {
  width: var(--sp-9); height: var(--sp-9); display: grid; place-items: center;
  border: 0; border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
}
.icon-btn.primary { background: var(--blue); color: #fff; }

.proj-bar {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-2) 14px 0; padding: 0 10px; min-height: 34px; border-radius: var(--r-md);
  background: var(--blue-soft); color: var(--blue); font-size: var(--fs-label);
}
.proj-btn {
  border: 0; width: calc(100% - 28px); cursor: pointer;
  text-align: left;
}
.proj-btn .proj-name {
  flex: 1; min-width: 0; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.proj-count { margin-left: auto; font-size: var(--fs-caption); opacity: 0.75; flex-shrink: 0; }

.proj-list { max-width: 360px; width: min(92vw, 360px); }
.proj-rows {
  display: flex; flex-direction: column; gap: 6px;
  max-height: 280px; overflow-y: auto; margin: 10px 0 var(--sp-1);
}
.proj-row {
  display: flex; align-items: center; gap: 10px;
  padding: 10px var(--sp-3); border-radius: var(--r-md);
  background: var(--fill); color: var(--text);
  cursor: pointer; border: 1px solid transparent;
}
.proj-row.on { border-color: var(--blue); background: var(--blue-soft); }
.proj-row .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.proj-row .meta strong {
  font-size: var(--fs-sub); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.proj-row .meta small { font-size: var(--fs-caption); color: var(--text-3); }
.proj-row .tag {
  font-size: var(--fs-caption); color: var(--blue); font-weight: 600; flex-shrink: 0;
}
.proj-row .del {
  border: 0; background: transparent; color: var(--danger);
  font-size: var(--fs-label); font-weight: 600; padding: var(--sp-1) 6px; flex-shrink: 0;
}

.search {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: 10px 14px var(--sp-1); padding: 0 var(--sp-3);
  height: 38px; border-radius: var(--r-md);
  background: var(--fill); color: var(--text-3);
}
.search input {
  flex: 1; border: 0; background: transparent; outline: none;
  color: var(--text); font-size: var(--fs-sub); min-width: 0;
}
.search .clr {
  border: 0; background: transparent; color: var(--text-3);
  width: 24px; height: 24px; display: grid; place-items: center; border-radius: var(--r-sm);
}

.body { flex: 1; overflow: auto; padding: var(--sp-2) 0 calc(72px + var(--safe-bottom)); }
/* 空态骨架与排版都交给 <UiEmpty>，这里只留本页特有的插画。 */
.orb-wrap { position: relative; width: 80px; height: 80px; display: grid; place-items: center; color: var(--blue); }
.orb { position: absolute; border-radius: 50%; background: var(--blue-soft); animation: float var(--dur-loop-sweep) var(--ease-in-out) infinite; }
.orb.a { width: 56px; height: 56px; top: 10px; left: 10px; }
.orb.b { width: 32px; height: 32px; top: 0; right: 4px; opacity: 0.5; animation-delay: var(--orb-phase-1); }
.orb.c { width: 18px; height: 18px; bottom: 6px; left: 0; opacity: 0.4; animation-delay: var(--orb-phase-2); }
/* float（空态插画漂浮）：全仓唯一保留处，其余两处（CollabView/GroupHomeView）已删。
   保留依据 = 任务约定「float 只留空态插画那一处」；此处即首页空态插画。 */
@keyframes float { 0%,100% { transform: translateY(0); } 50% { transform: translateY(-6px); } }
.ai-entry, .row {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; padding: var(--sp-3) var(--sp-4);
  border: 0; background: var(--bg); text-align: left; color: var(--text);
  border-bottom: 1px solid var(--border);
  position: relative; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
/* 入场不再在这里写 animation：模板给行加了 .enter-item，
   时长/位移/错峰全部由 global.css 的「列表项」档统一提供。
   为什么从横向滑入改成竖向 4px：列表是竖着排的，横向滑入表达的是「从侧边来」，
   和「从上往下排出来」的实际关系对不上；竖向上移 4px 才是「列表在铺开」。 */
.ai-entry:active, .row:active { background: var(--fill); transform: scale(var(--press-scale)); }
.av {
  width: 44px; height: 44px; border-radius: var(--r-md);
  display: grid; place-items: center;
  font-size: var(--fs-heading); font-weight: 700; color: #fff; flex-shrink: 0;
  box-shadow: 0 2px 6px rgba(0,0,0,.1);
  transition: transform var(--dur-fast) var(--ease-out);
}
.av:active { transform: scale(var(--press-scale)); }
.av.sm { width: 40px; height: 40px; border-radius: var(--r-md); font-size: var(--fs-body-lg); }
.av.ai { background: linear-gradient(135deg, #2d61c6, #6b8ef0); }
.av.me { background: var(--blue-soft); color: var(--blue); width: 48px; height: 48px; border-radius: var(--r-md); }
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: var(--sp-1); }
.line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.line1 strong { font-size: var(--fs-body-lg); font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.line1 time { margin-left: auto; font-size: var(--fs-caption); color: var(--text-3); flex-shrink: 0; }
.mode {
  padding: 1px 6px; border-radius: var(--r-sm); font-size: var(--fs-caption); font-weight: 600;
  background: var(--blue-soft); color: var(--blue); flex-shrink: 0; font-style: normal;
}
.mode.open { background: var(--orange-soft, var(--fill)); color: var(--orange); }
/* 原来写的是 var(--purple-soft) / var(--purple)：这套主题里根本没有这两个令牌，
   于是整条声明作废、标签只剩继承色，和上面的「开放」橙底撞在一起分不出角色。
   「本人」没有专属色相，用中性灰表达「既不是 AI 也不是开放」，三态才分得开。 */
.mode.host { background: var(--fill-strong); color: var(--text-2); }
.line2 { display: flex; align-items: center; gap: 6px; min-width: 0; font-size: var(--fs-label); color: var(--text-3); }
.preview { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.run-dot {
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--blue); box-shadow: 0 0 0 3px var(--blue-soft); flex-shrink: 0;
  --pulse-min: 0.4; /* 本页原 pulse 谷值 0.4，经变量保留 */
  animation: pulse var(--dur-loop) var(--ease-in-out) infinite;
}
/* pulse 已收敛到 global.css（进行中指示点），谷值经 --pulse-min 保留。 */
.row-more {
  width: 28px; height: 28px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--text-3); display: grid; place-items: center;
  flex-shrink: 0;
}
.chev { margin-left: auto; color: var(--text-3); flex-shrink: 0; }
.tag {
  padding: 2px var(--sp-2); border-radius: var(--r-pill); background: var(--fill);
  color: var(--text-3); font-size: var(--fs-caption); flex-shrink: 0;
}
.badge {
  min-width: 18px; min-height: 18px; padding: 0 5px; border-radius: var(--r-pill);
  background: var(--danger); color: #fff; font-size: var(--fs-caption); font-weight: 700;
  display: inline-grid; place-items: center; flex-shrink: 0; font-style: normal;
}

/* 新消息 toast：右上角滑入 */
.toast-wrap {
  position: absolute; top: calc(56px + env(safe-area-inset-top, 0px)); right: 12px; left: 12px;
  z-index: var(--z-modal); display: flex; flex-direction: column; gap: var(--sp-2);
  pointer-events: none;
}
.toast {
  pointer-events: auto;
  margin-left: auto; max-width: min(80vw, 300px);
  padding: 10px 14px; border-radius: var(--r-md);
  background: var(--bg); border: 1px solid var(--border);
  box-shadow: 0 6px 20px rgba(0,0,0,.14);
  cursor: pointer;
  --toast-shift: 24px; /* 本页原 toastIn 位移 24px，经变量保留（global.css 默认 20px） */
  animation: toastIn var(--enter-pop-dur) var(--ease-out) backwards;
}
.toast strong { display: block; font-size: var(--fs-label); color: var(--text); margin-bottom: 2px; }
.toast p {
  margin: 0; font-size: var(--fs-caption); color: var(--text-3);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* toastIn 已收敛到 global.css，位移经 --toast-shift: 24px 保留。 */

.proj-input {
  width: 100%; min-height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--fill);
  color: var(--text); font-size: var(--fs-body); outline: none; margin-bottom: 10px;
}
.confirm .proj-input:last-of-type { margin-bottom: 14px; }

.me-card {
  display: flex; align-items: center; gap: 14px;
  margin: var(--sp-4) 14px var(--sp-3); padding: var(--sp-4);
  border-radius: var(--r-card); background: var(--bg); border: 1px solid var(--border);
  box-shadow: 0 2px 8px rgba(0,0,0,.04);
}
.me-card strong { font-size: var(--fs-heading); color: var(--text); display: block; }
.me-card p { margin: var(--sp-1) 0 0; font-size: var(--fs-label); color: var(--text-3); }
.stats {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: var(--sp-2);
  margin: 0 14px var(--sp-4);
}
.stat {
  padding: var(--sp-3) var(--sp-2); border-radius: var(--r-md); background: var(--bg);
  border: 1px solid var(--border); text-align: center;
}
.stat b { display: block; font-size: var(--fs-heading); color: var(--blue); }
.stat span { font-size: var(--fs-caption); color: var(--text-3); }
.menu { margin: 0 14px; border-radius: var(--r-card); overflow: hidden; border: 1px solid var(--border); background: var(--bg); }
.menu-item {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; padding: 14px 14px;
  border: 0; border-bottom: 1px solid var(--border);
  background: transparent; color: var(--text); font-size: var(--fs-body); text-align: left;
}
.menu-item:last-child { border-bottom: 0; }
.menu-item:active { background: var(--fill); }
.menu-item .chev { margin-left: auto; }
.note {
  margin: 14px var(--sp-5); font-size: var(--fs-caption); color: var(--text-3);
  text-align: center; line-height: 1.5;
}

.tabs {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: var(--z-header);
  display: grid; grid-template-columns: repeat(3, 1fr);
  padding: 6px var(--sp-2) calc(6px + var(--safe-bottom));
  background: var(--bg); border-top: 1px solid var(--border);
}
.tabs button {
  position: relative;
  display: flex; flex-direction: column; align-items: center; gap: 2px;
  border: 0; background: transparent; color: var(--text-3);
  font-size: var(--fs-caption); padding: var(--sp-1) 0 2px; border-radius: var(--r-md);
}
.tabs button.on { color: var(--blue); font-weight: 600; }
.tabs .dot {
  position: absolute; top: 2px; right: calc(50% - 18px);
  width: 8px; height: 8px; border-radius: 50%;
  background: var(--danger); border: 1.5px solid var(--bg);
}

.mask {
  position: absolute; inset: 0; z-index: var(--z-toast);
  background: rgba(10,15,24,.45);
  display: flex; align-items: flex-end; justify-content: center;
}
.mask.center { align-items: center; }
.sheet {
  width: 100%; max-height: 88vh; overflow: auto;
  background: var(--bg); border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  padding: var(--sp-3) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-top: 1px solid var(--border);
  /* 底部弹层入场：rise（100% 上滑，已收敛 global.css），遮罩淡入由 .enter-flat 类负责 */
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grip { width: 36px; height: 4px; border-radius: 2px; background: var(--fill-strong); margin: 0 auto var(--sp-3); }
.sheet h2 { margin: 0 0 var(--sp-3); font-size: var(--fs-strong); font-weight: 700; color: var(--text); }
.fld { display: flex; flex-direction: column; gap: 5px; margin-bottom: 10px; font-size: var(--fs-label); color: var(--text-2); }
.fld input, .fld select, .member input, .member select {min-height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-md);
  border: 1px solid var(--border); background: var(--fill);
  color: var(--text); font-size: var(--fs-body); outline: none; width: 100%;
}
.members-head {
  display: flex; justify-content: space-between; align-items: center;
  margin: 14px 0 var(--sp-2); font-size: var(--sp-3); font-weight: 600; color: var(--text-2);
}
.members-head button {min-height: 30px; padding: 0 var(--sp-3); border-radius: var(--r-sm);
  border: 1px dashed var(--blue); background: var(--blue-soft); color: var(--blue); font-size: var(--fs-label); font-weight: 600;
}
.member {
  display: grid; grid-template-columns: 1fr 70px 1.4fr 52px 28px; gap: 6px; align-items: center;
  margin-bottom: var(--sp-2);
}
.member .mq { text-align: center; padding: 0 var(--sp-1); }
.member .micon { width: 70px; font-size: var(--fs-caption); }
.member .mpersona {
  grid-column: 1 / -1; min-height: 30px; font-size: var(--fs-caption);
  border: 1px solid var(--border); border-radius: var(--r-sm);
  background: var(--fill); color: var(--text); padding: 0 var(--sp-2);
}
.member .del {
  width: 28px; height: 28px; border-radius: var(--r-sm); border: 0;
  background: var(--fill); color: var(--danger); font-size: var(--fs-strong);
}
.hint { font-size: var(--fs-caption); color: var(--text-3); margin: var(--sp-1) 0 var(--sp-3); line-height: 1.4; }
.confirm {
  width: min(88vw, 300px); padding: 18px var(--sp-4) 14px;
  background: var(--bg); border-radius: var(--r-card); text-align: center;
  /* 居中确认弹层入场：modalIn（已收敛 global.css，语义 = enter-pop） */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.confirm h3 { margin: 0 0 6px; font-size: var(--fs-body-lg); color: var(--text); }
.confirm p { margin: 0 0 14px; font-size: var(--fs-label); color: var(--text-3); }
.actions { display: flex; gap: var(--sp-2); }
.btn {
  flex: 1; min-height: 44px; border-radius: var(--r-md); border: 0;
  font-size: var(--fs-body); font-weight: 600;
}
.btn.primary { background: var(--blue); color: #fff; }
.btn.primary:disabled { opacity: 0.45; }
.btn.ghost { background: var(--fill); color: var(--text-2); }
.btn.danger { background: var(--danger); color: #fff; }

/* 无项目全屏引导 */
.setup-mask {
  position: absolute; inset: 0; z-index: 80;
  background: var(--page);
  display: flex; align-items: center; justify-content: center;
  padding: var(--sp-6);
}
.setup-card {
  width: min(100%, 320px);
  display: flex; flex-direction: column; align-items: center;
  text-align: center;
}
.setup-card h2 { margin: 0 0 6px; font-size: var(--fs-heading); color: var(--text); }
.setup-card p { margin: 0 0 18px; font-size: var(--fs-sub); color: var(--text-3); line-height: 1.5; }
.setup-card .proj-input { text-align: left; }
.setup-go { width: 100%; margin-top: var(--sp-1); }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet, .confirm { animation: none; }
}
:root[data-motion='off'] .sheet, :root[data-motion='off'] .confirm { animation: none; }
</style>
