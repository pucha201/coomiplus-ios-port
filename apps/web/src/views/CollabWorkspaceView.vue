<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import CollabAgentCard from '@/features/collab/components/CollabAgentCard.vue'
import AttachedFileChipContainer from '@/components/AttachedFileChipContainer.vue'
import { useCollabStore } from '@/features/collab/stores/collabStore'
import { useCollabDraftStore } from '@/features/collab/stores/collabDraftStore'
import { apiGet } from '@/bridge/http'
import { REASONING_EFFORTS, useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { agentStatusLabel, durationText, taskStatusLabel } from '@/features/collab/utils/collabFormat'
import { renderMarkdown } from '@/utils/markdown'
import type { CollabActivity, CollabArtifact, CollabOrchestrationPhase, CollabSubtask, CollabSubtaskStatus } from '@/features/collab/types/collab'

const route = useRoute(); const router = useRouter(); const store = useCollabStore()
const draftStore = useCollabDraftStore()
const config = useConfigStore()
const session = useSessionStore()
const taskId = computed(() => String(route.params.taskId || ''))
const task = computed(() => store.current)
/** 关联会话用量（圆环：上下文占比） */
const usage = ref<{ contextRatio: number; total: number; input: number; output: number; outputTokensPerSecond: number | null } | null>(null)
/** 三 Tab：交付 / 团队 / 产物 */
const tab = ref<'deliver'|'team'|'files'>('deliver')
const selectedAgentId = ref('')
const draft = ref(''); const target = ref('all'); const sending = ref(false)
const targetOptions = computed(() => [
  { value: 'all', label: '广播全队' },
  ...(task.value?.roles || []).map(r => ({ value: r.id, label: r.name })),
])
const scrollEl = ref<HTMLElement|null>(null)
const moreOpen = ref(false)
const cancelAsk = ref(false)
const active = computed(() => task.value && ['starting','running','waiting'].includes(task.value.status))
const completedCount = computed(() => task.value ? Object.values(task.value.agents).filter(a => a.status === 'completed').length : 0)
const selectedRole = computed(() => task.value?.roles.find(r => r.id === selectedAgentId.value))
const selectedAgent = computed(() => selectedAgentId.value ? task.value?.agents[selectedAgentId.value] : undefined)
const modeLabel = computed(() => {
  const mode = task.value?.mode
  if (mode === 'orchestrated') return '集中调度'
  if (mode === 'coordinated') return '协调模式'
  return '并行模式'
})
const isOrchestrated = computed(() => task.value?.mode === 'orchestrated')
const orchestration = computed(() => task.value?.orchestration)
const subtasks = computed(() => orchestration.value?.subtasks ?? [])
const finishedSubtasks = computed(() => subtasks.value.filter(s => ['completed','failed','cancelled','timeout'].includes(s.status)).length)
const progress = computed(() => {
  if (isOrchestrated.value && subtasks.value.length) {
    return Math.round(finishedSubtasks.value / subtasks.value.length * 100)
  }
  return task.value?.roles.length ? Math.round(completedCount.value / task.value.roles.length * 100) : 0
})
const phaseLabel: Record<CollabOrchestrationPhase, string> = { planning: '主控拆解', executing: '并行执行', merging: '主控汇总', done: '已完成' }
const phaseOrder: CollabOrchestrationPhase[] = ['planning', 'executing', 'merging', 'done']
function phaseIndex(phase: CollabOrchestrationPhase) { return phaseOrder.indexOf(phase) }
const subtaskStatusText: Record<CollabSubtaskStatus, string> = {
  pending: '待执行', starting: '启动中', running: '执行中', retrying: '重试中', completed: '完成', failed: '失败', cancelled: '已取消', timeout: '超时',
}
function roleNameById(id: string) { return task.value?.roles.find(r => r.id === id)?.name || id }
const taskStatusText = computed(() => task.value ? (task.value.status === 'running' && (task.value.retryCount ?? 0) > 0 ? '重试中' : taskStatusLabel[task.value.status]) : '')
const artifactActionLabel: Record<string,string> = { read:'读取', write:'新建', edit:'修改', patch:'补丁', download:'下载' }
const roleFilter = ref('')
const filteredRoles = computed(() => {
  if (!task.value) return []
  if (!roleFilter.value) return task.value.roles
  return task.value.roles.filter(r => r.id === roleFilter.value)
})
const expandedAct = ref('')
const expandedSt = ref('')
const preview = ref<CollabArtifact | null>(null)
const previewText = ref('')
const previewState = ref<'loading'|'text'|'binary'|'error'>('loading')
function toggleAct(id: string) { expandedAct.value = expandedAct.value === id ? '' : id }
function toggleSt(id: string) { expandedSt.value = expandedSt.value === id ? '' : id }
function actTool(act: CollabActivity) {
  try { return JSON.parse(act.content) as { name?: string; arguments?: Record<string, unknown>; status?: string; output?: string } }
  catch { return { name: act.toolName || 'tool' } }
}
function toolStatusLabel(s?: string) { return s === 'running' ? '执行中' : s === 'error' ? '失败' : '完成' }
function md(src: string) { return renderMarkdown(src || '') }
async function openPreview(a: CollabArtifact) {
  preview.value = a; previewState.value = 'loading'; previewText.value = ''
  try {
    const res = await apiGet<{ kind?: string; content?: string; size?: number; message?: string }>(`/api/collab/preview?cwd=${encodeURIComponent(task.value?.cwd || '')}&path=${encodeURIComponent(a.path)}`)
    if (res.kind === 'text') { previewText.value = res.content || ''; previewState.value = 'text' }
    else if (res.kind === 'binary') { previewState.value = 'binary'; previewText.value = `二进制文件 · ${res.size ?? 0} 字节` }
    else { previewState.value = 'error'; previewText.value = res.message || '无法预览' }
  } catch (e) { previewState.value = 'error'; previewText.value = e instanceof Error ? e.message : String(e) }
}

/** 协调模式分工摘要（plan_text 消息） */
const coordinatorPlan = computed(() => {
  const msgs = task.value?.messages || []
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].from === '__coordinator__') return msgs[i].content
  }
  return ''
})

