import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import type { CollabRole, CollabTask } from '../types/collab'

const KEY = 'coomi.collab.draft.v3'

interface DraftState {
  title: string
  objective: string
  cwd: string
  mode: CollabTask['mode']
  roles: CollabRole[]
}

const emptyDraft = (): DraftState => ({
  title: '',
  objective: '',
  cwd: '',
  mode: 'parallel',
  roles: [],
})

export const useCollabDraftStore = defineStore('collab-draft', () => {
  const draft = ref<DraftState>(loadDraft())
  const step = ref(1)
  const errors = computed(() => {
    const result: string[] = []
    if (draft.value.objective.trim().length < 4) result.push('请填写至少 4 个字的任务目标')
    if (draft.value.roles.length < 2) result.push('至少需要 2 个团队角色')
    if (draft.value.roles.some(role => !role.name.trim() || !role.prompt.trim() || !role.modelSelector)) result.push('请补全每个角色的名称、模型和职责')
    return result
  })
  const valid = computed(() => errors.value.length === 0)

  watch(draft, value => {
    try { localStorage.setItem(KEY, JSON.stringify(value)) } catch { /* storage unavailable */ }
  }, { deep: true })

  function reset() {
    draft.value = emptyDraft()
    step.value = 1
    try { localStorage.removeItem(KEY) } catch { /* storage unavailable */ }
  }

  function setRoles(roles: CollabRole[]) { draft.value.roles = roles.map(role => ({ ...role })) }

  /** 从已有任务载入配置（编辑角色 / 新建叠加角色用），保证 ≥2 个角色。 */
  function loadFromTask(task: CollabTask) {
    const roles = (task.roles || []).map(r => ({ ...r }))
    while (roles.length < 2) {
      roles.push({
        id: `role_extra_${roles.length}_${Date.now()}`,
        name: roles.length === 0 ? '执行者' : '协作角色',
        modelSelector: roles[0]?.modelSelector || '',
        prompt: '在职责范围内完成子任务，报告可验证结果。',
        color: roles.length === 0 ? '#2d61c6' : '#1f9d6b',
        icon: 'agent',
        visibility: 'full',
      })
    }
    draft.value = {
      title: task.title,
      objective: task.objective,
      cwd: task.cwd,
      mode: task.mode,
      roles,
    }
    step.value = 2
  }

  return { draft, step, errors, valid, reset, setRoles, loadFromTask }
})

function loadDraft(): DraftState {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) || 'null') as Partial<DraftState> | null
    return value ? { ...emptyDraft(), ...value, roles: Array.isArray(value.roles) ? value.roles : [] } : emptyDraft()
  } catch { return emptyDraft() }
}
