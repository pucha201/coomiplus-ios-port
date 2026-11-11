<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'
import UiSkeleton from '@/components/ui/UiSkeleton.vue'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { useSessionStore } from '@/stores/session'

const scopeOptions = [
  { value: 'global', label: '全局' },
  { value: 'project', label: '项目' },
  { value: 'local', label: '当前目录' },
]
const typeOptions = [
  { value: 'user', label: '用户偏好' },
  { value: 'feedback', label: '纠正反馈' },
  { value: 'project', label: '项目信息' },
  { value: 'reference', label: '参考信息' },
]

type Scope = 'local' | 'project' | 'global'
type MemoryType = 'user' | 'feedback' | 'project' | 'reference'
interface MemoryItem {
  name: string
  description: string
  content: string
  scope: Scope
  type: MemoryType
  lifecycle: 'candidate' | 'stable' | 'core'
  hit_count: number
  last_triggered: string | null
}

const router = useRouter()
const session = useSessionStore()
/**
 * 记忆按「当前会话的工作目录」读写：引擎写入记忆用的是 session.cwd，
 * 以前这里固定请求引擎 cwd，导致会话里保存的记忆在页面上看不到。
 * 只传 session_id，由引擎解析 cwd（不把任意路径暴露给前端）。
 */
const sessionQuery = computed(() => {
  const id = session.sessionId
  return id ? `?session_id=${encodeURIComponent(id)}` : ''
})
const memories = ref<MemoryItem[]>([])
const editing = ref<MemoryItem | null>(null)
const editingExisting = ref(false)
const loading = ref(true)
const notice = ref('')
/** 拉取失败和「真的一条都没有」是两件事：失败时不能再给「暂无记忆」的空态。 */
const loadFailed = ref(false)
const expanded = ref(new Set<string>())
const pendingDelete = ref<MemoryItem | null>(null)
const deletingName = ref('')

function toggleExpanded(name: string) {
  const next = new Set(expanded.value)
  if (next.has(name)) next.delete(name)
  else next.add(name)
  expanded.value = next
}

/** apiGet/apiSend 抛的都是能直接给用户看的句子，非 Error 的兜底别漏出 `[object Object]`。 */
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e))

async function load() {
  loading.value = true
  loadFailed.value = false
  try {
    const data = await apiGet<{ memories?: MemoryItem[] }>(`/api/memory${sessionQuery.value}`)
    memories.value = data.memories ?? []
  } catch (error) {
    loadFailed.value = true
    notice.value = `加载失败：${errText(error)}`
  } finally {
    loading.value = false
  }
}

// ── 自动对话记忆：每轮结束后引擎把上一轮问答存进 agent-memory.jsonl。
//    以前这份数据没有任何 UI 入口，用户以为“记忆没保存”。这里按当前会话列出/清除。
interface AgentMemoryItem { at_ms: number; session?: string; user: string; assistant: string }
const agentMemories = ref<AgentMemoryItem[]>([])
const agentOpen = ref(true)
const agentLoading = ref(true)
const clearingAgent = ref(false)

async function loadAgentMemory() {
  agentLoading.value = true
  try {
    const data = await apiGet<{ entries?: AgentMemoryItem[] }>(`/api/memory/agent${sessionQuery.value}`)
    agentMemories.value = data.entries ?? []
  } catch {
    agentMemories.value = []
  } finally {
    agentLoading.value = false
  }
}

async function clearAgentMemory() {
  if (!session.sessionId || clearingAgent.value) return
  clearingAgent.value = true
  try {
    await apiSend(`/api/memory/agent${sessionQuery.value}`, 'DELETE')
    agentMemories.value = []
    notice.value = '已清除本会话的自动对话记忆'
  } catch (error) {
    notice.value = `清除失败：${errText(error)}`
  } finally {
    clearingAgent.value = false
  }
}

