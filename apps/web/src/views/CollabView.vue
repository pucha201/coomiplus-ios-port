<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import { useCollabStore } from '@/features/collab/stores/collabStore'
import { taskStatusLabel } from '@/features/collab/utils/collabFormat'
import type { CollabTask } from '@/features/collab/types/collab'

const router = useRouter()
const store = useCollabStore()
const filter = ref<'all' | 'running' | 'failed' | 'draft'>('all')
const pendingDelete = ref<string | null>(null)

const stats = computed(() => {
  const all = store.tasks
  return {
    running: all.filter(t => ['starting', 'running', 'waiting'].includes(t.status)).length, done: all.filter(t => t.status === 'completed').length, failed: all.filter(t => ['failed', 'partial', 'cancelled', 'interrupted'].includes(t.status)).length, draft: all.filter(t => ['draft', 'queued'].includes(t.status)).length, total: all.length,
  }
})

const filtered = computed(() => store.tasks.filter(task => {
  if (filter.value === 'running') return ['starting', 'running', 'waiting'].includes(task.status)
  if (filter.value === 'failed') return ['failed', 'partial', 'cancelled', 'interrupted'].includes(task.status)
  if (filter.value === 'draft') return ['draft', 'queued'].includes(task.status)
  return true
}))

const activeTasks = computed(() => filtered.value.filter(t => ['starting', 'running', 'waiting'].includes(t.status)))
const idleTasks = computed(() => filtered.value.filter(t => !['starting', 'running', 'waiting'].includes(t.status)))

onMounted(() => void store.loadTasks())
async function retry(id: string) { const t = await store.runAction(id, 'retry'); if (t) router.push(`/collab/${t.id}`) }
async function start(id: string) { const t = await store.startTask(id); if (t) router.push(`/collab/${t.id}`) }
function askRemove(id: string) { pendingDelete.value = id }
async function confirmRemove() {
  if (!pendingDelete.value) return
  await store.removeTask(pendingDelete.value)
  pendingDelete.value = null
}

function modeLabel(mode: CollabTask['mode']) {
  if (mode === 'orchestrated') return '集中调度'
  if (mode === 'coordinated') return '协调'
  return '并行'
}
function progressOf(task: CollabTask) {
  if (task.mode === 'orchestrated' && task.orchestration?.subtasks.length) {
    const st = task.orchestration.subtasks
    const done = st.filter(s => ['completed', 'failed', 'cancelled', 'timeout'].includes(s.status)).length
    return Math.round(done / st.length * 100)
  }
  const agents = Object.values(task.agents)
  if (!agents.length) return 0
  const done = agents.filter(a => a.status === 'completed').length
  return Math.round(done / agents.length * 100)
}
function agentDots(task: CollabTask) {
  return task.roles.slice(0, 5).map(r => ({
    id: r.id, name: r.name, color: r.color, status: task.agents[r.id]?.status || 'pending',
  }))
}
function relTime(iso: string) {
  const ts = Date.parse(iso)
  if (!Number.isFinite(ts)) return ''
  const s = Math.max(0, (Date.now() - ts) / 1000)
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86400) return `${Math.floor(s / 3600)} 小时前`
  return `${Math.floor(s / 86400)} 天前`
}
</script>

