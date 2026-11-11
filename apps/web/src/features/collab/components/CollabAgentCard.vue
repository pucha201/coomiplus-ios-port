<script setup lang="ts">
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { CollabAgent, CollabRole } from '../types/collab'
import { agentStatusLabel } from '../utils/collabFormat'

defineProps<{ role: CollabRole; agent?: CollabAgent; selected?: boolean }>()
const emit = defineEmits<{ select: [] }>()
</script>

<template>
  <button class="agent" :class="[agent?.status || 'pending', { selected }]" :style="{ '--role': role.color }" @click="emit('select')">
    <span class="avatar"><CoomiIcon :name="role.icon || 'agent'" :size="18" /></span>
    <span class="copy">
      <strong>{{ role.name }}</strong>
      <small>{{ agentStatusLabel[agent?.status || 'pending'] }}</small>
      <span>{{ agent?.currentMessage || '等待调度' }}</span>
    </span>
    <span v-if="agent?.status === 'running'" class="sk run-ring" />
    <CoomiIcon v-else name="chevronRight" :size="15" />
  </button>
</template>

<style scoped>
.agent{display:flex;align-items:center;gap: 10px;width:100%;padding: 11px;border:1px solid var(--border);border-radius: var(--r-md);background:var(--bg-card);text-align:left;color:var(--text)}.agent.selected{border-color:var(--role);box-shadow:0 0 0 2px color-mix(in srgb,var(--role) 15%,transparent)}.avatar{display:grid;place-items:center;width:36px;height:36px;border-radius: var(--r-md);background:color-mix(in srgb,var(--role) 14%,var(--bg));color:var(--role);flex:none}.copy{display:grid;grid-template-columns:auto 1fr;gap: 2px var(--sp-2);min-width:0;flex:1}.copy strong{font-size: var(--fs-sub)}.copy small{font-size: var(--fs-caption);color:var(--text-3);align-self:center}.copy>span{grid-column:1/-1;color:var(--text-2);font-size: var(--fs-caption);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.run-ring{width:14px;height:14px;border-radius:50%;flex:none}/* 骨架替代转圈：agent 运行中指示改用 .sk 骨架脉冲（只换视觉，不改逻辑）；spin 定义已删。 */
</style>
