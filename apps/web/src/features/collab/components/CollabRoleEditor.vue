<script setup lang="ts">
import { computed } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import type { CollabRole } from '../types/collab'

const props = defineProps<{ role: CollabRole; index: number; models: Array<{ value: string; label: string }> }>()
const emit = defineEmits<{ remove: []; move: [direction: -1 | 1] }>()

const allowedPathsText = computed({
  get: () => (props.role.allowedPaths ?? []).join(', '), set: (v: string) => {
    props.role.allowedPaths = v.split(',').map(s => s.trim()).filter(Boolean)
  },
})
const forbiddenPathsText = computed({
  get: () => (props.role.forbiddenPaths ?? []).join(', '), set: (v: string) => {
    props.role.forbiddenPaths = v.split(',').map(s => s.trim()).filter(Boolean)
  },
})

const modelOptions = computed(() => [
  { value: '', label: '请选择可用模型' },
  ...props.models,
])
const typeOptions = [
  { value: '', label: '通用' },
  { value: 'commander', label: '指挥官' },
  { value: 'architect', label: '架构师' },
  { value: 'developer', label: '开发者' },
  { value: 'reviewer', label: '审查员' },
  { value: 'tester', label: '测试员' },
]
</script>

<template>
  <article class="role" :style="{ '--role': role.color }">
    <header><span class="number">{{ index + 1 }}</span><input v-model="role.name" aria-label="角色名称" /><button @click="emit('move', -1)">↑</button><button @click="emit('move', 1)">↓</button><button class="danger" @click="emit('remove')"><CoomiIcon name="trash" :size="15" /></button></header>
    <label>模型<UiSelect v-model="role.modelSelector" :options="modelOptions" block placeholder="请选择可用模型" /></label>
    <label>岗位职责<textarea v-model="role.prompt" rows="4" placeholder="描述角色的职责、边界和交付标准" /></label>
    <div class="footer">
      <label>类型<UiSelect :model-value="role.roleType || ''" :options="typeOptions" block @update:model-value="v => role.roleType = (v || undefined) as any" /></label>
      <label class="check"><input v-model="role.visibility" type="radio" value="summary" />仅展示摘要</label>
    </div>
    <label>允许写入路径（逗号分隔，空=不限）<input v-model="allowedPathsText" placeholder="src/components,src/stores" /></label>
    <label>禁止写入路径（逗号分隔）<input v-model="forbiddenPathsText" placeholder="tests, .coomi" /></label>
  </article>
</template>

<style scoped>
.role{padding: 13px;border:1px solid var(--border);border-left:3px solid var(--role);border-radius:var(--r-md);background:var(--bg-card)}header{display:flex;align-items:center;gap: 6px;margin-bottom: 10px}.number{display:grid;place-items:center;width:24px;height:24px;border-radius: var(--r-sm);background:var(--role);color:white;font-size: var(--fs-caption);font-weight:700}header input{flex:1;min-width:0;font-weight: 600}button{width:29px;height:29px;border:1px solid var(--border);border-radius: var(--r-sm);background:var(--fill);color:var(--text-2)}button.danger{color:var(--danger)}label{display:flex;flex-direction:column;gap: 5px;margin-top: 9px;color:var(--text-2);font-size: var(--fs-caption)}input,textarea{box-sizing:border-box;width:100%;border:1px solid var(--border);border-radius: var(--r-sm);background:var(--fill);color:var(--text);font:inherit;font-size: var(--fs-sub);outline:none}input{height:38px;padding: 0 10px}textarea{padding: 9px 10px;resize:vertical;line-height: 1.45}.footer{display:flex;align-items:end;gap: 10px}.footer>label:first-child{flex:1}.check{flex-direction:row;align-items:center;height:38px;white-space:nowrap}.check input{width:auto;height:auto}
</style>