let timer: ReturnType<typeof setTimeout>|undefined
function stopPolling(){if(timer){clearTimeout(timer);timer=undefined}}
function startPolling(id:string){
  stopPolling()
  if(id&&active.value){
    // 弱网/长任务兜底：1s 权威状态对齐；WS 事件仍即时刷新。
    timer=setInterval(()=>{void store.loadTask(id,true)},1000)
  }
}
async function interrupt(){if(task.value)await store.runAction(task.value.id,'interrupt')}
onUnmounted(stopPolling)
watch(taskId,async id=>{stopPolling();store.current=null;if(id&&await store.loadTask(id))startPolling(id)},{immediate:true})
watch(active,isActive=>{if(isActive&&taskId.value)startPolling(taskId.value);else stopPolling()})
watch(()=>task.value?.messages.length,()=>nextTick(()=>{if(scrollEl.value)scrollEl.value.scrollHeight&&(scrollEl.value.scrollTop=scrollEl.value.scrollHeight)}))
async function send(){
  const value=draft.value.trim()
  if(!value)return
  const status = task.value?.status
  if (status === 'draft' || status === 'queued') {
    await startDraft()
    const next = task.value?.status
    if (next !== 'running' && next !== 'starting') return
  }
  sending.value=true
  const note=attachedNote()
  if(await store.sendInstruction(note?`${value}\n\n${note}`:value,target.value))draft.value=''
  sending.value=false
}
function askCancel(){cancelAsk.value=true}
async function confirmCancel(){cancelAsk.value=false;if(task.value)await store.runAction(task.value.id,'cancel')}
async function retry(){if(task.value){const next=await store.runAction(task.value.id,'retry');if(next&&next.id!==task.value.id)router.replace(`/collab/${next.id}`)}}
async function startDraft(){if(task.value?.status==='draft'||task.value?.status==='queued')await store.startTask(task.value.id)}
const permAsk = ref(false)
const expandedTool = ref('')
function toolArgsText(tool: { arguments?: Record<string, unknown> }): string {
  const args = tool.arguments
  if (!args) return ''
  try { return JSON.stringify(args, null, 2) } catch { return String(args) }
}
function ensureStorage(): boolean {
  const bridge = (window as any).CoomiAndroid
  if (!bridge?.hasStoragePermission) return true
  const ok = !!bridge.hasStoragePermission()
  if (!ok) permAsk.value = true
  return ok
}
function openStorage(){ (window as any).CoomiAndroid?.openStorageSettings?.(); permAsk.value = false }
function pickFiles(){if(!ensureStorage())return;moreOpen.value=false;window.CoomiAndroid?.importFiles?.()}
function authorizeFolder(){if(!ensureStorage())return;moreOpen.value=false;window.CoomiAndroid?.authorizeFolder?.()}
function time(value:string){const d=new Date(value);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`}
function roleName(id:string){return task.value?.roles.find(r=>r.id===id)?.name||id}
function tsTime(tsMs:number){const d=new Date(tsMs);return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}:${String(d.getSeconds()).padStart(2,'0')}`}
const teamStream = computed(() => {
  if (!task.value) return []
  const items: { tsMs: number; role: { id: string; name: string; color: string; icon: string }; act: CollabActivity }[] = []
  for (const role of task.value.roles) {
    const agent = task.value.agents[role.id]
    for (const act of agent?.activities || []) {
      items.push({ tsMs: act.tsMs, role: { id: role.id, name: role.name, color: role.color, icon: role.icon }, act })
    }
  }
  items.sort((a, b) => a.tsMs - b.tsMs)
  return items
})

/** 产物按一级目录分组（树形简化） */
const artifactTree = computed(() => {
  if (!task.value) return [] as Array<{ dir: string; files: CollabArtifact[] }>
  const map = new Map<string, CollabArtifact[]>()
  for (const a of task.value.artifacts) {
    const parts = a.path.split('/').filter(Boolean)
    const dir = parts.length > 1 ? parts.slice(0, -1).join('/') : '.'
    if (!map.has(dir)) map.set(dir, [])
    map.get(dir)!.push(a)
  }
  return [...map.entries()].map(([dir, files]) => ({ dir, files })).sort((a,b)=>a.dir.localeCompare(b.dir))
})

const composerPlaceholder = computed(() => {
  if (!active.value) return '追加指令，团队会基于历史继续…'
  if (isOrchestrated.value && orchestration.value?.phase === 'planning') return '主控拆解中，消息将在下一轮生效…'
  return '运行中，消息会记录并在本轮结束后生效…'
})

const attached = ref<Array<{id:string;name:string;path:string;size:number;isDir:boolean}>>([])
function addAttached(path:string, isDir:boolean) {
  const name = path.split('/').filter(Boolean).pop() || path
  if (attached.value.some(a => a.path === path)) return
  attached.value.push({ id: `f_${Date.now()}_${Math.random().toString(36).slice(2,7)}`, name, path, size: 0, isDir })
}
function removeAttached(id:string){ attached.value = attached.value.filter(a => a.id !== id) }
function attachedNote(){
  if (!attached.value.length) return ''
  const files = attached.value.filter(a => !a.isDir).map(a => `  - ${a.path}`)
  const dirs = attached.value.filter(a => a.isDir).map(a => `  - ${a.path}/`)
  const parts: string[] = []
  if (files.length) parts.push(`附加文件：\n${files.join('\n')}`)
  if (dirs.length) parts.push(`授权目录：\n${dirs.join('\n')}`)
  return parts.join('\n')
}
function onFilesImported(event: Event) {
  const detail = (event as CustomEvent<{ paths?: string[] }>).detail ?? {}
  for (const p of detail.paths ?? []) addAttached(p, p.endsWith('/'))
}
function onFolderSelected(event: Event) {
  const detail = (event as CustomEvent<{ path?: string | null }>).detail ?? {}
  if (detail.path) addAttached(detail.path, true)
}
onMounted(() => {
  window.addEventListener('coomi:files-imported', onFilesImported)
  window.addEventListener('coomi:folder-selected', onFolderSelected)
})
onUnmounted(() => {
  window.removeEventListener('coomi:files-imported', onFilesImported)
  window.removeEventListener('coomi:folder-selected', onFolderSelected)
})

async function loadUsage() {
  const sid = task.value?.sessionId
  if (!sid) { usage.value = null; return }
  try {
    const data = await apiGet<Record<string, any>>(`/api/sessions/${encodeURIComponent(sid)}`)
    const u = data?.usage
    usage.value = {
      contextRatio: Number(u?.context_ratio ?? u?.contextRatio ?? 0), total: Number(u?.total_tokens ?? u?.total ?? 0), input: Number(u?.input_tokens ?? u?.input ?? 0), output: Number(u?.output_tokens ?? u?.output ?? 0), outputTokensPerSecond: u?.output_tokens_per_second ?? u?.outputTokensPerSecond ?? null,
    }
  } catch { usage.value = null }
}
watch(() => task.value?.sessionId, () => { void loadUsage() }, { immediate: true })

