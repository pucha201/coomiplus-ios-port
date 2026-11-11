<script setup lang="ts">
/** 项目切换条：显示当前项目，点击打开项目列表。 */
import CoomiIcon from '@/components/CoomiIcon.vue'

defineProps<{
  name: string
  roomCount?: number
  projectCount?: number
}>()

defineEmits<{ open: [] }>()
</script>

<template>
  <button class="proj-bar" type="button" @click="$emit('open')">
    <span class="pi"><CoomiIcon name="folder" :size="13" /></span>
    <span class="name">{{ name }}</span>
    <span v-if="projectCount && projectCount > 1" class="count">{{ projectCount }} 个项目</span>
    <span v-else-if="roomCount != null" class="count">{{ roomCount }} 群</span>
    <CoomiIcon name="chevronRight" :size="14" class="chev" />
  </button>
</template>

<style scoped>
.proj-bar {
  display: flex; align-items: center; gap: var(--sp-2);
  margin: var(--sp-2) 14px 2px; padding: 0 10px 0 var(--sp-2);
  height: 36px; border-radius: var(--r-md);
  background: var(--fill); color: var(--text);
  font-size: var(--fs-label); border: 1px solid transparent;
  cursor: pointer; width: calc(100% - 28px);
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}
.proj-bar:active { transform: scale(var(--press-scale)); background: var(--fill-press); }
.pi {
  width: 22px; height: 22px; border-radius: var(--r-sm);
  display: grid; place-items: center; flex-shrink: 0;
  background: var(--blue-soft); color: var(--blue);
}
.name {
  flex: 1; min-width: 0; font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.count { font-size: var(--fs-caption); color: var(--text-3); flex-shrink: 0; }
.chev { color: var(--text-3); flex-shrink: 0; }
</style>
