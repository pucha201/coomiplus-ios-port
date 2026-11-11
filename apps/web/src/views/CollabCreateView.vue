<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import CollabRoleEditor from '@/features/collab/components/CollabRoleEditor.vue'
import { useCollabDraftStore } from '@/features/collab/stores/collabDraftStore'
import { useCollabStore } from '@/features/collab/stores/collabStore'
import { REASONING_EFFORTS, useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { pickDirectory as pickFolder } from '@/utils/folderPicker'
import type { CollabRole, CollabTask } from '@/features/collab/types/collab'

const router = useRouter()
const config = useConfigStore()
const session = useSessionStore()
const draftStore = useCollabDraftStore()
const collab = useCollabStore()
const draft = draftStore.draft
const steps = ['定义任务', '组建团队', '启动检查']
const models = computed(() => config.providers.flatMap(provider => (provider.models.length ? provider.models : [provider.model]).filter(Boolean).map(model => ({ value: `${provider.id}:${model}`, label: `${provider.name} · ${model}` }))))

const permAsk = ref(false)
function hasStorage() {
  const bridge = (window as any).CoomiAndroid
  if (bridge?.hasStoragePermission) return !!bridge.hasStoragePermission()
  return true // 桌面浏览器无此桥，放行
}
function openStorage() { (window as any).CoomiAndroid?.openStorageSettings?.(); permAsk.value = false }
async function pickDirectory() {
  const bridge = (window as any).CoomiAndroid
  if (!hasStorage()) { permAsk.value = true; return }
  if (bridge?.pickDirectory) { bridge.pickDirectory(); return }
  const path = await pickFolder(draft.cwd || session.cwd || '')
  if (path) draft.cwd = path
}
function onFolderSelected(event: Event) {
  const detail = (event as CustomEvent<{ path?: string | null }>).detail ?? {}
  if (typeof detail.path === 'string' && detail.path) draft.cwd = detail.path
}

onMounted(async () => {
  window.addEventListener('coomi:folder-selected', onFolderSelected)
  if (!config.providers.length) await config.fetchProviders()
  if (!draft.roles.length) applyPreset('code-review')
  if (!draft.cwd) draft.cwd = session.cwd || ''
})
onBeforeUnmount(() => window.removeEventListener('coomi:folder-selected', onFolderSelected))

function normalizeRole(role: any, index: number): CollabRole {
  return {
    id: role.id || `role_${Date.now()}_${index}`, name: role.name, modelSelector: role.modelSelector || models.value[0]?.value || '', prompt: role.prompt, color: role.color || '#2d61c6', icon: role.icon || 'agent', visibility: role.visibility || 'full', roleType: role.roleType || role.role_type, allowedPaths: Array.isArray(role.allowedPaths) ? role.allowedPaths : undefined, forbiddenPaths: Array.isArray(role.forbiddenPaths) ? role.forbiddenPaths : undefined,
  }
}
function applyPreset(id: string) { const preset = config.collabPresets.find(item => item.id === id); if (preset) draftStore.setRoles(preset.roles.map((role, index) => normalizeRole({ ...role, id: `${id}_${index}` }, index))) }
function addRole() { const palette = ['#2d61c6','#d47458','#1f9d6b','#8b5cf6','#db2777']; draft.roles.push(normalizeRole({ name: '新角色', prompt: '明确分析任务，完成职责范围内的工作，并报告可验证的结果。', color: palette[draft.roles.length % palette.length] }, draft.roles.length)) }
function move(index: number, direction: -1 | 1) { const target = index + direction; if (target < 0 || target >= draft.roles.length) return; [draft.roles[index], draft.roles[target]] = [draft.roles[target], draft.roles[index]] }
function modeLabel(mode: CollabTask['mode']) {
  if (mode === 'orchestrated') return '集中式并行调度'
  if (mode === 'coordinated') return '协调执行'
  return '并行执行'
}
function next() { if (draftStore.step < 3) draftStore.step++ }
async function start() { if (!draftStore.valid) return; const task = await collab.createTask({ title: draft.title.trim() || draft.objective.trim().slice(0, 42), objective: draft.objective.trim(), cwd: draft.cwd.trim(), mode: draft.mode, sessionId: session.sessionId, roles: draft.roles }); if (task) { draftStore.reset(); router.replace(`/collab/${task.id}`) } }
</script>

<template>
  <main class="page">
    <PageHead title="创建协同任务" @back="router.push('/collab')" />
    <nav class="steps"><button v-for="(label,index) in steps" :key="label" :class="{on:draftStore.step===index+1,done:draftStore.step>index+1}" @click="draftStore.step=index+1"><span>{{ index+1 }}</span>{{ label }}</button></nav>
    <div class="body">
      <section v-if="draftStore.step===1" class="panel enter-block">
        <header><span class="badge"><CoomiIcon name="target" :size="20" /></span><div><h2>先说清楚要完成什么</h2><p>目标和验收标准越具体，团队分工越准确。</p></div></header>
        <label>任务名称 <input v-model="draft.title" placeholder="可留空，将根据目标自动生成" /></label>
        <label>任务目标 <textarea v-model="draft.objective" rows="8" placeholder="例如：重构设置页面，保持现有功能不变，优化移动端信息层级，并通过类型检查与构建。" /></label>
        <label>工作目录
          <div class="cwd-row"><input v-model="draft.cwd" placeholder="默认使用当前会话工作目录" /><button type="button" @click="pickDirectory"><CoomiIcon name="folder" :size="16" />选择目录</button></div>
        </label>
        <label>思考强度
          <div class="effort"><button v-for="item in REASONING_EFFORTS" :key="item.value" :class="{on:config.reasoningEffort===item.value}" @click="session.setReasoningEffort(item.value)">{{ item.label }}</button></div>
        </label>
        <label>执行模式 <div class="mode"><button :class="{on:draft.mode==='parallel'}" @click="draft.mode='parallel'"><div class="mtop"><strong>并行执行</strong></div><small>角色同时处理各自职责</small></button><button :class="{on:draft.mode==='coordinated'}" @click="draft.mode='coordinated'"><div class="mtop"><strong>协调执行</strong></div><small>按角色职责汇总交付</small></button><button :class="{on:draft.mode==='orchestrated'}" @click="draft.mode='orchestrated'"><div class="mtop"><strong>集中式并行调度</strong><span class="beta">Beta</span></div><small>主控拆解、并行执行、统一汇总</small></button></div></label>
      </section>

      <section v-else-if="draftStore.step===2" class="panel enter-block">
        <header><span class="badge"><CoomiIcon name="team" :size="20" /></span><div><h2>组建执行团队</h2><p>为每个角色指定模型、职责和交付边界。</p></div></header>
        <div class="presets"><button v-for="preset in config.collabPresets" :key="preset.id" @click="applyPreset(preset.id)">{{ preset.name }}</button></div>
        <div class="roles"><CollabRoleEditor v-for="(role,index) in draft.roles" :key="role.id" :role="role" :index="index" :models="models" @remove="draft.roles.splice(index,1)" @move="move(index,$event)" /></div>
        <button class="add" @click="addRole"><CoomiIcon name="plus" :size="16" />添加角色</button>
      </section>

      <section v-else class="panel review enter-block">
        <header><span class="badge"><CoomiIcon name="check" :size="20" /></span><div><h2>启动前检查</h2><p>确认目标、工作目录和团队配置。</p></div></header>
        <dl><div><dt>任务</dt><dd>{{ draft.title || draft.objective.slice(0,42) }}</dd></div><div><dt>执行模式</dt><dd>{{ modeLabel(draft.mode) }}</dd></div><div><dt>工作目录</dt><dd>{{ draft.cwd || '当前会话目录' }}</dd></div><div><dt>团队规模</dt><dd>{{ draft.roles.length }} 个角色</dd></div></dl>
        <div class="team"><div v-for="role in draft.roles" :key="role.id"><span :style="{background:role.color}"><CoomiIcon :name="role.icon" :size="15" /></span><p><strong>{{ role.name }}</strong><small>{{ role.modelSelector || '未选择模型' }}</small></p></div></div>
        <div v-if="draftStore.errors.length" class="validation"><p v-for="error in draftStore.errors" :key="error"><CoomiIcon name="alert" :size="14" />{{ error }}</p></div>
        <p v-if="collab.error" class="validation">{{ collab.error }}</p>
      </section>
    </div>
    <footer><button v-if="draftStore.step>1" class="secondary" @click="draftStore.step--">上一步</button><button v-if="draftStore.step<3" class="primary" @click="next">下一步<CoomiIcon name="arrowRight" :size="16" /></button><button v-else class="primary" :disabled="!draftStore.valid||collab.actionPending" @click="start"><CoomiIcon name="play" :size="15" />{{ collab.actionPending?'正在启动…':'启动团队' }}</button></footer>

    <div v-if="permAsk" class="perm-mask enter-flat" @click.self="permAsk=false">
      <div class="perm-sheet">
        <p class="perm-title">需要手机存储权限</p>
        <p class="perm-sub">未授权「所有文件访问」权限时，选择的工作目录可能无法被团队读取和写入。请前往系统设置授权后重试。</p>
        <button class="perm-primary" @click="openStorage">去授权</button>
        <button class="perm-cancel" @click="permAsk=false">取消</button>
      </div>
    </div>
  </main>
</template>

<style scoped>
.page{display:flex;flex-direction:column;height:100%;background:var(--page)}.steps{display:flex;padding: 11px 14px;background:var(--bg);border-bottom:1px solid var(--border)}.steps button{display:flex;align-items:center;justify-content:center;gap: 5px;flex:1;border:0;background:none;color:var(--text-3);font-size: var(--fs-caption)}.steps span{display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:var(--fill);font-size: var(--fs-caption)}.steps .on{color:var(--blue);font-weight: 600}.steps .on span,.steps .done span{background:var(--blue);color:#fff}.body{flex:1;overflow:auto;padding: 14px}.panel{max-width:620px;margin: auto;padding: 17px;border:1px solid var(--border);border-radius: var(--r-card);background:var(--bg);box-shadow:var(--shadow-1)}header{display:flex;gap: 11px;margin-bottom: 18px}.badge{display:grid;place-items:center;width:42px;height:42px;border-radius: var(--r-md);background:var(--blue-soft);color:var(--blue)}h2{margin: 1px 0 var(--sp-1);font-size: var(--fs-heading)}header p{margin: 0;color:var(--text-3);font-size: var(--fs-label);line-height: 1.4}label{display:flex;flex-direction:column;gap: 6px;margin: 13px 0;color:var(--text-2);font-size: var(--fs-label)}input,textarea{box-sizing:border-box;width:100%;padding: 10px var(--sp-3);border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text);font:inherit;font-size: var(--fs-sub);outline:0}textarea{line-height: 1.55;resize:vertical}input:focus,textarea:focus{border-color:var(--blue)}.mode{display:grid;grid-template-columns:1fr 1fr;gap: var(--sp-2)}.mode button{padding: var(--sp-3);border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text);text-align:left}.mode button.on{border-color:var(--blue);background:var(--blue-soft)}.mode button .mtop{display:flex;align-items:center;gap: 6px;margin-bottom: 2px}.mode button .beta{padding: 1px 6px;font-size: var(--fs-caption);font-weight:600;letter-spacing:.5px;border-radius: var(--r-pill);background:linear-gradient(135deg,#a78bfa,#60a5fa);color:#fff;line-height: 1.4}
.mode strong,.mode small{display:block}.mode small{margin-top: var(--sp-1);color:var(--text-3)}.presets{display:flex;gap: 7px;overflow:auto;margin-bottom: var(--sp-3)}.presets button,.add{white-space:nowrap;padding: var(--sp-2) 11px;border:1px solid var(--blue-border);border-radius: var(--r-md);background:var(--blue-soft);color:var(--blue);font-size: var(--fs-label)}.cwd-row{display:flex;gap: var(--sp-2)}.cwd-row input{flex:1;min-width:0}.cwd-row button{flex-shrink:0;display:inline-flex;align-items:center;gap: 5px;min-height:40px;padding: 0 var(--sp-3);border:1px solid var(--blue-border);border-radius: var(--r-md);background:var(--blue-soft);color:var(--blue);font-size: var(--fs-label);font-weight:600}.effort{display:flex;gap: 6px;flex-wrap:wrap}.effort button{padding: var(--sp-2) 14px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--fill);color:var(--text-2);font-size: var(--fs-label)}.effort button.on{border-color:var(--blue);background:var(--blue-soft);color:var(--blue)}.roles{display:flex;flex-direction:column;gap: 10px}.add{display:flex;align-items:center;justify-content:center;gap: 6px;width:100%;margin-top: 10px;border-style:dashed;background:transparent}.review dl{margin: 0;border:1px solid var(--border);border-radius: var(--r-md);overflow:hidden}.review dl div{display:grid;grid-template-columns:90px 1fr;padding: 10px var(--sp-3);border-bottom:1px solid var(--border);font-size: var(--fs-label)}.review dl div:last-child{border:0}.review dt{color:var(--text-3)}.review dd{margin: 0;overflow-wrap:anywhere}.team{display:grid;gap: var(--sp-2);margin-top: 14px}.team>div{display:flex;align-items:center;gap: 10px;padding: 9px;background:var(--fill);border-radius: var(--r-md)}.team>div>span{display:grid;place-items:center;width:32px;height:32px;border-radius: var(--r-md);color:#fff}.team p{margin: 0}.team strong,.team small{display:block}.team small{margin-top: 3px;color:var(--text-3);font-size: var(--fs-caption)}.validation{padding: 10px;margin-top: var(--sp-3);border-radius: var(--r-md);background:var(--danger-soft);color:var(--danger);font-size: var(--fs-label)}.validation p{display:flex;align-items:center;gap: 6px;margin: 3px}footer{display:flex;gap: 9px;padding: 10px 14px calc(10px + var(--safe-bottom));border-top:1px solid var(--border);background:var(--bg)}footer button{height:44px;border-radius: var(--r-md);font-weight: 600}.secondary{flex:1;border:1px solid var(--border);background:var(--fill);color:var(--text-2)}.primary{display:flex;align-items:center;justify-content:center;gap: 7px;flex:2;border:0;background:var(--blue);color:#fff}.primary:disabled{opacity:.45}
.perm-mask{position:fixed;inset:0;z-index: var(--z-toast);display:flex;align-items:center;justify-content:center;background:rgba(17,22,31,.4);padding: var(--sp-6)}
.perm-sheet{width:100%;max-width:320px;padding: var(--sp-5);border-radius: var(--r-card);background:var(--bg);box-shadow:var(--shadow-2);animation: modalIn var(--dur-base) var(--ease-out) backwards;/* modalIn 已收敛 global.css，遮罩淡入由 .enter-flat 类负责 */}
.perm-title{margin: 0;font-size: var(--fs-strong);font-weight: 600;color:var(--text)}
.perm-sub{margin: var(--sp-2) 0 18px;font-size: var(--fs-sub);line-height: 1.5;color:var(--text-2)}
.perm-primary,.perm-cancel{width:100%;min-height:44px;border:0;border-radius: var(--r-md);font-size: var(--fs-body);font-weight:600}
.perm-primary{background:var(--blue);color:#fff;margin-bottom: var(--sp-2)}
.perm-cancel{background:var(--fill);color:var(--text-2)}

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .perm-sheet { animation: none; }
}
:root[data-motion='off'] .perm-sheet { animation: none; }
</style>