function createMemory() {
  editingExisting.value = false
  editing.value = {
    name: '', description: '', content: '', scope: 'global', type: 'user', lifecycle: 'candidate', hit_count: 0, last_triggered: null,
  }
}

async function save() {
  const item = editing.value
  if (!item || !item.name.trim() || !item.content.trim()) {
    notice.value = '名称和记忆内容不能为空'
    return
  }
  try {
    await apiSend(editingExisting.value ? `/api/memory/${encodeURIComponent(item.name)}${sessionQuery.value}` : `/api/memory${sessionQuery.value}`,
      editingExisting.value ? 'PUT' : 'POST', item)
    editing.value = null
    notice.value = '已保存'
    await load()
  } catch (error) {
    notice.value = `保存失败：${errText(error)}`
  }
}

function requestRemove(item: MemoryItem) {
  pendingDelete.value = item
}

async function confirmRemove() {
  const item = pendingDelete.value
  if (!item || deletingName.value) return
  deletingName.value = item.name
  let data: { deleted?: boolean }
  try {
    data = await apiSend<{ deleted?: boolean }>(`/api/memory/${encodeURIComponent(item.name)}${sessionQuery.value}`, 'DELETE')
  } catch (error) {
    notice.value = `删除失败：${errText(error)}`
    deletingName.value = ''
    return
  }
  pendingDelete.value = null
  deletingName.value = ''
  if (data.deleted === false) {
    notice.value = '该记忆不存在或已被删除'
    await load()
    return
  }
  if (editing.value?.name === item.name) editing.value = null
  memories.value = memories.value.filter(memory => memory.name !== item.name)
  notice.value = '已删除'
  await load()
}

onMounted(() => {
  void load()
  void loadAgentMemory()
})
</script>