<template>
  <main class="page">
    <!-- 顶栏 -->
    <header class="top">
      <button class="back" aria-label="返回" @click="router.push('/')">
        <CoomiIcon name="back" :size="20" />
      </button>
      <div class="top-title">
        <h1>协同工作台</h1>
        <p v-if="stats.total">MA协同引擎 · {{ stats.total }} 任务 · {{ stats.running }} 进行中</p>
        <p v-else>基于 MA协同引擎构建 · 组建 AI 团队并执行复杂任务</p>
      </div>
      <button class="ghost-btn" @click="router.push('/home')">
        <CoomiIcon name="chat" :size="15" />
        <span>群聊首页</span>
      </button>
    </header>

    <!-- 统计条 -->
    <section class="stats" v-if="stats.total > 0">
      <button class="stat" :class="{ on: filter === 'running' }" @click="filter = filter === 'running' ? 'all' : 'running'">
        <span class="sv running">{{ stats.running }}</span>
        <span class="sl">进行中</span>
      </button>
      <button class="stat" :class="{ on: filter === 'failed' }" @click="filter = filter === 'failed' ? 'all' : 'failed'">
        <span class="sv failed">{{ stats.failed }}</span>
        <span class="sl">异常</span>
      </button>
      <button class="stat" :class="{ on: filter === 'draft' }" @click="filter = filter === 'draft' ? 'all' : 'draft'">
        <span class="sv draft">{{ stats.draft }}</span>
        <span class="sl">草稿</span>
      </button>
      <button class="stat" :class="{ on: filter === 'all' }" @click="filter = 'all'">
        <span class="sv done">{{ stats.done }}</span>
        <span class="sl">已完成</span>
      </button>
    </section>

    <div class="content">
      <UiSkeleton v-if="store.loading && !store.tasks.length" :rows="4" />

      <div v-else-if="store.error" class="error">
        <CoomiIcon name="alert" :size="18" />
        <span>{{ store.error }}</span>
        <button @click="store.loadTasks()">重试</button>
      </div>

      <!-- 空态 -->
      <!-- 空态统一走 <UiEmpty>：插画 + 标题 + 一句说明 + 动作。
           「一个动作」在这里是主按钮；「查看全部」属于筛选切换，留在插槽里并排。 -->
      <UiEmpty
        v-else-if="!filtered.length"
        :title="filter === 'all' ? '还没有协同任务' : '该筛选下没有任务'"
        :desc="filter === 'all' ? '定义目标、组建角色，让多个 AI 并行拆解并交付结果。' : '换个筛选，或创建一个新任务。'"
      >
        <template #art>
          <div class="empty-art">
            <span class="orb a" /><span class="orb b" /><span class="orb c" />
            <CoomiIcon name="team" :size="32" />
          </div>
        </template>
        <div class="empty-actions">
          <button v-if="filter !== 'all'" class="btn ghost" @click="filter = 'all'">查看全部</button>
          <button class="btn primary" @click="router.push('/collab/new')">
            <CoomiIcon name="plus" :size="16" />
            创建任务
          </button>
        </div>
      </UiEmpty>

      <!-- 进行中 -->
      <template v-else>
        <section v-if="activeTasks.length" class="group">
          <h3 class="g-label"><i class="pip live" />进行中</h3>
          <article
            v-for="task in activeTasks"
            :key="task.id"
            class="card live"
            @click="router.push(`/collab/${task.id}`)"
          >
            <header class="card-head">
              <span class="mode" :class="task.mode">{{ modeLabel(task.mode) }}</span>
              <span class="badge running">{{ taskStatusLabel[task.status] }}</span>
            </header>
            <h4 class="card-title">{{ task.title }}</h4>
            <div class="bar"><span :style="{ width: progressOf(task) + '%' }" /></div>
            <footer class="card-foot">
              <div class="avatars">
                <span
                  v-for="a in agentDots(task)"
                  :key="a.id"
                  class="av"
                  :class="a.status"
                  :style="{ background: a.color }"
                  :title="`${a.name} · ${a.status}`"
                >{{ a.name.slice(0, 1) }}</span>
                <span v-if="task.roles.length > 5" class="av more">+{{ task.roles.length - 5 }}</span>
              </div>
              <span class="meta">{{ progressOf(task) }}% · {{ relTime(task.updatedAt) }}</span>
            </footer>
          </article>
        </section>

        <!-- 历史 / 其它 -->
        <section v-if="idleTasks.length" class="group">
          <h3 class="g-label" v-if="!activeTasks.length || filter !== 'running'">
            <i class="pip" />
            {{ filter === 'all' ? '全部任务' : filter === 'failed' ? '异常任务' : '草稿' }}
          </h3>
          <article
            v-for="task in idleTasks"
            :key="task.id"
            class="card"
            :class="task.status"
            @click="router.push(`/collab/${task.id}`)"
          >
            <header class="card-head">
              <span class="mode" :class="task.mode">{{ modeLabel(task.mode) }}</span>
              <span class="badge" :class="task.status">{{ taskStatusLabel[task.status] }}</span>
            </header>
            <h4 class="card-title">{{ task.title }}</h4>
            <footer class="card-foot">
              <div class="avatars">
                <span
                  v-for="a in agentDots(task)"
                  :key="a.id"
                  class="av"
                  :class="a.status"
                  :style="{ background: a.color }"
                >{{ a.name.slice(0, 1) }}</span>
              </div>
              <div class="card-actions" @click.stop>
                <button v-if="['draft','queued'].includes(task.status)" class="act start" title="启动" @click="start(task.id)">
                  <CoomiIcon name="play" :size="14" />
                </button>
                <button v-if="['failed','partial','cancelled','interrupted'].includes(task.status)" class="act retry" title="重试" @click="retry(task.id)">
                  <CoomiIcon name="refresh" :size="14" />
                </button>
                <button class="act danger" title="删除" @click="askRemove(task.id)">
                  <CoomiIcon name="trash" :size="14" />
                </button>
              </div>
            </footer>
          </article>
        </section>
      </template>
    </div>

    <!-- FAB -->
    <button class="fab" aria-label="创建任务" @click="router.push('/collab/new')">
      <CoomiIcon name="plus" :size="22" />
    </button>

    <!-- 删除确认 -->
    <div v-if="pendingDelete" class="mask enter-flat" @click.self="pendingDelete = null">
      <div class="sheet">
        <h3>删除这个任务？</h3>
        <p>任务、对话与产物记录将被永久删除，无法恢复。</p>
        <button class="danger" @click="confirmRemove">删除</button>
        <button class="cancel" @click="pendingDelete = null">取消</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.page {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--page);
  position: relative;
  overflow: hidden;
}