/** 用当前任务配置回创建页编辑角色（可再添加，≥2）。 */
function rebuildWithRoles() {
  if (!task.value) return
  draftStore.loadFromTask(task.value)
  moreOpen.value = false
  router.push('/collab/new')
}
</script>

<template>
  <main class="page">
    <PageHead :title="task?.title || '任务工作台'" @back="router.push('/collab')">
      <template #right><button v-if="active" class="stop" :disabled="store.actionPending" @click="askCancel"><CoomiIcon name="stop" :size="12" />停止</button><button v-if="active" class="interrupt" :disabled="store.actionPending" @click="interrupt">打断</button><button v-else-if="task&&(task.status==='draft'||task.status==='queued')" class="retry" :disabled="store.actionPending" @click="startDraft"><CoomiIcon name="play" :size="14" />启动</button><button v-else-if="task&&['failed','cancelled','partial'].includes(task.status)" class="retry" @click="retry"><CoomiIcon name="refresh" :size="14" />重试</button><button class="head-btn" aria-label="更多" @click="moreOpen=true"><CoomiIcon name="more" :size="18" /></button></template>
    </PageHead>
    <div v-if="store.loading&&!task" class="center">正在载入任务…</div>
    <div v-else-if="store.error&&!task" class="center error"><CoomiIcon name="alert" /><p>{{store.error}}</p><div><button @click="store.loadTask(taskId)">重试</button><button @click="router.push('/collab')">返回任务中心</button></div></div>
    <template v-else-if="task">
      <!-- A. 顶部总览 -->
      <section class="overview">
        <div class="overview-top">
          <div>
            <span class="state" :class="task.status"><i />{{taskStatusText}}</span>
            <span class="mode-badge" :class="task.mode">{{modeLabel}}</span>
          </div>
          <strong>{{progress}}%</strong>
        </div>
        <div class="progress"><span :style="{width:progress+'%'}" /></div>
        <div class="stats">
          <span v-if="isOrchestrated && subtasks.length"><b>{{finishedSubtasks}}/{{subtasks.length}}</b>子任务</span>
          <span v-else><b>{{completedCount}}/{{task.roles.length}}</b>角色完成</span>
          <span><b>{{durationText(task.startedAt,task.finishedAt)}}</b>运行时间</span>
          <span><b>{{task.artifacts.length}}</b>文件</span>
        </div>
      </section>

      <!-- B. 团队状态区（横向滚动） -->
      <section class="team-strip">
        <div class="section-title"><span>团队</span><small>{{completedCount}}/{{task.roles.length}} 完成</small></div>
        <div class="strip-row">
          <CollabAgentCard
            v-for="role in task.roles"
            :key="role.id"
            :role="role"
            :agent="task.agents[role.id]"
            :selected="selectedAgentId===role.id"
            class="strip-card"
            @select="selectedAgentId=role.id"
          />
        </div>
      </section>

      <!-- C. 三 Tab -->
      <nav class="tabs">
        <button :class="{on:tab==='deliver'}" @click="tab='deliver'">交付</button>
        <button :class="{on:tab==='team'}" @click="tab='team'">团队</button>
        <button :class="{on:tab==='files'}" @click="tab='files'">产物<span v-if="task.artifacts.length" class="tab-n">{{task.artifacts.length}}</span></button>
      </nav>

      <section ref="scrollEl" class="main-content">
        <!-- 交付 -->
        <div v-if="tab==='deliver'" class="deliver-pane">
          <!-- orchestrated：拆→并→汇 -->
          <template v-if="isOrchestrated">
            <div class="phase-track" v-if="orchestration">
              <div v-for="(ph, idx) in phaseOrder" :key="ph" class="phase-step" :class="{
                active: orchestration.phase === ph, done: phaseIndex(orchestration.phase) > idx,
              }">
                <span class="phase-dot">{{ phaseIndex(orchestration.phase) > idx ? '✓' : idx + 1 }}</span>
                <span class="phase-name">{{ phaseLabel[ph] }}</span>
              </div>
            </div>
            <div v-if="subtasks.length" class="subtask-list">
              <article v-for="st in subtasks" :key="st.id" class="subtask-card" :class="st.status">
                <button class="st-head" @click="toggleSt(st.id)">
                  <span class="st-role">{{ roleNameById(st.agentId) }}</span>
                  <span class="st-status" :class="st.status">{{ subtaskStatusText[st.status] || st.status }}</span>
                  <span class="st-chev">{{ expandedSt===st.id ? '▾' : '▸' }}</span>
                </button>
                <p class="st-instruction">{{ st.instruction }}</p>
                <p v-if="st.error" class="st-error">{{ st.error }}</p>
                <div v-if="expandedSt===st.id" class="st-out">
                  <pre>{{ task.agents[st.agentId]?.output || '尚无输出' }}</pre>
                  <button class="st-open" @click="selectedAgentId=st.agentId">查看完整 Agent 详情</button>
                </div>
              </article>
            </div>
            <p v-else-if="orchestration?.phase === 'planning'" class="orch-hint">主控正在拆解任务…</p>
            <div v-if="orchestration?.mergeResult" class="merge-box">
              <h3>汇总结果</h3>
              <div class="md-body" v-html="md(orchestration.mergeResult)" />
            </div>
            <div v-else-if="task.summary" class="summary simple">
              <h3>任务总结</h3>
              <p>{{ task.summary.text }}</p>
            </div>
          </template>

          <!-- coordinated：分工 + 总结 -->
          <template v-else>
            <div v-if="coordinatorPlan" class="plan-box">
              <h3>主控分工</h3>
              <div class="md-body" v-html="md(coordinatorPlan)" />
            </div>
            <div v-if="task.summary" class="summary simple">
              <h3>任务总结</h3>
              <div class="md-body" v-html="md(task.summary.text)" />
              <p class="sum-meta">{{task.summary.completedAgents}} 完成 · {{task.summary.failedAgents}} 失败</p>
            </div>
            <div class="role-filter">
              <button :class="{on: !roleFilter}" @click="roleFilter=''">全部</button>
              <button v-for="role in task.roles" :key="role.id" :class="{on: roleFilter===role.id}" @click="roleFilter=role.id">
                <span class="role-dot" :style="{background:role.color}" />{{role.name}}
              </button>
            </div>
            <div class="deliveries">
              <article v-for="role in filteredRoles" :key="role.id" class="delivery-card">
                <header>
                  <span class="dot" :style="{background:role.color}" />
                  <strong>{{role.name}}</strong>
                  <small>{{ agentStatusLabel[task.agents[role.id]?.status||'pending'] }}</small>
                </header>
                <pre class="out-pre">{{ task.agents[role.id]?.output || '（尚无最终输出）' }}</pre>
              </article>
            </div>
          </template>
        </div>

        <!-- 团队 -->
        <div v-else-if="tab==='team'" class="team-pane">
          <div class="messages-block" v-if="task.messages.length">
            <h3 class="pane-label">对话</h3>
            <article v-for="message in task.messages" :key="message.id" class="msg" :class="message.kind">
              <header><strong>{{message.from==='owner'||message.from==='__coordinator__'?'你':roleName(message.from)}}</strong><span v-if="message.to!=='all'">→ {{roleName(message.to)}}</span><time>{{time(message.createdAt)}}</time></header>
              <p>{{message.content}}</p>
            </article>
          </div>
          <h3 class="pane-label">执行流</h3>
          <div class="stream">
            <div v-if="!teamStream.length" class="empty-sm">等待团队产生执行动态…</div>
            <template v-for="item in teamStream" :key="item.act.id">
              <div class="stream-item" :class="item.act.kind">
                <span class="stream-avatar" :style="{background:item.role.color}"><CoomiIcon :name="item.role.icon||'agent'" :size="13" /></span>
                <div class="stream-body">
                  <strong class="stream-name">{{item.role.name}}</strong>
                  <div v-if="item.act.kind==='reasoning'" class="stream-reasoning">💭 {{item.act.content}}</div>
                  <div v-else-if="item.act.kind==='tool'" class="stream-tool">
                    <code>{{item.act.toolName||item.act.refId||'tool'}}</code>
                    <span class="tool-st" :class="item.act.toolStatus">{{toolStatusLabel(item.act.toolStatus)}}</span>
                    <button class="stream-expand" @click="toggleAct(item.act.id)">{{expandedAct===item.act.id?'收起':'详情'}}</button>
                    <pre v-if="expandedAct===item.act.id">{{actTool(item.act).output||JSON.stringify(actTool(item.act).arguments||{},null,2)}}</pre>
                  </div>
                  <div v-else class="stream-text">{{item.act.content}}</div>
                  <small class="stream-time">{{tsTime(item.tsMs)}}</small>
                </div>
              </div>
            </template>
          </div>
        </div>

        <!-- 产物 -->
        <div v-else class="files-pane">
          <div v-if="!artifactTree.length" class="empty-sm">团队尚未产生文件活动</div>
          <section v-for="group in artifactTree" :key="group.dir" class="file-group">
            <h3 class="dir-label">📁 {{ group.dir }}</h3>
            <article v-for="a in group.files" :key="a.id" class="file-row" @click="openPreview(a)">
              <CoomiIcon :name="a.action==='read'?'fileRead':'fileWrite'" :size="16" />
              <div class="file-meta">
                <strong>{{a.path.split('/').pop()}}</strong>
                <small>{{roleName(a.agentId||'')}} · {{artifactActionLabel[a.action]||a.action}} · {{time(a.modifiedAt)}}</small>
              </div>
              <CoomiIcon name="chevronRight" :size="14" class="chev" />
            </article>
          </section>
        </div>
      </section>

      <!-- D. 指令栏 -->
      <footer class="composer">
        <AttachedFileChipContainer v-if="attached.length" :files="attached" @remove="removeAttached" />
        <div class="composer-row">
          <button class="plus-btn" aria-label="添加文件或授权目录" @click="moreOpen=true"><CoomiIcon name="plus" :size="18" /></button>
          <UiSelect v-model="target" size="sm" class="target-select" :options="targetOptions" aria-label="消息接收者" />
          <textarea v-model="draft" rows="1" :placeholder="composerPlaceholder" @keydown.enter.exact.prevent="send"/>
          <button class="send" :disabled="!draft.trim()||sending" @click="send"><CoomiIcon name="arrowUp" :size="17" /></button>
        </div>
      </footer>

      <!-- Agent 详情 -->
      <div v-if="selectedAgentId" class="sheet-mask enter-flat" @click.self="selectedAgentId=''" >
        <aside class="sheet">
          <header>
            <span class="role-avatar" :style="{background:selectedRole?.color}"><CoomiIcon :name="selectedRole?.icon||'agent'" :size="18" /></span>
            <div><h2>{{selectedRole?.name}}</h2><p>{{agentStatusLabel[selectedAgent?.status||'pending']}} · {{selectedRole?.modelSelector}}</p></div>
            <button @click="selectedAgentId=''" ><CoomiIcon name="close" :size="17" /></button>
          </header>
          <section>
            <h3>职责</h3><p>{{selectedRole?.prompt}}</p>
            <template v-if="selectedAgent?.reasoning"><h3>思考过程</h3><pre class="reasoning">{{selectedAgent.reasoning}}</pre></template>
            <template v-if="selectedAgent?.tools?.length">
              <h3>工具调用</h3>
              <div class="tool-list">
                <div v-for="tool in selectedAgent.tools" :key="tool.id" class="tool-row" :class="tool.status">
                  <button class="tool-main" @click="expandedTool = expandedTool===tool.id ? '' : tool.id">
                    <span class="tool-ic"><CoomiIcon :name="tool.status==='running'?'bolt':tool.status==='error'?'alert':'check'" :size="13" /></span>
                    <code>{{ tool.name }}</code>
                    <span v-if="tool.status" class="tool-st">{{ tool.status==='running'?'执行中':tool.status==='error'?'失败':'完成' }}</span>
                    <CoomiIcon name="chevronRight" :size="13" class="tool-chev" :class="{open: expandedTool===tool.id}" />
                  </button>
                  <div v-if="expandedTool===tool.id" class="tool-detail">
                    <p v-if="toolArgsText(tool)" class="tool-sec">输入<pre>{{ toolArgsText(tool) }}</pre></p>
                    <p v-if="tool.output" class="tool-sec">输出<pre>{{ tool.output }}</pre></p>
                  </div>
                </div>
              </div>
            </template>
            <h3>完整输出</h3><pre>{{selectedAgent?.output||'尚无输出'}}</pre>
          </section>
        </aside>
      </div>

      <div v-if="preview" class="sheet-mask enter-flat" @click.self="preview=null">
        <aside class="sheet preview-sheet">
          <header><div><h2>{{preview.path.split('/').pop()}}</h2><p>{{preview.path}}</p></div><button @click="preview=null"><CoomiIcon name="close" :size="17" /></button></header>
          <section class="preview-body">
            <p class="preview-meta">{{roleName(preview.agentId||'')}} · {{artifactActionLabel[preview.action]||preview.action}} · 创建 {{time(preview.createdAt)}} · 修改 {{time(preview.modifiedAt)}}</p>
            <pre v-if="previewState==='text'" class="preview-text">{{previewText}}</pre>
            <p v-else-if="previewState==='binary'" class="empty-sm">{{previewText}}</p>
            <p v-else-if="previewState==='error'" class="empty-sm error">{{previewText}}</p>
            <p v-else class="empty-sm">正在读取…</p>
          </section>
        </aside>
      </div>

      <div v-if="moreOpen" class="sheet-mask enter-flat" @click.self="moreOpen=false">
        <aside class="sheet">
          <header><div class="more-title"><h2>更多设置</h2><p>推理档位与工作目录授权</p></div><button @click="moreOpen=false"><CoomiIcon name="close" :size="17" /></button></header>
          <section class="more-body">
            <h3>用量</h3>
            <div class="usage-ring-row">
              <svg class="ring" viewBox="0 0 40 40" width="44" height="44">
                <circle cx="20" cy="20" r="16" fill="none" stroke="var(--fill-strong)" stroke-width="3.5" />
                <circle cx="20" cy="20" r="16" fill="none" stroke="var(--blue)" stroke-width="3.5"
                  stroke-linecap="round"
                  :stroke-dasharray="`${Math.min(100, usage?.contextRatio || 0) * 1.005} 100`"
                  transform="rotate(-90 20 20)" />
              </svg>
              <div class="usage-meta">
                <strong>{{ Math.round((usage?.contextRatio || 0) * 100) }}% 上下文</strong>
                <span>总 {{ usage?.total ?? 0 }} · 入 {{ usage?.input ?? 0 }} · 出 {{ usage?.output ?? 0 }}</span>
                <span v-if="usage?.outputTokensPerSecond != null">{{ usage.outputTokensPerSecond.toFixed(1) }} tok/s</span>
              </div>
            </div>
            <h3>思考强度</h3>
            <div class="effort-options"><button v-for="item in REASONING_EFFORTS" :key="item.value" :class="{on:config.reasoningEffort===item.value}" @click="session.setReasoningEffort(item.value)">{{ item.label }}</button></div>
            <h3>文件与目录</h3>
            <div class="file-actions"><button @click="pickFiles"><CoomiIcon name="fileRead" :size="16" />选择文件</button><button @click="authorizeFolder"><CoomiIcon name="folder" :size="16" />授权目录</button></div>
            <h3>团队</h3>
            <div class="file-actions"><button @click="rebuildWithRoles"><CoomiIcon name="team" :size="16" />编辑角色 / 再建</button></div>
          </section>
        </aside>
      </div>

      <div v-if="cancelAsk" class="sheet-mask enter-flat" @click.self="cancelAsk=false">
        <div class="confirm-box">
          <p class="cs-title">停止整个协同任务？</p>
          <p class="cs-sub">正在执行的角色会被终止，进度会保留在任务记录中。</p>
          <button class="cs-danger" :disabled="store.actionPending" @click="confirmCancel">停止</button>
          <button class="cs-cancel" @click="cancelAsk=false">取消</button>
        </div>
      </div>

      <div v-if="permAsk" class="perm-mask enter-flat" @click.self="permAsk=false">
        <div class="perm-sheet">
          <p class="perm-title">需要手机存储权限</p>
          <p class="perm-sub">未授权「所有文件访问」权限时，添加的文件和授权目录可能无法被团队读取。请前往系统设置授权后重试。</p>
          <button class="perm-primary" @click="openStorage">去授权</button>
          <button class="perm-cancel" @click="permAsk=false">取消</button>
        </div>
      </div>
    </template>
  </main>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;background:var(--page)}
