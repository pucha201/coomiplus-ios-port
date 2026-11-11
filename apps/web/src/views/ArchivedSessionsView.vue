<script setup lang="ts">
/**
 * 已归档会话：侧栏「已归档」进来。
 *
 * 只做两件事：恢复（取消归档）与删除。归档不是删除，恢复后回到原来的分组。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { formatSessionTime, useSessionsStore, type SessionMeta } from '@/stores/sessions'
import { useSessionStore } from '@/stores/session'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SheetShell from '@/components/settings/SheetShell.vue'

const router = useRouter()
const sessions = useSessionsStore()
const session = useSessionStore()

const rows = computed(() => sessions.archived)
const target = ref<SessionMeta | null>(null)
const busy = ref(false)

function back() { goBack(router, '/settings') }

async function restore(item: SessionMeta): Promise<void> {
  busy.value = true
  try { await sessions.setArchived(item.id, false) } finally { busy.value = false }
  target.value = null
}

async function remove(item: SessionMeta): Promise<void> {
  if (!confirm(`删除「${item.title || '新对话'}」？会话内容会一起删除，不可恢复。`)) return
  session.deleteSession(item.id)
  target.value = null
}
</script>

<template>
  <SettingsPage title="已归档" :subtitle="`${rows.length} 个会话`" :back="back">
    <SettingsGroup v-if="rows.length" title="会话">
      <SettingsRow
        v-for="item in rows"
        :key="item.id"
        icon="chat"
        :title="item.title || '新对话'"
        :subtitle="formatSessionTime(item.updatedAt)"
        chevron
        @click="target = item"
      />
    </SettingsGroup>

    <SettingsGroup v-else title="没有已归档的会话">
      <p class="empty">在侧栏点会话右侧「更多」→「归档」，它会被收进这里，随时可以恢复。</p>
    </SettingsGroup>

    <p class="foot">归档只是从列表里收起来，不会删除任何内容。</p>

    <SheetShell v-if="target" :title="target.title || '新对话'" @close="target = null">
      <button class="item" type="button" :disabled="busy" @click="restore(target)">
        <span class="t">恢复</span>
        <span class="s">回到原来的位置继续用</span>
      </button>
      <button class="item danger" type="button" @click="remove(target)">
        <span class="t">删除</span>
        <span class="s">永久删除会话内容</span>
      </button>
    </SheetShell>
  </SettingsPage>
</template>

<style scoped>
.empty { margin: 0; padding: var(--sp-4); text-align: center; font-size: var(--fs-sub); line-height: 1.6; color: var(--text-3); }
.foot { margin: var(--sp-6) 0 0; text-align: center; font-size: var(--fs-caption); color: var(--text-3); }
.item { display: flex; flex-direction: column; gap: 1px; width: 100%; padding: var(--sp-3) var(--sp-2); text-align: left; }
.item .t { font-size: var(--fs-body); color: var(--text); }
.item .s { font-size: var(--fs-label); color: var(--text-3); }
.item.danger .t { color: var(--danger); }
</style>