/* ── top ── */
.top {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px var(--sp-3) var(--sp-2);
  padding-top: calc(10px + env(safe-area-inset-top, 0px));
  background:
    radial-gradient(ellipse 80% 120% at 100% 0%, var(--blue-soft), transparent 55%), var(--page);
}
.back {
  width: 36px; height: 36px;
  display: grid; place-items: center;
  border: 0; border-radius: var(--r-md);
  background: var(--bg);
  color: var(--text-2);
  box-shadow: var(--shadow-1, 0 1px 2px rgba(0,0,0,.06));
}
.top-title { flex: 1; min-width: 0; }
.top-title h1 {
  margin: 0;
  font-size: var(--fs-heading);
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1.2;
}
.top-title p {
  margin: 2px 0 0;
  font-size: var(--fs-caption);
  color: var(--text-3);
}
.ghost-btn {
  display: flex;
  align-items: center;
  gap: 5px; min-height: 34px;
  padding: 0 var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-pill);
  background: var(--bg);
  color: var(--text-2);
  font-size: var(--fs-label);
  font-weight: 600;
  flex-shrink: 0;
}

/* ── stats ── */
.stats {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
  padding: 6px var(--sp-4) var(--sp-4);
}
.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  padding: var(--sp-3) 6px;
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--bg-card);
  box-shadow: var(--shadow-1, 0 1px 3px rgba(0,0,0,.05));
  transition: border-color var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.stat:active { transform: scale(var(--press-scale)); }
.stat.on {
  border-color: var(--blue);
  background: var(--blue-soft);
}
.sv {
  font-size: var(--fs-heading);
  font-weight: 700;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.sv.running { color: var(--blue); }
.sv.failed { color: var(--danger); }
.sv.draft { color: var(--orange); }
.sv.done { color: var(--ok); }
.sl { font-size: var(--fs-caption); color: var(--text-3); font-weight: 500; }

/* ── content ── */
.content {
  flex: 1;
  overflow: auto;
  padding: var(--sp-1) 14px calc(88px + var(--safe-bottom));
  -webkit-overflow-scrolling: touch;
}
.loading { text-align: center; color: var(--text-3); font-size: var(--fs-sub); padding: var(--sp-8) var(--sp-3); }
.error {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--sp-2);
  padding: 28px var(--sp-3);
  color: var(--danger);
  font-size: var(--fs-sub);
}
.error button {
  border: 0; background: none;
  color: var(--blue); font-weight: 600;
}

