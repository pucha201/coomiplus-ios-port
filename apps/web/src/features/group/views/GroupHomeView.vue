<script setup lang="ts">
/** 群聊首页：消息 / 通讯录 / 我的。 */
import { computed, onMounted, onUnmounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiButton from '@/components/ui/UiButton.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import { useGroupStore } from '../store'
import { useConfigStore } from '@/stores/config'
import ProjectBar from '../components/ProjectBar.vue'
import ProjectList from '../components/ProjectList.vue'
import CreateGroup from '../components/CreateGroup.vue'
import ContactList from '../components/ContactList.vue'
import { useToast } from '../composables/useToast'

const router = useRouter()
const store = useGroupStore()
const config = useConfigStore()
const { toasts } = useToast()

const setupOpen = ref(false)
const projListOpen = ref(false)
const createOpen = ref(false)
const projectOpen = ref(false)
const projectName = ref('')
const projectBusy = ref(false)
const pendingDeleteIdentity = ref<{ id: string; name: string } | null>(null)
const models = computed(() =>
  config.providers.flatMap(p =>
    (p.models.length ? p.models : [p.model]).filter(Boolean)
      .map(m => ({ value: `${p.id}:${m}`, label: `${p.name} · ${m}` })),
  ),
)

let poll: ReturnType<typeof setInterval> | null = null

onMounted(async () => {
  store.error = ''
  if (config.providers.length === 0) void config.fetchProviders()
  await store.loadProjects()
  // 拉不到项目列表 ≠ 一个项目都没有。连接失败时再弹「先创建一个项目」的全屏引导，
  // 用户照着建完还是失败，而真正要看到的是那条「连不上电脑」的错误。
  if (!store.error) {
    if (!store.activeProject) {
      setupOpen.value = true
    } else {
      void store.loadRooms()
      void store.loadIdentities()
    }
  }
  poll = setInterval(() => {
    if (store.summaries.some(r => r.status === 'running')) void store.loadRooms()
  }, 3000)
})

onUnmounted(() => {
  if (poll) clearInterval(poll)
})

function openRoom(id: string) {
  store.markRoomSeen(id)
  router.push(`/im/${id}`)
}

function openDm(id: string) {
  router.push(`/im/dm/${id}`)
}

function openAiChat() {
  router.push('/')
}

function openCreate() {
  if (!store.activeProject) {
    projectOpen.value = true
    return
  }
  createOpen.value = true
}

async function submitProject() {
  if (!projectName.value.trim()) return
  projectBusy.value = true
  try {
    const p = await store.createProject(projectName.value.trim())
    if (p) {
      projectOpen.value = false
      projectName.value = ''
      // 创建项目成功后必须重载房间列表（清空上一个项目的群聊），否则旧群会串到新项目。
      setupOpen.value = false
      void store.loadRooms()
      void store.loadIdentities()
    }
  } finally {
    projectBusy.value = false
  }
}

async function submitCreate(name: string, topic: string, mode: any, members: any[]) {
  const data = await store.createRoom(name, topic, mode, members, {
    projectId: store.activeProject?.id,
  })
  if (data?.room) {
    createOpen.value = false
    openRoom(data.room.id)
  }
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
  await store.deleteProject(pid)
  void store.loadProjects()
}

async function confirmDeleteIdentity() {
  const target = pendingDeleteIdentity.value
  const pid = store.activeProject?.id
  if (!target || !pid) return
  if (!confirm(`删除角色「${target.name}」？将从本项目所有群聊中移除，并删除记忆与单聊，不可恢复。`)) return
  const ok = await store.deleteIdentity(pid, target.id)
  if (ok) {
    pendingDeleteIdentity.value = null
    void store.loadRooms()
  } else {
    alert(store.error || '删除失败')
  }
}

function fmtTime(ms: number): string {
  if (!ms) return ''
  const d = new Date(ms)
  const now = new Date()
  if (d.toDateString() === now.toDateString()) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
  return `${d.getMonth() + 1}/${d.getDate()}`
}

function runningCount() {
  return store.summaries.filter(r => r.status === 'running').length
}
</script>

<template>
  <main class="page">
    <header class="top">
      <div class="top-main">
        <h1>
          {{ store.homeTab === 'messages' ? '消息' : store.homeTab === 'contacts' ? '通讯录' : '我的' }}
        </h1>
        <!-- 列表没拉到时不报「0 个群」：那是一个不知道的数字被写成了确定的 0，
             和正文里的连接错误互相打脸。 -->
        <p v-if="store.homeTab === 'messages' && !store.error">
          <span v-if="runningCount()" class="live-dot" />
          {{ runningCount() ? `${runningCount()} 个讨论中` : `${store.summaries.length} 个群` }}
        </p>
        <p v-else-if="store.homeTab === 'contacts' && !store.error">{{ store.contacts.length }} 位 AI 成员</p>
        <p v-else-if="store.homeTab === 'me'">独立群聊空间</p>
      </div>
      <button class="icon-btn" aria-label="新建群聊" @click="openCreate">
        <CoomiIcon name="plus" :size="18" />
      </button>
    </header>

    <ProjectBar
      v-if="store.activeProject && store.homeTab !== 'me'"
      :name="store.activeProject.name"
      :room-count="store.summaries.length"
      :project-count="store.projects.length"
      @open="projListOpen = true"
    />

    <section class="body">
      <!-- 消息 -->
      <template v-if="store.homeTab === 'messages'">
        <div class="search">
          <CoomiIcon name="search" :size="15" />
          <input v-model="store.query" placeholder="搜索群聊" />
          <button v-if="store.query" class="clr" aria-label="清除" @click="store.query = ''">
            <CoomiIcon name="close" :size="12" />
          </button>
        </div>

        <UiSkeleton v-if="store.loading && !store.summaries.length" :rows="5" />
        <p v-else-if="store.error" class="empty-sm err">{{ store.error }}</p>

        <!-- 与 HomeView 同一套空态：插画 + 标题 + 一句说明 + 一个动作 -->
        <UiEmpty
          v-else-if="!store.filteredSummaries.length"
          :title="store.query ? '没有匹配的群' : '还没有群聊'"
          :desc="store.query ? '换个关键词试试' : '创建一个群，邀请 AI 成员讨论。会话与协同工作台互不共享。'"
        >
          <template #art>
            <div class="orb-wrap">
              <span class="orb a" /><span class="orb b" /><span class="orb c" />
              <CoomiIcon name="chat" :size="28" />
            </div>
          </template>
          <UiButton v-if="!store.query" variant="primary" size="lg" @click="openCreate">创建群聊</UiButton>
        </UiEmpty>

        <template v-else>
          <button class="ai-entry enter-item" @click="openAiChat">
            <span class="av">
              <CoomiIcon name="sparkle" :size="18" />
            </span>
            <span class="meta">
              <span class="line1">
                <strong>AI 对话</strong>
                <time>单聊</time>
              </span>
              <span class="line2">主聊天会话 · 不与群聊共享</span>
            </span>
            <CoomiIcon name="chevronRight" :size="16" class="chev" />
          </button>

          <div
            v-for="r in store.filteredSummaries"
            :key="r.id"
            class="room-row enter-item"
            :class="{ running: r.status === 'running' }"
            role="button"
            tabindex="0"
            @click="openRoom(r.id)"
            @keydown.enter="openRoom(r.id)"
          >
            <span class="stack">
              <i
                v-for="(c, i) in r.memberColors.slice(0, 3)"
                :key="i"
                :style="{ background: c }"
              />
              <span v-if="r.status === 'running'" class="pulse" />
            </span>
            <span class="meta">
              <span class="line1">
                <strong>{{ r.name }}</strong>
                <time>{{ fmtTime(r.updatedAtMs) }}</time>
              </span>
              <span class="line2">{{ r.preview || r.topic || '还没有消息' }}</span>
            </span>
            <span v-if="store.unreadOf(r.id, r.messageCount) > 0" class="badge">
              {{ store.unreadOf(r.id, r.messageCount) }}
            </span>
            <span v-else-if="r.muted" class="mute">
              <CoomiIcon name="moon" :size="13" />
            </span>
          </div>
        </template>
      </template>

      <!-- 通讯录 -->
      <ContactList
        v-else-if="store.homeTab === 'contacts'"
        :identities="store.contacts"
        @open="openDm"
        @remove="(id, name) => pendingDeleteIdentity = { id, name }"
      />

      <!-- 我的 -->
      <template v-else>
        <div class="me-head">
          <div class="me-avatar">
            <CoomiIcon name="user" :size="22" />
          </div>
          <div class="me-meta">
            <strong>本地空间</strong>
            <p>{{ store.activeProject?.name || '未选择项目' }}</p>
          </div>
        </div>

        <div class="me-stats">
          <div class="stat">
            <b>{{ store.summaries.length }}</b>
            <span>群聊</span>
          </div>
          <div class="stat">
            <b>{{ store.contacts.length }}</b>
            <span>成员</span>
          </div>
          <div class="stat">
            <b>{{ store.projects.length }}</b>
            <span>项目</span>
          </div>
        </div>

        <p class="sec-label">快捷操作</p>
        <div class="menu-card">
          <button class="menu-item" @click="openCreate">
            <span class="mi"><CoomiIcon name="plus" :size="15" /></span>
            <span class="ml">新建群聊</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="menu-item" @click="projListOpen = true">
            <span class="mi"><CoomiIcon name="folder" :size="15" /></span>
            <span class="ml">项目管理</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="menu-item" @click="router.push('/files')">
            <span class="mi"><CoomiIcon name="fileRead" :size="15" /></span>
            <span class="ml">文件管理</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
          <button class="menu-item" @click="router.push('/')">
            <span class="mi"><CoomiIcon name="sparkle" :size="15" /></span>
            <span class="ml">AI 对话</span>
            <CoomiIcon name="chevronRight" :size="14" class="chev" />
          </button>
        </div>

        <div class="engine-card">
          <div class="engine-icon">
            <CoomiIcon name="cpu" :size="20" />
          </div>
          <div class="engine-info">
            <strong>MA 协同引擎 1.1</strong>
            <p>多智能体协同 · 独立群聊空间 · 本地存储</p>
          </div>
        </div>
      </template>
    </section>

    <!-- Toast -->
    <div class="toast-wrap">
      <button
        v-for="t in toasts"
        :key="t.id"
        class="toast"
        @click="openRoom(t.roomId); store.openToast(t)"
      >
        <strong>{{ t.title }}</strong>
        <p>{{ t.text }}</p>
      </button>
    </div>

    <!-- 弹层 -->
    <ProjectList
      :open="projListOpen"
      :projects="store.projects"
      :active-id="store.activeProject?.id"
      @close="projListOpen = false"
      @pick="pickProject"
      @create="startCreateProject"
      @remove="removeProject"
    />

    <CreateGroup
      :open="createOpen"
      :models="models"
      @close="createOpen = false"
      @submit="submitCreate"
    />

    <div v-if="projectOpen" class="mask center enter-flat" @click.self="projectOpen = false">
      <div class="confirm">
        <h3>创建项目</h3>
        <input v-model="projectName" class="proj-input" placeholder="项目名" maxlength="24" />
        <div class="actions">
          <button class="btn ghost" @click="projectOpen = false">取消</button>
          <button class="btn primary" :disabled="projectBusy || !projectName.trim()" @click="submitProject">
            {{ projectBusy ? '创建中…' : '创建' }}
          </button>
        </div>
      </div>
    </div>

    <div v-if="pendingDeleteIdentity" class="mask center enter-flat" @click.self="pendingDeleteIdentity = null">
      <div class="confirm">
        <h3>删除角色「{{ pendingDeleteIdentity.name }}」？</h3>
        <p>将从本项目所有群聊中移除，并删除记忆与单聊，不可恢复。</p>
        <div class="actions">
          <UiButton variant="ghost" size="md" @click="pendingDeleteIdentity = null">取消</UiButton>
          <UiButton variant="danger" size="md" @click="confirmDeleteIdentity">删除</UiButton>
        </div>
      </div>
    </div>

    <div v-if="setupOpen" class="setup-mask enter-flat">
      <div class="setup-card">
        <div class="setup-orb">
          <CoomiIcon name="folder" :size="26" />
        </div>
        <h2>先创建一个项目</h2>
        <p>项目是一组群聊 / 通讯录 / 单聊的隔离空间。</p>
        <input v-model="projectName" placeholder="项目名，例如：我的工作台" maxlength="24" />
        <UiButton
          variant="primary"
          size="lg"
          block
          :disabled="projectBusy || !projectName.trim()"
          @click="submitProject"
        >
          {{ projectBusy ? '创建中…' : '创建项目' }}
        </UiButton>
      </div>
    </div>

    <nav class="tabs">
      <button :class="{ on: store.homeTab === 'messages' }" @click="store.homeTab = 'messages'">
        <span class="tab-icon">
          <CoomiIcon name="chat" :size="18" />
          <span v-if="runningCount()" class="tab-dot" />
        </span>
        <span>消息</span>
      </button>
      <button :class="{ on: store.homeTab === 'contacts' }" @click="store.homeTab = 'contacts'">
        <span class="tab-icon"><CoomiIcon name="people" :size="18" /></span>
        <span>通讯录</span>
      </button>
      <button :class="{ on: store.homeTab === 'me' }" @click="store.homeTab = 'me'">
        <span class="tab-icon"><CoomiIcon name="user" :size="18" /></span>
        <span>我的</span>
      </button>
    </nav>
  </main>
</template>

<style scoped>
.page {
  display: flex; flex-direction: column; height: 100%;
  background: var(--page); position: relative; overflow: hidden;
}

/* ── 顶栏 ── */
.top {
  display: flex; align-items: center; gap: var(--sp-2);
  padding: 10px 14px;
  padding-top: calc(10px + env(safe-area-inset-top, 0px));
  background: var(--bg); border-bottom: 1px solid var(--border);
}
.top-main { flex: 1; min-width: 0; }
.top-main h1 {
  margin: 0; font-size: var(--fs-heading); font-weight: 700; color: var(--text);
  letter-spacing: -0.01em;
}
.top-main p {
  margin: 2px 0 0; font-size: var(--fs-caption); color: var(--text-3);
  display: flex; align-items: center; gap: 5px;
}
.live-dot {
  width: 6px; height: 6px; border-radius: 50%;
  background: var(--ok); flex-shrink: 0;
  animation: livePulse var(--dur-loop) var(--ease-in-out) infinite;
}
/* livePulse 已收敛到 global.css（进行中呼吸，语义态保留；本处 0.45 即默认值）。 */
.icon-btn {
  width: 40px; height: 40px; display: grid; place-items: center; /* 对齐全局 40px 触控标准 */
  border: 0; border-radius: var(--r-md);
  background: var(--blue); color: #fff;
  cursor: pointer; transition: transform var(--dur-press) var(--ease-out), background var(--dur-fast) var(--ease-out);
}
.icon-btn:active { transform: scale(var(--press-scale)); background: var(--blue-press); }

/* ── 主体 ── */
.body { flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch; }


.search {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: 10px 14px 6px; padding: 0 var(--sp-3);
  height: 38px; border-radius: var(--r-md);
  background: var(--fill); color: var(--text-3);
}
.search input {
  flex: 1; min-width: 0; border: 0; background: transparent;
  font-size: var(--fs-sub); color: var(--text); outline: none;
}
.search .clr {
  border: 0; background: transparent; color: var(--text-3);
  cursor: pointer; display: grid; place-items: center;
}

/* ── 空态 ──
   排版已统一到 <UiEmpty> / global.css，这里只留本页插画。 */
.orb-wrap {
  position: relative; width: 76px; height: 76px;
  display: grid; place-items: center; color: var(--blue);
  margin-bottom: 14px;
}
.orb {
  position: absolute; border-radius: 50%; background: var(--blue-soft);
  /* float 已删：纯装饰漂浮，准入测试不过（只保留 HomeView 空态插画那一处），圆点留作静态插画 */
}
.orb.a { width: 54px; height: 54px; top: 10px; left: 10px; }
/* 原先这里还有 animation-delay: 0.6s / 1.1s，是给已删除的 float 循环做相位的；
   循环删掉后相位就是纯死代码，一并去掉（否则会被误读成「这里还有动画」）。 */
.orb.b { width: 30px; height: 30px; top: 0; right: 4px; opacity: 0.5; }
.orb.c { width: 16px; height: 16px; bottom: 6px; left: 0; opacity: 0.4; }
/* float 已收敛/删除：纯装饰漂浮循环（准入测试：说不出编码的状态），只留 HomeView 空态插画一处。
   标题 / 说明的字号与间距改由 <UiEmpty> 统一提供，这里只留本页插画。 */

/* ── AI 对话入口 ── */
.ai-entry {
  display: flex; align-items: center; gap: var(--sp-3);
  width: calc(100% - 28px); margin: 6px 14px var(--sp-2);
  padding: 13px 14px;
  border-radius: var(--r-card);
  border: 1px solid var(--blue-border);
  background: var(--blue-soft);
  text-align: left; color: var(--text);
  cursor: pointer;
  /* 入场改由模板上的 .enter-item 提供（列表项档 + 前 8 项自动错峰），这里不再各写一份。 */
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.ai-entry:active { transform: scale(var(--press-scale)); background: var(--blue-soft-2); /* 按压留在蓝系，与选中态语汇一致 */ }
.ai-entry .av {
  width: 44px; height: 44px; border-radius: var(--r-md);
  display: grid; place-items: center; flex-shrink: 0;
  background: linear-gradient(135deg, var(--blue), #6b8ef0);
  color: #fff;
}
.ai-entry .meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.ai-entry .line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.ai-entry .line1 strong { font-size: var(--fs-body); font-weight: 600; }
.ai-entry .line1 time {
  font-size: var(--fs-caption); color: var(--text-2); margin-left: auto; flex-shrink: 0; /* 蓝软底上 text-3 仅 4.47:1，提为 text-2 */
}
.ai-entry .line2 {
  font-size: var(--fs-label); color: var(--text-2); /* 预览级：与群聊行 line2 同级 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ai-entry .chev { flex-shrink: 0; color: var(--text-3); }

/* ── 群聊行 ── */
.room-row {
  display: flex; align-items: center; gap: var(--sp-3);
  width: calc(100% - 28px); margin: 0 14px 6px;
  padding: 13px 14px;
  border-radius: var(--r-card);
  border: 1px solid var(--border);
  background: var(--bg);
  text-align: left; color: var(--text);
  cursor: pointer;
  /* 同 .ai-entry：入场统一走 .enter-item（列表项档 + 错峰）。 */
  transition: background var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.room-row:active { background: var(--fill); transform: scale(var(--press-scale)); }
.room-row.running { border-color: var(--ok); background: color-mix(in srgb, var(--ok-soft) 55%, var(--bg)); }
.stack {
  position: relative; display: flex; flex-shrink: 0;
}
.stack i {
  width: 38px; height: 38px; border-radius: var(--r-md);
  border: 2px solid var(--bg); margin-left: -10px;
}
.stack i:first-child { margin-left: 0; }
.pulse {
  position: absolute; right: -2px; bottom: -2px;
  width: 10px; height: 10px; border-radius: 50%;
  background: var(--ok); border: 2px solid var(--bg);
  animation: livePulse var(--dur-loop) var(--ease-in-out) infinite;
}
.meta { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 3px; }
.line1 { display: flex; align-items: center; gap: 6px; min-width: 0; }
.line1 strong {
  font-size: var(--fs-body); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.line1 time { font-size: var(--fs-caption); color: var(--text-3); margin-left: auto; flex-shrink: 0; }
.line2 {
  font-size: var(--fs-label); color: var(--text-2); /* 三级墨色：标题(text)/预览(text-2)/时间(text-3) */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.badge {
  min-width: 18px; height: 18px; padding: 0 5px;
  border-radius: var(--r-pill); background: var(--danger); color: #fff;
  font-size: var(--fs-caption); display: grid; place-items: center; flex-shrink: 0;
  animation: badgePop var(--enter-pop-dur) var(--ease-spring) backwards;
}
@keyframes badgePop {
  from { transform: scale(0); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.mute { color: var(--text-3); display: grid; place-items: center; flex-shrink: 0; }

/* ── 我的 ── */
.me-head {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 18px var(--sp-4) var(--sp-3);
}
.me-avatar {
  width: 52px; height: 52px; border-radius: var(--r-card);
  display: grid; place-items: center;
  background: linear-gradient(135deg, var(--blue), #6b8ef0);
  color: #fff;
}
.me-meta strong { display: block; font-size: var(--fs-strong); font-weight: 700; }
.me-meta p { margin: 2px 0 0; font-size: var(--fs-label); color: var(--text-3); }

.me-stats {
  display: grid; grid-template-columns: repeat(3, 1fr);
  gap: var(--sp-2); padding: 0 14px var(--sp-1);
}
.stat {
  padding: var(--sp-3) var(--sp-2); border-radius: var(--r-md); background: var(--fill);
  text-align: center;
}
.stat b { display: block; font-size: var(--fs-title); font-weight: 700; color: var(--text); }
.stat span { font-size: var(--fs-caption); color: var(--text-3); }

.sec-label {
  margin: var(--sp-4) var(--sp-4) var(--sp-2);
  font-size: var(--fs-caption); font-weight: 700; color: var(--text-3);
}
.menu-card {
  margin: 0 14px; border-radius: var(--r-card); background: var(--fill);
  overflow: hidden;
}
.menu-item {
  display: flex; align-items: center; gap: 10px;
  width: 100%; padding: 13px 14px;
  border: 0; background: transparent;
  font-size: var(--fs-sub); color: var(--text); text-align: left;
  cursor: pointer; transition: background var(--dur-fast) var(--ease-out);
}
.menu-item:active { background: var(--fill-press); }
.menu-item + .menu-item { border-top: 1px solid var(--border); }
.menu-item .mi {
  width: 28px; height: 28px; border-radius: var(--r-sm);
  display: grid; place-items: center;
  background: var(--blue-soft); color: var(--blue); flex-shrink: 0;
}
.menu-item .ml { flex: 1; }
.menu-item .chev { color: var(--text-3); }

.engine-card {
  display: flex; align-items: center; gap: var(--sp-3);
  margin: var(--sp-4) 14px var(--sp-5); padding: 14px var(--sp-4);
  border-radius: var(--r-card);
  background: linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%);
  color: #fff;
  box-shadow: 0 4px 16px rgba(15, 52, 96, 0.28);
}
.engine-icon {
  width: 42px; height: 42px; border-radius: var(--r-md);
  display: grid; place-items: center; flex-shrink: 0;
  background: linear-gradient(135deg, #2d61c6, #8b5cf6);
}
.engine-info { flex: 1; min-width: 0; }
.engine-info strong { display: block; font-size: var(--fs-sub); font-weight: 700; margin-bottom: 2px; }
.engine-info p { margin: 0; font-size: var(--fs-caption); opacity: 0.7; line-height: 1.4; }

/* ── Toast ── */
.toast-wrap {
  position: fixed; top: 64px; right: 12px; z-index: var(--z-modal);
  display: flex; flex-direction: column; gap: 6px;
}
.toast {
  padding: 10px 14px; border-radius: var(--r-md);
  background: var(--bg); border: 1px solid var(--border);
  box-shadow: var(--shadow-2);
  font-size: var(--fs-label); text-align: left; cursor: pointer;
  max-width: 260px;
  animation: toastIn var(--enter-pop-dur) var(--ease-out) backwards;
}
.toast:active { transform: scale(var(--press-scale)); }
/* toastIn 已收敛到 global.css（默认 20px 与本处一致）。 */
.toast strong { display: block; font-size: var(--fs-label); font-weight: 600; margin-bottom: 2px; }
.toast p { margin: 0; font-size: var(--fs-caption); color: var(--text-3); }

/* ── 弹层 ── */
.mask { position: fixed; inset: 0; background: rgba(10, 15, 24, 0.42); z-index: var(--z-toast); }
.mask.center { display: flex; align-items: center; justify-content: center; }
.confirm {
  width: min(320px, 90vw); background: var(--bg);
  border-radius: var(--r-card); padding: 18px;
  box-shadow: var(--shadow-2);
  animation: modalIn var(--enter-pop-dur) var(--ease-out) backwards;
}
/* 减弱动态效果：确认弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .confirm { animation: none; }
}
:root[data-motion='off'] .confirm { animation: none; }
/* modalIn 已收敛到 global.css（模态入场，语义 = enter-pop）。 */
.confirm h3 { margin: 0 0 var(--sp-2); font-size: var(--fs-body-lg); font-weight: 700; }
.confirm p { margin: 0 0 var(--sp-3); font-size: var(--fs-label); color: var(--text-3); line-height: 1.5; }
.proj-input {
  width: 100%; padding: 10px 11px; border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: var(--fs-body); margin-bottom: var(--sp-3);
  box-sizing: border-box; background: var(--fill); color: var(--text);
  outline: none; transition: border-color var(--dur-fast) var(--ease-out);
}
.proj-input:focus { border-color: var(--blue); }
.actions { display: flex; gap: var(--sp-2); }
.btn {
  flex: 1; padding: 10px; border: 0; border-radius: var(--r-md);
  font-size: var(--fs-sub); cursor: pointer; transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.btn:active { transform: scale(var(--press-scale)); }
.btn.ghost { background: var(--fill); }
.btn.primary { background: var(--blue); color: #fff; }
.btn.primary:disabled { opacity: 0.5; }

.setup-mask {
  position: fixed; inset: 0; background: var(--page); z-index: 100;
  display: flex; align-items: center; justify-content: center;
}
.setup-card { text-align: center; padding: var(--sp-6); max-width: 300px; }
.setup-orb {
  width: 64px; height: 64px; margin: 0 auto var(--sp-4);
  border-radius: var(--r-sheet); display: grid; place-items: center;
  background: var(--blue-soft); color: var(--blue);
}
.setup-card h2 { margin: 0 0 var(--sp-2); font-size: var(--fs-heading); font-weight: 700; }
.setup-card p { margin: 0 0 var(--sp-4); font-size: var(--fs-sub); color: var(--text-3); line-height: 1.5; }
.setup-card input {
  display: block; width: 100%; max-width: 280px; margin: 0 auto var(--sp-3);
  padding: 11px; border: 1px solid var(--border); border-radius: var(--r-md);
  font-size: var(--fs-body); box-sizing: border-box;
  background: var(--bg); color: var(--text); outline: none;
  transition: border-color var(--dur-fast) var(--ease-out);
}
.setup-card input:focus { border-color: var(--blue); }

/* ── 底栏 ── */
.tabs {
  display: flex; border-top: 1px solid var(--border); background: var(--bg);
  padding-bottom: env(safe-area-inset-bottom, 0px);
}
.tabs button {
  flex: 1; padding: var(--sp-2) var(--sp-2) 10px; border: 0; background: transparent;
  display: flex; flex-direction: column; align-items: center; gap: 3px;
  font-size: var(--fs-caption); font-weight: 600; color: var(--text-3);
  cursor: pointer; transition: color var(--dur-fast) var(--ease-out);
}
.tabs button.on { color: var(--blue); }
.tab-icon { position: relative; display: grid; place-items: center; }
.tab-dot {
  position: absolute; top: -2px; right: -4px;
  width: 7px; height: 7px; border-radius: 50%;
  background: var(--ok); border: 1.5px solid var(--bg);
}
</style>
