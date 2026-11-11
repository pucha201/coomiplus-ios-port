<script setup lang="ts">
/** 通讯录：项目内身份列表，点击进单聊，可删除角色。 */
import CoomiIcon from '@/components/CoomiIcon.vue'
import type { Identity } from '../types'

defineProps<{
  identities: Identity[]
}>()

const emit = defineEmits<{
  open: [id: string, el?: Event]
  remove: [id: string, name: string]
}>()
</script>

<template>
  <div class="list">
    <p v-if="!identities.length" class="empty-sm">还没有成员，先创建群聊吧</p>
    <div
      v-for="m in identities"
      :key="m.id"
      class="row enter-item"
      role="button"
      tabindex="0"
      @click="emit('open', m.id, $event)"
      @keydown.enter="emit('open', m.id, $event)"
    >
      <span class="avatar" :style="{ background: m.color }">{{ m.name.charAt(0) }}</span>
      <span class="meta">
        <strong>{{ m.name }}</strong>
        <small>{{ m.roomIds?.length ? `${m.roomIds.length} 个群` : '未入群' }}</small>
      </span>
      <button
        class="del"
        type="button"
        aria-label="删除角色"
        @click.stop="emit('remove', m.id, m.name)"
      >
        <CoomiIcon name="more" :size="16" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.list { padding: var(--sp-1) 14px var(--sp-3); }

.row {
  display: flex; align-items: center; gap: var(--sp-3);
  padding: 11px 0; border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
}
.row:last-child { border-bottom: 0; }
.row:active { background: var(--fill); }
.avatar {
  width: 42px; height: 42px; border-radius: var(--r-md);
  display: grid; place-items: center;
  color: #fff; font-weight: 700; font-size: var(--fs-strong);
  flex-shrink: 0;
}
.meta { flex: 1; min-width: 0; }
.meta strong {
  display: block; font-size: var(--fs-body); font-weight: 600;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.meta small { font-size: var(--fs-caption); color: var(--text-3); }
.del {
  border: 0; background: transparent;
  color: var(--text-3); cursor: pointer;
  width: 32px; height: 32px; border-radius: var(--r-sm);
  display: grid; place-items: center;
  transition: background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
}
.del:active { background: var(--fill); color: var(--text-2); }
</style>