/* ── empty ──
   外层排版交给 <UiEmpty>，这里只留本页插画与并排按钮。 */
.empty-art {
  position: relative;
  width: 88px; height: 88px;
  display: grid; place-items: center;
  margin-bottom: 18px;
  color: var(--blue);
}
.empty-art .orb {
  position: absolute;
  border-radius: 50%;
  background: var(--blue-soft);
  /* float 已删：纯装饰漂浮，准入测试不过；空态插画漂浮只保留 HomeView 一处，圆点留作静态插画 */
}
.empty-art .a { width: 64px; height: 64px; top: 8px; left: 8px; opacity: 0.9; }
/* animation-delay 原本服务于已删除的 float 循环，循环删了相位就成了死代码，一并去掉。 */
.empty-art .b { width: 36px; height: 36px; top: 0; right: 4px; opacity: 0.55; }
.empty-art .c { width: 22px; height: 22px; bottom: 8px; left: 0; opacity: 0.4; }
/* float 已删除（纯装饰漂浮，准入测试不过）；空态插画漂浮只保留 HomeView 一处。 */
.empty-actions { display: flex; gap: var(--sp-2); }
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 40px;
  padding: 0 var(--sp-4);
  border: 0;
  border-radius: var(--r-md);
  font-size: var(--fs-sub);
  font-weight: 600;
}
.btn.primary {
  background: var(--blue);
  color: #fff;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--blue) 35%, transparent);
}
.btn.primary:active { background: var(--blue-press); }
.btn.ghost {
  background: var(--bg);
  color: var(--text-2);
  border: 1px solid var(--border);
}

/* ── groups ── */
.group { margin-bottom: var(--sp-4); }
.g-label {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 0 0 var(--sp-2) 2px;
  font-size: var(--fs-label);
  font-weight: 700;
  color: var(--text-3);
  letter-spacing: 0.02em;
}
.pip {
  width: 7px; height: 7px;
  border-radius: 50%;
  background: var(--text-3);
  flex-shrink: 0;
}
.pip.live {
  background: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-soft);
  animation: pulse var(--dur-loop) var(--ease-in-out) infinite;
}
/* pulse 已收敛到 global.css（live 指示点，进行中语义；0.45 即默认谷值）。 */

/* ── cards ── */
.card {
  border: 1px solid var(--border);
  border-radius: var(--r-card);
  background: var(--bg-card);
  padding: var(--sp-4) var(--sp-4) 14px;
  margin-bottom: var(--sp-3);
  box-shadow: var(--shadow-1, 0 1px 3px rgba(0,0,0,.05));
  cursor: pointer;
  transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-base) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.card:active { background: var(--fill); transform: scale(var(--press-scale)); }