button{font:inherit}
.stop,.retry{display:flex;align-items:center;gap: 5px; min-height:34px;padding: 0 10px;border-radius: var(--r-md);background:transparent;font-size: var(--fs-label)}
.stop{border:1px solid var(--danger-border);color:var(--danger)}
.interrupt{display:flex;align-items:center;gap: var(--sp-1); min-height:34px;padding: 0 10px;border-radius: var(--r-md);background:transparent;font-size: var(--fs-label);border:1px solid var(--orange);color:var(--orange);margin-left: 6px}
.retry{border:1px solid var(--blue-border);color:var(--blue)}
/* --surface 未定义 → 头部图标按钮底色整条失效，按钮和标题栏糊在一起。 */
.head-btn{display:grid;place-items:center;width:34px;height:34px;margin-left: 6px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text-2)}
.center{display:flex;flex:1;align-items:center;justify-content:center;color:var(--text-3)}
.center.error{flex-direction:column;color:var(--danger)}

/* overview */
.overview{padding: 14px 15px var(--sp-3);background:var(--bg);border-bottom:1px solid var(--border)}
.overview-top{display:flex;gap: 14px;align-items:center}
.overview-top>div{min-width:0;flex:1;display:flex;gap: var(--sp-2);flex-wrap:wrap}
.overview-top>strong{font-size: 22px;color:var(--blue)}
.state{display:inline-flex;align-items:center;gap: 6px;padding: 3px var(--sp-2);border-radius:var(--r-pill);background:var(--fill);color:var(--text-2);font-size: var(--fs-caption)}
.state i{width:6px;height:6px;border-radius:50%;background:currentColor}
.state.running,.state.starting,.state.waiting{background:var(--blue-soft);color:var(--blue)}
.state.running i{--pulse-min:.35;animation: pulse var(--dur-loop) var(--ease-in-out) infinite}
.state.completed{background:var(--ok-soft);color:var(--ok)}
.state.failed{background:var(--danger-soft);color:var(--danger)}
/* pulse 已收敛到 global.css（运行态指示点），谷值经 --pulse-min:.35 保留。 */
.progress{height:4px;margin-top: var(--sp-3);border-radius:2px;background:var(--fill-strong);overflow:hidden}
.progress span{display:block;height:100%;background:var(--blue);transition: width var(--dur-slow) var(--ease-out)}
.stats{display:flex;justify-content:space-between;margin-top: 10px;color:var(--text-3);font-size: var(--fs-caption)}
.stats span{display:flex;flex-direction:column}
.stats b{margin-bottom: 2px;color:var(--text);font-size: var(--fs-caption)}
.mode-badge{display:inline-flex;align-items:center;padding: 3px var(--sp-2);border-radius:var(--r-pill);background:var(--fill);color:var(--text-2);font-size: var(--fs-caption)}
.mode-badge.coordinated{background:var(--blue-soft);color:var(--blue)}
.mode-badge.parallel{background:var(--ok-soft);color:var(--ok)}
.mode-badge.orchestrated{background:var(--orange-soft,var(--blue-soft));color:var(--orange,var(--blue))}