<template>
  <div class="page">
    <PageHead title="持久记忆" @back="goBack(router, '/settings')">
      <template #right>
        <button class="icon-btn" aria-label="新增记忆" @click="createMemory"><CoomiIcon name="plus" /></button>
      </template>
    </PageHead>
    <main class="body">
      <p class="scope-note">这里只管理 CoomiPlus 内建持久记忆，与任何 MCP、Skill 或第三方记忆扩展无关。范围：当前会话的工作目录 + 全局记忆。</p>
      <!-- 自动对话记忆：每轮结束后保存上一轮问答，按当前会话展示与清理。 -->
      <section class="agent-memory">
        <header class="am-head">
          <button class="am-toggle" :aria-expanded="agentOpen" @click="agentOpen = !agentOpen">
            <CoomiIcon name="memory" :size="16" />
            <span>对话记忆（自动保存）</span>
            <span class="am-count">{{ agentMemories.length }}</span>
            <CoomiIcon name="chevronDown" :size="15" :class="['am-chev', { open: agentOpen }]" />
          </button>
          <button v-if="agentMemories.length" class="am-clear" :disabled="clearingAgent" @click="clearAgentMemory">
            {{ clearingAgent ? '清除中…' : '清除本会话' }}
          </button>
        </header>
        <template v-if="agentOpen">
          <p v-if="agentLoading" class="am-hint">正在读取…</p>
          <p v-else-if="!agentMemories.length" class="am-hint">本会话还没有自动保存的对话记忆（每轮结束后保存上一轮问答）。</p>
          <article v-for="(item, index) in agentMemories" :key="index" class="am-row">
            <p class="am-time">{{ new Date(item.at_ms).toLocaleString() }}</p>
            <p class="am-q"><b>问：</b>{{ item.user }}</p>
            <p class="am-a"><b>结论：</b>{{ item.assistant }}</p>
          </article>
        </template>
      </section>
      <!-- 记忆是一张张卡片，用 card 变体骨架占位：行高与正文卡片一致，
           数据到达时列表不会整体往下跳一截。 -->
      <UiSkeleton v-if="loading" variant="card" :rows="3" />
      <UiEmpty
        v-else-if="!memories.length && !loadFailed"
        icon="memory"
        title="暂无内建持久记忆"
        desc="这里只管理 CoomiPlus 内建持久记忆，与任何 MCP、Skill 或第三方记忆扩展无关。"
      />
      <article v-for="item in memories" :key="item.name" :class="['memory', 'enter-item', { expanded: expanded.has(item.name) }]">
        <button class="memory-head" :aria-expanded="expanded.has(item.name)" @click="toggleExpanded(item.name)">
          <div><h2>{{ item.name }}</h2><p class="description">{{ item.description || '无描述' }}</p></div>
          <span :class="['life', item.lifecycle]">{{ item.lifecycle }}</span>
          <CoomiIcon class="chevron" name="chevronDown" :size="17" />
        </button>
        <p :class="['content', { preview: !expanded.has(item.name) }]">{{ item.content }}</p>
        <!-- 折叠区开合：第二类语义（--expand-* / forwards）。
             .meta 先出、.actions 晚 40ms，两段之间有先后，读起来是「展开」而不是「突然多出一块」。
             收起时两段同时走（不再错开），否则点完会看见它们先后消失。 -->
        <Transition name="memory-more">
          <div v-if="expanded.has(item.name)" class="meta">
            <span>{{ item.scope }}</span><span>命中 {{ item.hit_count }} 次</span>
            <span>{{ item.last_triggered ? `最近 ${new Date(item.last_triggered).toLocaleDateString()}` : '从未命中' }}</span>
          </div>
        </Transition>
        <Transition name="memory-actions">
          <div v-if="expanded.has(item.name)" class="actions">
            <button @click="editing = { ...item }; editingExisting = true"><CoomiIcon name="pencil" :size="15" />编辑</button>
            <button class="danger" :disabled="deletingName === item.name" @click="requestRemove(item)"><CoomiIcon name="trash" :size="15" />删除</button>
          </div>
        </Transition>
      </article>
      <p v-if="notice" class="notice">{{ notice }}</p>
    </main>
    <div v-if="editing" class="scrim enter-flat" @click.self="editing = null">
      <section class="editor" role="dialog" aria-modal="true">
        <div class="editor-head">
          <h2>{{ editingExisting ? '编辑记忆' : '新增记忆' }}</h2>
          <button class="icon-btn" aria-label="关闭" @click="editing = null"><CoomiIcon name="close" /></button>
        </div>
        <label>名称<input v-model="editing.name" :disabled="editingExisting" maxlength="80" placeholder="英文、数字、- 或 _" /></label>
        <label>描述<input v-model="editing.description" maxlength="240" /></label>
        <div class="selects">
          <label>范围<UiSelect v-model="editing.scope" :options="scopeOptions" block /></label>
          <label>类型<UiSelect v-model="editing.type" :options="typeOptions" block /></label>
        </div>
        <label>内容<textarea v-model="editing.content" rows="7" /></label>
        <button class="save" @click="save">保存</button>
      </section>
    </div>
    <div v-if="pendingDelete" class="scrim confirm-scrim enter-flat" @click.self="pendingDelete = null">
      <section class="confirm-dialog" role="alertdialog" aria-modal="true" aria-labelledby="delete-memory-title">
        <h2 id="delete-memory-title">删除持久记忆</h2>
        <p>确定删除“{{ pendingDelete.name }}”？此操作无法撤销。</p>
        <div class="confirm-actions">
          <button :disabled="!!deletingName" @click="pendingDelete = null">取消</button>
          <button class="confirm-delete" :disabled="!!deletingName" @click="confirmRemove">{{ deletingName ? '删除中…' : '删除' }}</button>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.page { height: 100%; display: flex; flex-direction: column; background: var(--page); color: var(--text); }
.body { flex: 1; overflow-y: auto; padding: var(--sp-3) var(--sp-3) calc(var(--safe-bottom) + var(--sp-6)); }
.scope-note { margin: 2px 2px var(--sp-3); padding: 10px var(--sp-3); border-left: 3px solid var(--blue); background: var(--blue-soft); color: var(--text-2); font-size: var(--fs-label); line-height: 1.6; }