.card.live {
  border-color: color-mix(in srgb, var(--blue) 40%, var(--border));
  background:
    linear-gradient(135deg, var(--blue-soft) 0%, transparent 50%), var(--bg-card);
  box-shadow: 0 2px 8px rgba(45,97,198,.1);
}
.card.failed, .card.partial, .card.interrupted {
  border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
}
.card-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: 10px;
}
.mode {
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-caption);
  font-weight: 600;
  background: var(--fill);
  color: var(--text-2);
}
.mode.orchestrated { background: var(--orange-soft, var(--fill)); color: var(--orange); }
.mode.coordinated { background: var(--blue-soft); color: var(--blue); }
.mode.parallel { background: var(--ok-soft, var(--fill)); color: var(--ok); }
.badge {
  margin-left: auto;
  padding: 3px 10px;
  border-radius: var(--r-pill);
  font-size: var(--fs-caption);
  font-weight: 600;
  background: var(--fill);
  color: var(--text-2);
}
.badge.running, .badge.starting, .badge.waiting {
  background: var(--blue-soft);
  color: var(--blue);
}
.badge.completed { background: var(--ok-soft); color: var(--ok); }
.badge.failed, .badge.interrupted { background: var(--danger-soft); color: var(--danger); }
.badge.partial, .badge.cancelled { background: var(--orange-soft); color: var(--orange); }
.badge.draft, .badge.queued { background: var(--fill-strong); color: var(--text-2); }
.card-title {
  margin: 0 0 var(--sp-4);
  font-size: var(--fs-body-lg);
  font-weight: 600;
  color: var(--text);
  line-height: 1.5;
  letter-spacing: -0.01em;
}
.bar {
  height: 7px;
  border-radius: var(--r-pill);
  background: var(--fill-strong);
  overflow: hidden;
  margin-bottom: var(--sp-4);
}
.bar span {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: linear-gradient(90deg, var(--blue), color-mix(in srgb, var(--blue) 60%, var(--cyan, var(--blue))));
  transition: width var(--dur-slow) var(--ease-out);
}
.card-foot {
  display: flex;
  align-items: center;
  gap: 14px;
  margin-top: 10px;
}
.avatars { display: flex; align-items: center; flex: 1; min-width: 0; }
.av {
  width: 28px; height: 28px;
  border-radius: 50%;
  display: grid; place-items: center;
  font-size: var(--fs-caption);
  font-weight: 700;
  color: #fff;
  border: 2px solid var(--bg-card);
  margin-left: -6px;
  flex-shrink: 0;
}
.av:first-child { margin-left: 0; }
.av.running, .av.starting {
  box-shadow: 0 0 0 2px var(--blue);
}
.av.completed { box-shadow: 0 0 0 2px var(--ok); }
.av.failed { box-shadow: 0 0 0 2px var(--danger); }
.av.more {
  background: var(--fill-strong);
  color: var(--text-2);
  font-size: var(--fs-caption);
}
.meta {
  margin-left: auto;
  font-size: var(--fs-caption);
  color: var(--text-3);
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.card-actions { display: flex; gap: 6px; margin-left: auto; }
.act {
  width: 32px; height: 32px;
  display: grid; place-items: center;
  border: 0;
  border-radius: var(--r-md);
  background: var(--fill);
  color: var(--text-2);
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.act:active { transform: scale(var(--press-scale)); }
.act.start { color: var(--ok); }
.act.retry { color: var(--blue); }
.act.danger { color: var(--danger); }
.act:active { background: var(--fill-strong); }

/* ── fab ── */
.fab {
  position: absolute;
  right: 18px;
  bottom: calc(20px + var(--safe-bottom));
  width: 52px; height: 52px;
  border: 0;
  border-radius: var(--r-card);
  background: var(--blue);
  color: #fff;
  display: grid; place-items: center;
  box-shadow: 0 8px 24px color-mix(in srgb, var(--blue) 40%, transparent);
  z-index: var(--z-header);
}
.fab:active {
  background: var(--blue-press);
  transform: scale(var(--press-scale));
}

/* ── sheet ── */
.mask {
  position: absolute; inset: 0; z-index: var(--z-sheet);
  display: flex; align-items: flex-end; justify-content: center;
  background: rgba(10, 14, 20, 0.45);
  padding: 0;
}
.sheet {
  width: 100%;
  max-width: 420px;
  padding: 22px 18px calc(18px + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg);
  box-shadow: var(--shadow-2, 0 -8px 32px rgba(0,0,0,.18));
  /* 底部弹层入场：rise（100% 上滑，已收敛 global.css），遮罩淡入由 .enter-flat 类负责 */
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.sheet h3 { margin: 0 0 6px; font-size: var(--fs-strong); font-weight: 700; color: var(--text); }
.sheet p { margin: 0 0 18px; font-size: var(--fs-sub); color: var(--text-2); line-height: 1.5; }
.sheet .danger, .sheet .cancel {
  width: 100%; min-height: 46px;
  border: 0; border-radius: var(--r-md);
  font-size: var(--fs-body); font-weight: 600;
  margin-bottom: var(--sp-2);
}
.sheet .danger { background: var(--danger); color: #fff; }
.sheet .cancel { background: var(--fill); color: var(--text-2); margin-bottom: 0; }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