/* team strip */
.team-strip{padding: 10px 0 var(--sp-2);background:var(--page);border-bottom:1px solid var(--border)}
.section-title{display:flex;justify-content:space-between;align-items:baseline;padding: 0 14px 6px;font-size: var(--fs-label);font-weight: 600}
.section-title small{color:var(--text-3);font-weight:400;font-size: var(--fs-caption)}
.strip-row{display:flex;gap: var(--sp-2);overflow-x:auto;padding: 0 14px var(--sp-1);scrollbar-width:none}
.strip-row::-webkit-scrollbar{display:none}
.strip-card{min-width:168px;flex:0 0 auto}

/* tabs */
.tabs{display:flex;gap: 0;background:var(--bg);border-bottom:1px solid var(--border);padding: 0 var(--sp-2)}
.tabs button{flex:1;padding: 11px var(--sp-2);border:0;background:none;color:var(--text-3);font-size: var(--fs-sub);font-weight:600;border-bottom:2px solid transparent;position:relative;transition: color var(--dur-base) var(--ease-out), border-color var(--dur-base) var(--ease-out)}
.tabs button.on{color:var(--blue);border-bottom-color:var(--blue)}
.tab-n{margin-left: var(--sp-1);padding: 1px 6px;border-radius: var(--r-pill);background:var(--fill);font-size: var(--fs-caption);color:var(--text-2)}

