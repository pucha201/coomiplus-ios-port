<script setup lang="ts">
/**
 * 连接与重试（设置首页 › 连接 › 高级）。
 * 原设置页里的数字表单集中到这里，首页不再铺开。
 */
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { useConfigStore, DEFAULT_CONNECTION_SETTINGS, type ConnectionSettings } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import FieldRow from '@/components/settings/FieldRow.vue'

const router = useRouter()
const config = useConfigStore()
const session = useSessionStore()

const draft = ref<ConnectionSettings>({ ...config.connectionSettings })
const initialSeconds = ref(config.connectionSettings.reconnectInitialDelayMs / 1000)
const maxSeconds = ref(config.connectionSettings.reconnectMaxDelayMs / 1000)
const error = ref('')
const saved = ref(false)

function reset() {
  draft.value = { ...DEFAULT_CONNECTION_SETTINGS }
  initialSeconds.value = DEFAULT_CONNECTION_SETTINGS.reconnectInitialDelayMs / 1000
  maxSeconds.value = DEFAULT_CONNECTION_SETTINGS.reconnectMaxDelayMs / 1000
  void save()
}

async function save() {
  error.value = ''
  saved.value = false
  const integer = (v: number) => Number.isInteger(v)
  if (!integer(draft.value.providerRetryCount) || draft.value.providerRetryCount < 0 || draft.value.providerRetryCount > 10) {
    error.value = '模型重试次数需为 0 - 10 的整数'; return
  }
  if (!integer(draft.value.maxConcurrentTasks) || draft.value.maxConcurrentTasks < 1 || draft.value.maxConcurrentTasks > 20) {
    error.value = '会话并发数需为 1 - 20 的整数'; return
  }
  if (!integer(draft.value.wsRetryCount) || draft.value.wsRetryCount < 0 || draft.value.wsRetryCount > 30) {
    error.value = 'WebSocket 重连次数需为 0 - 30 的整数'; return
  }
  if (!Number.isFinite(initialSeconds.value) || initialSeconds.value < 0.5 || initialSeconds.value > 60) {
    error.value = '首次重连间隔需在 0.5 - 60 秒之间'; return
  }
  if (!Number.isFinite(maxSeconds.value) || maxSeconds.value < 1 || maxSeconds.value > 120) {
    error.value = '最大重连间隔需在 1 - 120 秒之间'; return
  }
  if (maxSeconds.value < initialSeconds.value) {
    error.value = '最大重连间隔不能小于首次重连间隔'; return
  }
  const value: ConnectionSettings = {
    ...draft.value,
    reconnectInitialDelayMs: Math.round(initialSeconds.value * 1000),
    reconnectMaxDelayMs: Math.round(maxSeconds.value * 1000),
  }
  if (await config.saveConnectionSettings(value)) {
    draft.value = { ...config.connectionSettings }
    saved.value = true
    session.reconnect()
  } else error.value = '保存失败，请确认引擎已连接'
}

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="连接与重试" subtitle="瞬时故障时的重试策略，重启引擎后生效" :back="back">
    <SettingsGroup title="重试">
      <div class="pad">
        <FieldRow label="模型重试次数" hint="0 表示不重试">
          <input v-model.number="draft.providerRetryCount" type="number" min="0" max="10" step="1" inputmode="numeric" />
        </FieldRow>
        <FieldRow label="会话并发数" hint="同时运行的会话任务">
          <input v-model.number="draft.maxConcurrentTasks" type="number" min="1" max="20" step="1" inputmode="numeric" />
        </FieldRow>
      </div>
    </SettingsGroup>

    <SettingsGroup title="重连">
      <div class="pad">
        <FieldRow label="WebSocket 重连次数" hint="界面与引擎断开后的尝试次数">
          <input v-model.number="draft.wsRetryCount" type="number" min="0" max="30" step="1" inputmode="numeric" />
        </FieldRow>
        <FieldRow label="首次重连间隔（秒）" hint="0.5 - 60">
          <input v-model.number="initialSeconds" type="number" min="0.5" max="60" step="0.5" inputmode="decimal" />
        </FieldRow>
        <FieldRow label="最大重连间隔（秒）" hint="1 - 120">
          <input v-model.number="maxSeconds" type="number" min="1" max="120" step="0.5" inputmode="decimal" />
        </FieldRow>
      </div>
    </SettingsGroup>

    <p v-if="error" class="notice err">{{ error }}</p>
    <p v-else-if="saved" class="notice ok">已保存并重新连接</p>

    <div class="actions">
      <button class="ghost" type="button" @click="reset">恢复默认</button>
      <button class="primary" type="button" @click="save">保存</button>
    </div>
  </SettingsPage>
</template>

<style scoped>
.pad { padding: var(--sp-2) var(--sp-4) var(--sp-4); }
.notice { margin: var(--sp-3) 0 0; padding: 10px var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-label); line-height: 1.5; }
.notice.ok { color: var(--ok); background: var(--ok-soft); }
.notice.err { color: var(--danger); background: var(--danger-soft); }
.actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-5); }
.ghost, .primary { flex: 1; min-height: 46px; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.ghost { background: var(--fill); color: var(--text); }
.primary { background: var(--blue); color: #fff; }
</style>