/* 自动对话记忆：折叠区 + 每轮问答卡片 */
.agent-memory { margin: 0 2px var(--sp-3); padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-card); background: var(--bg); }
.am-head { display: flex; align-items: center; gap: var(--sp-2); }
.am-toggle { flex: 1; display: flex; align-items: center; gap: var(--sp-2); min-width: 0; padding: var(--sp-1) 0; border: 0; background: none; color: var(--text); font: inherit; text-align: left; }
.am-toggle span:nth-child(2) { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.am-count { flex-shrink: 0; color: var(--text-3); font-size: var(--fs-caption); }
.am-chev { flex-shrink: 0; color: var(--text-3); transition: transform var(--dur-fast) var(--ease-out); }
.am-chev.open { transform: rotate(180deg); }
.am-clear { flex-shrink: 0; padding: var(--sp-1) 10px; border: 1px solid var(--border); border-radius: var(--r-pill); background: none; color: var(--danger); font-size: var(--fs-caption); }
.am-clear:disabled { opacity: .5; }
.am-hint { margin: var(--sp-2) 0 2px; color: var(--text-3); font-size: var(--fs-label); line-height: 1.5; }
.am-row { padding: var(--sp-2) 0; border-top: 1px solid var(--border); }
.am-time { margin: 0 0 var(--sp-1); color: var(--text-3); font-size: var(--fs-caption); }
.am-q, .am-a { margin: 2px 0; color: var(--text); font-size: var(--fs-label); line-height: 1.6; word-break: break-word; }
.am-a { color: var(--text-2); }

.memory { margin-bottom: 10px; padding: 13px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); }
.memory-head { display: grid; grid-template-columns: minmax(0, 1fr) auto auto; align-items: start; width: 100%; gap: 10px; text-align: left; }
.memory h2, .editor h2 { font-size: var(--fs-body-lg); color: var(--text); }
.memory-head p { margin-top: 3px; font-size: var(--fs-label); color: var(--text-3); }
.description { overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.memory.expanded .description { overflow: visible; white-space: normal; }
.chevron { align-self: center; color: var(--text-3); transition: transform var(--dur-fast) var(--ease-out); }
.memory.expanded .chevron { transform: rotate(180deg); }
/* ── 折叠区的展开 / 收起：第二类语义（--expand-*，forwards）──
   这一块以前只有 .expanded 这个 class 控制 chevron 旋转，
   正文是「钳两行 ↔ 全文」的离散切换，看起来就是「点了没反应」。
   现在：
     · 展开 = .meta / .actions 两段依次淡入 + 轻微下移（--expand-open-shift），
       .actions 晚 40ms，两段有先后才读得出「展开」；
     · 收起 = 两段同时反向（--expand-close-*），forwards 停在收起那一帧，
       节点被 Vue 摘掉之前不会闪回展开样式；
     · 正文本身不加动画：line-clamp 是离散属性，强行过渡会让两行预览
       在展开过程中忽长忽短，反而比不动画更难读。 */
.memory-more-enter-active {
  animation: coomi-expand-slide var(--expand-open-dur) var(--ease-out) forwards;
}
.memory-more-leave-active {
  animation: coomi-expand-slide-out var(--expand-close-dur) var(--ease-emphasized) forwards;
}
.memory-actions-enter-active {
  animation: coomi-expand-slide var(--expand-open-dur) var(--ease-out) 40ms backwards;
}
.memory-actions-leave-active {
  animation: coomi-expand-slide-out var(--expand-close-dur) var(--ease-emphasized) forwards;
}
/* .actions 的「打开」用 backwards 而不是 forwards：它带 40ms 延迟，
   forwards 只在播完后生效、对延迟期没有帮助，而 backwards 正好让这段等待
   保持在第一帧的透明态 —— 这就是 --enter-* 判定表里 backwards 仍然必需的那一类用法。
   收起方向没有延迟，必须 forwards（节点马上要被摘掉，播完那帧就是要停住的那帧）。 */
@media (prefers-reduced-motion: reduce) {
  .memory-more-enter-active, .memory-actions-enter-active { animation: none; opacity: 1; transform: none; }
  .memory-more-leave-active, .memory-actions-leave-active { animation: none; opacity: 0; }
}
:root[data-motion='off'] .memory-more-enter-active, :root[data-motion='off'] .memory-actions-enter-active { animation: none; opacity: 1; transform: none; }
:root[data-motion='off'] .memory-more-leave-active, :root[data-motion='off'] .memory-actions-leave-active { animation: none; opacity: 0; }
.life { align-self: flex-start; padding: 3px 7px; border-radius: 4px; background: var(--fill); color: var(--text-2); font-size: var(--fs-caption); text-transform: uppercase; }
.life.core { background: var(--blue-soft); color: var(--blue); }
.life.stable { color: var(--ok); }
.content { margin-top: 10px; white-space: pre-wrap; font-size: var(--fs-sub); line-height: 1.65; color: var(--text-2); }
.content.preview { display: -webkit-box; overflow: hidden; -webkit-box-orient: vertical; -webkit-line-clamp: 2; }
.meta, .actions { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 10px; font-size: var(--fs-caption); color: var(--text-3); }
.actions { justify-content: flex-end; padding-top: 9px; border-top: 1px solid var(--border); }
.actions button { display: flex; align-items: center; gap: var(--sp-1); color: var(--blue); }
.actions .danger { color: var(--danger); }
.notice { margin: 10px 2px; color: var(--text-2); font-size: var(--fs-label); }
.scrim { position: fixed; inset: 0; z-index: var(--z-header); display: flex; align-items: flex-end; background: rgba(0,0,0,.45); }
.editor { width: 100%; max-height: 90%; overflow-y: auto; padding: var(--sp-4) 14px calc(var(--safe-bottom) + var(--sp-4)); border-radius: 8px 8px 0 0; background: var(--bg); animation: rise var(--dur-base) var(--ease-out) backwards; /* rise 已收敛 global.css，遮罩淡入由 .enter-flat 类负责 */ }
.editor-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: var(--sp-3); }
.editor label { display: flex; flex-direction: column; gap: 5px; margin-top: 10px; font-size: var(--fs-label); color: var(--text-2); }
.editor input, .editor select, .editor textarea { width: 100%; padding: 10px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); color: var(--text); font: inherit; }
.editor textarea { resize: vertical; line-height: 1.5; }
.selects { display: grid; grid-template-columns: 1fr 1fr; gap: 9px; }
.save { width: 100%; min-height: 44px; margin-top: 14px; border-radius: var(--r-md); background: var(--blue); color: #fff; font-weight: 600; }
.confirm-scrim { align-items: center; padding: 18px; }
.confirm-dialog { width: 100%; max-width: 360px; margin: auto; padding: 18px; border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-2); animation: modalIn var(--dur-base) var(--ease-out) backwards; /* modalIn 已收敛 global.css（语义 = enter-pop） */ }
.confirm-dialog h2 { color: var(--text); font-size: var(--fs-strong); }
.confirm-dialog p { margin-top: 9px; color: var(--text-2); font-size: var(--fs-sub); line-height: 1.6; overflow-wrap: anywhere; }
.confirm-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 18px; }
.confirm-actions button { min-width: 72px; min-height: 40px; padding: 0 14px; border-radius: var(--r-md); background: var(--fill); color: var(--text-2); }
.confirm-actions .confirm-delete { background: var(--danger); color: #fff; }
.confirm-actions button:disabled { opacity: .55; }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .editor, .confirm-dialog { animation: none; }
}
:root[data-motion='off'] .editor, :root[data-motion='off'] .confirm-dialog { animation: none; }
</style>