.main-content{flex:1;overflow:auto;padding: var(--sp-3) 14px var(--sp-4);animation: coomi-enter-item var(--enter-item-dur) var(--ease-out) backwards}
/* paneIn(4px 上移) 与 coomi-enter-item 位移/曲线完全一致，直接复用 token。 */
.pane-label{margin: 0 0 var(--sp-2);font-size: var(--fs-label);color:var(--text-3);font-weight: 600}

/* deliver */
.phase-track{display:flex;margin-bottom: 14px}
.phase-step{flex:1;display:flex;flex-direction:column;align-items:center;gap: var(--sp-1);position:relative}
.phase-step:not(:last-child)::after{content:'';position:absolute;top:11px;left:calc(50% + 14px);right:calc(-50% + 14px);height:2px;background:var(--fill-strong)}
.phase-step.done:not(:last-child)::after{background:var(--blue)}
.phase-dot{display:grid;place-items:center;width:22px;height:22px;border-radius:50%;background:var(--fill);color:var(--text-3);font-size: var(--fs-caption);font-weight: 600;z-index: 1}
.phase-step.active .phase-dot{background:var(--blue);color:#fff}
.phase-step.done .phase-dot{background:var(--ok-soft);color:var(--ok)}
.phase-name{font-size: var(--fs-caption);color:var(--text-3)}
.phase-step.active .phase-name{color:var(--blue);font-weight: 600}
.phase-step.done .phase-name{color:var(--ok)}
.subtask-list{display:flex;flex-direction:column;gap: var(--sp-2)}
.subtask-card{border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card);overflow:hidden}
.subtask-card.running{border-color:var(--blue)}
.subtask-card.timeout,.subtask-card.failed{border-color:var(--danger-border,var(--danger))}
.st-head{display:flex;align-items:center;gap: var(--sp-2);width:100%;padding: 10px var(--sp-3);border:0;background:none;text-align:left}
.st-role{flex:1;font-size: var(--fs-label);font-weight: 600;color:var(--text)}
.st-status{padding: 2px var(--sp-2);border-radius:var(--r-pill);font-size: var(--fs-caption);background:var(--fill);color:var(--text-2)}
.st-status.running,.st-status.starting,.st-status.retrying{background:var(--blue-soft);color:var(--blue)}
.st-status.completed{background:var(--ok-soft);color:var(--ok)}
.st-status.failed,.st-status.timeout{background:var(--danger-soft);color:var(--danger)}
.st-chev{color:var(--text-3);font-size: var(--fs-label)}
.st-instruction{margin: 0;padding: 0 var(--sp-3) 10px;font-size: var(--fs-label);line-height: 1.5;color:var(--text-2);white-space:pre-wrap;word-break:break-word}
.st-error{margin: 0;padding: 0 var(--sp-3) 10px;font-size: var(--fs-caption);color:var(--danger)}
.st-out{border-top:1px solid var(--border);padding: 10px var(--sp-3)}
.st-out pre{margin: 0 0 var(--sp-2);max-height:160px;overflow:auto;font:11.5px/1.55 var(--font-mono);white-space:pre-wrap;word-break:break-word;color:var(--text)}
.st-open{border:0;background:none;color:var(--blue);font-size: var(--fs-label);font-weight:600;padding: 0}
.orch-hint{margin: 0;padding: var(--sp-3);text-align:center;color:var(--text-3);font-size: var(--fs-label)}
.merge-box,.plan-box{margin-top: var(--sp-3);padding: 14px;border:1px solid var(--blue-border,var(--border));border-radius: var(--r-md);background:var(--blue-soft)}
.merge-box h3,.plan-box h3{margin: 0 0 var(--sp-2);font-size: var(--fs-label);color:var(--blue)}
.summary.simple{margin-top: var(--sp-3);padding: 14px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card)}
.summary.simple h3{margin: 0 0 6px;font-size: var(--fs-sub)}
.summary.simple p{margin: 0;font-size: var(--fs-sub);color:var(--text-2);line-height: 1.55}
.sum-meta{margin-top: var(--sp-2)!important;font-size: var(--fs-caption)!important;color:var(--text-3)!important}
.md-body{font-size: var(--fs-sub);line-height: 1.6;color:var(--text)}
.md-body :deep(p){margin: 0 0 var(--sp-2)}
.md-body :deep(p:last-child){margin-bottom: 0}
.md-body :deep(pre){margin: var(--sp-2) 0 0;padding: 10px;border-radius: var(--r-sm);background:var(--code-bg);color:var(--code-text);font:11.5px/1.55 var(--font-mono);overflow:auto}
.md-body :deep(code){font-family:var(--font-mono);font-size: 0.92em}
.md-body :deep(ul),.md-body :deep(ol){margin: 0 0 var(--sp-2);padding-left: 18px}
.role-filter{display:flex;gap: 6px;margin: 14px 0 10px;flex-wrap:wrap}
.role-filter button{display:inline-flex;align-items:center;gap: 5px;padding: var(--sp-1) 10px;border:1px solid var(--border);border-radius: var(--r-sm);background:var(--fill);color:var(--text-2);font-size: var(--fs-caption)}
.role-filter button.on{border-color:var(--blue);background:var(--blue-soft);color:var(--blue)}
.role-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0}
.deliveries{display:flex;flex-direction:column;gap: var(--sp-2)}
.delivery-card{border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card);overflow:hidden;animation: coomi-enter-block var(--enter-block-dur) var(--ease-out) backwards}
/* cardIn(8px 上移) 与 coomi-enter-block 位移完全一致，直接复用 token。 */
.delivery-card header{display:flex;align-items:center;gap: var(--sp-2);padding: 10px var(--sp-3);border-bottom:1px solid var(--border)}
.delivery-card header .dot{width:8px;height:8px;border-radius:50%}
.delivery-card header strong{font-size: var(--fs-sub);flex:1}
.delivery-card header small{color:var(--text-3);font-size: var(--fs-caption)}
.out-pre{margin: 0;padding: var(--sp-3);font:12px/1.55 var(--font-mono);white-space:pre-wrap;word-break:break-word;max-height:220px;overflow:auto;color:var(--text)}

/* team pane */
.messages-block{margin-bottom: var(--sp-4)}
.msg{padding: 10px var(--sp-3);border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card);margin-bottom: 6px;animation: coomi-enter-block var(--enter-block-dur) var(--ease-out) backwards}
.msg header{display:flex;gap: var(--sp-2);align-items:baseline;margin-bottom: var(--sp-1)}
.msg header strong{font-size: var(--fs-label)}
.msg header time{margin-left: auto;font-size: var(--fs-caption);color:var(--text-3)}
.msg header span{font-size: var(--fs-caption);color:var(--text-3)}
.msg p{margin: 0;font-size: var(--fs-label);color:var(--text-2);white-space:pre-wrap;word-break:break-word;line-height: 1.5}
.msg.instruction{border-color:var(--blue-border,var(--blue))}
.msg.system{opacity:.85}
.stream{display:flex;flex-direction:column;gap: 6px}
.stream-item{display:flex;gap: var(--sp-2);padding: var(--sp-2) 10px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card)}
.stream-avatar{display:grid;place-items:center;width:24px;height:24px;border-radius:50%;color:#fff;flex-shrink:0;margin-top: 2px}
.stream-body{flex:1;min-width:0;display:flex;flex-direction:column;gap: var(--sp-1)}
.stream-name{font-size: var(--fs-label);font-weight:600;color:var(--text)}
.stream-time{align-self:flex-end;font-size: var(--fs-caption);color:var(--text-3);margin-top: -14px}
.stream-reasoning{color:var(--text-2);font-size: var(--fs-label);line-height: 1.55;white-space:pre-wrap;word-break:break-word;font-style:italic}
.stream-tool{display:flex;align-items:center;gap: var(--sp-2);font-size: var(--fs-label);flex-wrap:wrap}
.stream-tool code{flex:1;min-width:0;font-family:var(--font-mono);font-size: var(--fs-caption);color:var(--text);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.stream-expand{padding: 1px var(--sp-2);border:1px solid var(--border);border-radius: var(--r-sm);background:var(--fill);color:var(--text-2);font-size: var(--fs-caption)}
.stream-tool pre{margin: 6px 0 0;width:100%;padding: var(--sp-2) 10px;border-radius: var(--r-sm);background:var(--code-bg);color:var(--code-text);font:11.5px/1.55 var(--font-mono);white-space:pre-wrap;word-break:break-word}
.stream-text{font-size: var(--fs-sub);line-height: 1.6;color:var(--text);white-space:pre-wrap;word-break:break-word}
.tool-st{font-size: var(--fs-caption);color:var(--text-3)}
.tool-st.error{color:var(--danger)}
.tool-st.done{color:var(--ok)}

/* files */
.file-group{margin-bottom: 14px}
.dir-label{margin: 0 0 6px;font-size: var(--fs-label);color:var(--text-3);font-weight: 600;font-family:var(--font-mono)}
.file-row{display:flex;align-items:center;gap: 10px;padding: 10px var(--sp-3);border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card);margin-bottom: 6px;cursor:pointer;color:var(--text)}
.file-meta{flex:1;min-width:0}
.file-meta strong{display:block;font-size: var(--fs-sub)}
.file-meta small{display:block;margin-top: 2px;font-size: var(--fs-caption);color:var(--text-3)}
.chev{color:var(--text-3)}

/* composer */
.composer{display:flex;flex-direction:column;gap: var(--sp-2);padding: 9px 11px calc(9px + var(--safe-bottom));border-top:1px solid var(--border);background:var(--bg)}
.composer-row{display:grid;grid-template-columns:auto auto 1fr auto;gap: 7px;align-items:end}
.composer select{min-height:38px;max-width:105px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text);font-size: var(--fs-caption)}
.composer textarea{min-height:38px;max-height:100px;padding: 9px 11px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text);font:13px/1.45 inherit;resize:none;outline:none}
.plus-btn{display:grid;place-items:center;width:38px;height:38px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text-2)}
.send{display:grid;place-items:center;width:38px;height:38px;border:0;border-radius: var(--r-md);background:var(--blue);color:#fff}
.send:disabled{opacity:.35}

/* sheets */
.sheet-mask{position:fixed;inset:0;z-index: var(--z-toast);display:flex;align-items:flex-end;background:rgba(10,15,24,.45)}
.sheet{width:100%;max-height:82vh;border-radius:20px 20px 0 0;background:var(--bg);overflow:hidden;animation: rise var(--dur-base) var(--ease-out) backwards;/* rise 已收敛 global.css，遮罩淡入由 .enter-flat 类负责 */}
.sheet>header{display:flex;align-items:center;gap: 10px;padding: 14px;border-bottom:1px solid var(--border)}
.role-avatar{display:grid;place-items:center;width:38px;height:38px;border-radius: var(--r-md);color:#fff}
.sheet header div{min-width:0;flex:1}
.sheet h2{margin: 0;font-size: var(--fs-body-lg)}
.sheet header p{margin: 3px 0 0;color:var(--text-3);font-size: var(--fs-caption)}
.sheet header button{display:grid;place-items:center;width:32px;height:32px;border:0;border-radius: var(--r-sm);background:var(--fill);color:var(--text-2)}
.sheet section{max-height:68vh;overflow:auto;padding: 14px calc(14px + env(safe-area-inset-right)) calc(var(--sp-5) + var(--safe-bottom))}
.sheet h3{margin: 0 0 7px;font-size: var(--fs-label)}
.sheet section>p{margin: 0 0 var(--sp-4);color:var(--text-2);font-size: var(--fs-label);line-height: 1.55;white-space:pre-wrap}
.sheet pre{margin: 0 0 14px;padding: 10px;border-radius: var(--r-sm);background:var(--code-bg);color:var(--code-text);font:11.5px/1.55 var(--font-mono);white-space:pre-wrap;word-break:break-word}
.sheet pre.reasoning{font-style:italic;color:var(--text-3);background:var(--fill)}
.tool-list{display:flex;flex-direction:column;gap: 6px;margin-bottom: var(--sp-3)}
.tool-row{border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);overflow:hidden}
.tool-main{display:flex;align-items:center;gap: var(--sp-2);width:100%;padding: var(--sp-2) 10px;border:0;background:none;text-align:left}
.tool-ic{display:grid;place-items:center;width:22px;height:22px;border-radius: var(--r-sm);background:var(--blue-soft);color:var(--blue);flex-shrink:0}
.tool-row.error .tool-ic{background:var(--danger-soft);color:var(--danger)}
.tool-main code{flex:1;min-width:0;font-family:var(--font-mono);font-size: var(--fs-label);color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tool-st{flex-shrink:0;font-size: var(--fs-caption);color:var(--text-3)}
.tool-row.error .tool-st{color:var(--danger)}
.tool-chev{flex-shrink:0;color:var(--text-3);transition: transform var(--dur-base) var(--ease-out)}
.tool-chev.open{transform:rotate(90deg)}
.tool-detail{padding: 0 10px 10px;border-top:1px solid var(--border)}
.tool-sec{margin: var(--sp-2) 0 0;font-size: var(--fs-caption);color:var(--text-3)}
.tool-sec pre{margin: 5px 0 0}
.preview-sheet{max-width:520px;width:100%}
.preview-body{max-height:60vh;overflow:auto}
.preview-meta{font-size: var(--fs-caption);color:var(--text-3);margin: 0 0 10px}
.preview-text{margin: 0;padding: var(--sp-3);border-radius: var(--r-md);background:var(--code-bg);color:var(--code-text);font:12px/1.6 var(--font-mono);white-space:pre-wrap;word-break:break-word}
.more-title h2{margin: 0;font-size: var(--fs-body-lg)}
.more-title p{margin: 3px 0 0;color:var(--text-3);font-size: var(--fs-caption)}
.more-body{max-height:68vh;overflow:auto;padding: 14px calc(14px + env(safe-area-inset-right)) calc(var(--sp-5) + var(--safe-bottom))}
.more-body h3{margin: 0 0 var(--sp-2);font-size: var(--fs-label)}
.effort-options{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap: 6px;margin-bottom: 18px}
.effort-options button{min-height:34px;border:1px solid var(--border);border-radius: var(--r-sm);background:var(--fill);color:var(--text-2);font-size: var(--fs-label)}
.effort-options button.on{border-color:var(--blue);background:var(--blue-soft);color:var(--blue);font-weight: 600}
.file-actions{display:flex;gap: var(--sp-2)}
.file-actions button{display:flex;align-items:center;justify-content:center;gap: 6px;flex:1; min-height:40px;border:1px solid var(--blue-border);border-radius: var(--r-md);background:var(--blue-soft);color:var(--blue);font-size: var(--fs-sub);font-weight:600}
.usage-ring-row{display:flex;align-items:center;gap: var(--sp-3);margin-bottom: var(--sp-4)}
.ring{flex-shrink:0}
.usage-meta{display:flex;flex-direction:column;gap: 2px;min-width:0}
.usage-meta strong{font-size: var(--fs-sub);color:var(--text)}
.usage-meta span{font-size: var(--fs-caption);color:var(--text-3)}
.confirm-box{width:100%;max-width:320px;margin: auto var(--sp-4);padding: var(--sp-5);border-radius: var(--r-card);background:var(--bg);box-shadow:var(--shadow-2);animation: modalIn var(--dur-base) var(--ease-out) backwards;/* modalIn 已收敛 global.css */}
.confirm-box .cs-title{margin: 0;font-size: var(--fs-strong);font-weight: 600;color:var(--text)}
.confirm-box .cs-sub{margin: 6px 0 18px;font-size: var(--fs-sub);line-height: 1.5;color:var(--text-2)}
.cs-danger,.cs-cancel{width:100%;min-height:44px;border:0;border-radius: var(--r-md);font-size: var(--fs-body);font-weight:600}
.cs-danger{background:var(--danger);color:#fff;margin-bottom: var(--sp-2)}
.cs-danger:disabled{opacity:.45}
.cs-cancel{background:var(--fill);color:var(--text-2)}
.perm-mask{position:fixed;inset:0;z-index: var(--z-toast);display:flex;align-items:center;justify-content:center;background:rgba(17,22,31,.4);padding: var(--sp-6)}
.perm-sheet{width:100%;max-width:320px;padding: var(--sp-5);border-radius: var(--r-card);background:var(--bg);box-shadow:var(--shadow-2);animation: modalIn var(--dur-base) var(--ease-out) backwards;/* modalIn 已收敛 global.css，遮罩淡入由 .enter-flat 类负责 */}
.perm-title{margin: 0;font-size: var(--fs-strong);font-weight: 600;color:var(--text)}
.perm-sub{margin: var(--sp-2) 0 18px;font-size: var(--fs-sub);line-height: 1.5;color:var(--text-2)}
.perm-primary,.perm-cancel{width:100%;min-height:44px;border:0;border-radius: var(--r-md);font-size: var(--fs-body);font-weight:600}
.perm-primary{background:var(--blue);color:#fff;margin-bottom: var(--sp-2)}
.perm-cancel{background:var(--fill);color:var(--text-2)}

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet, .perm-sheet, .confirm-box { animation: none; }
}
:root[data-motion='off'] .sheet, :root[data-motion='off'] .perm-sheet, :root[data-motion='off'] .confirm-box { animation: none; }
</style>
