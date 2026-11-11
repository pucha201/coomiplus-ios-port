<script setup lang="ts">
/**
 * 备份还原（原 CoomiBackupActivity）。
 * 立即备份 / 自动备份 / 还原三块。定时调度在原生（WorkManager），
 * 这里只读写原生偏好并触发一次立即备份。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SegmentedPill from '@/components/settings/SegmentedPill.vue'
import OverviewCard from '@/components/settings/OverviewCard.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()

interface BackupState {
  enabled?: boolean
  directory?: string
  intervalHours?: number
  keepCount?: number
  charging?: boolean
  wifi?: boolean
  lastSuccess?: number
  lastSize?: number
  lastError?: string
  nextRun?: number
  running?: boolean
  percent?: number
}

const state = ref<BackupState>({})
const message = ref('')
const error = ref('')
const supported = computed(() => typeof window !== 'undefined' && !!window.CoomiAndroid?.backupGetState)

function load() {
  try {
    const raw = window.CoomiAndroid?.backupGetState?.()
    state.value = raw ? JSON.parse(raw) as BackupState : {}
  } catch {
    state.value = {}
  }
}
onMounted(load)

const lastLabel = computed(() => {
  const t = state.value.lastSuccess
  if (!t) return '还没有备份过'
  const d = new Date(t)
  const size = state.value.lastSize ? ` · ${formatSize(state.value.lastSize)}` : ''
  return `${d.toLocaleString()}${size}`
})

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function configure(patch: Partial<BackupState>) {
  state.value = { ...state.value, ...patch }
  try {
    window.CoomiAndroid?.backupConfigure?.(JSON.stringify(state.value))
    error.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  }
}

function pickDirectory() {
  window.CoomiAndroid?.backupPickDirectory?.()
}

function runNow() {
  if (!state.value.directory) { error.value = '请先选择备份目录'; return }
  message.value = ''
  error.value = ''
  window.CoomiAndroid?.backupRunNow?.()
  message.value = '已开始备份'
}

function restore() {
  window.CoomiAndroid?.backupRestore?.('')
}

const intervals = [
  { value: 6, label: '6 小时' },
  { value: 12, label: '12 小时' },
  { value: 24, label: '每天' },
  { value: 72, label: '3 天' },
  { value: 168, label: '7 天' },
]
const keeps = [
  { value: 3, label: '3 份' },
  { value: 5, label: '5 份' },
  { value: 10, label: '10 份' },
  { value: 20, label: '20 份' },
]

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="备份与还原" subtitle="会话、拓展、MCP 与厂商配置（密钥打码）" :back="back">
    <template v-if="supported">
      <OverviewCard
        icon="fileWrite"
        :title="state.lastSuccess ? '上次备份' : '还没有备份'"
        :subtitle="lastLabel"
        :footer="state.directory ? state.directory : '未选择目录'"
        :online="!!state.lastSuccess && !state.lastError"
        :footer-tail="state.running ? `${state.percent ?? 0}%` : undefined"
        :chevron="false"
      />

      <SettingsGroup title="立即备份">
        <SettingsRow icon="folder" title="备份目录" :subtitle="state.directory || '点击选择'" chevron @click="pickDirectory" />
        <div class="pad">
          <button class="primary wide" type="button" :disabled="state.running" @click="runNow">
            <CoomiIcon name="fileWrite" :size="17" />{{ state.running ? '备份中…' : '立即备份' }}
          </button>
        </div>
      </SettingsGroup>

      <p v-if="message" class="notice ok">{{ message }}</p>
      <p v-if="error || state.lastError" class="notice err">{{ error || state.lastError }}</p>

      <SettingsGroup title="自动备份">
        <SettingsRow
          icon="clock"
          title="自动备份"
          subtitle="按固定间隔在充电 / Wi-Fi 条件下运行"
          :switch-state="(!!state.enabled) ? 'on' : 'off'"
          @update:switch="(v: 'on' | 'off') => configure({ enabled: v === 'on' })"
        />
        <div v-if="state.enabled" class="pad">
          <p class="field-label">频率</p>
          <SegmentedPill
            :options="intervals"
            :model-value="state.intervalHours ?? 24"
            @update:model-value="v => configure({ intervalHours: Number(v) })"
          />
          <p class="field-label gap">保留份数</p>
          <SegmentedPill
            :options="keeps"
            :model-value="state.keepCount ?? 5"
            @update:model-value="v => configure({ keepCount: Number(v) })"
          />
        </div>
        <SettingsRow
          v-if="state.enabled"
          icon="plug"
          title="仅充电时备份"
          subtitle="省电，跑得晚一点"
          :switch-state="(!!state.charging) ? 'on' : 'off'"
          @update:switch="(v: 'on' | 'off') => configure({ charging: v === 'on' })"
        />
        <SettingsRow
          v-if="state.enabled"
          icon="globe"
          title="仅 Wi-Fi 时备份"
          subtitle="避免消耗流量"
          :switch-state="(!!state.wifi) ? 'on' : 'off'"
          @update:switch="(v: 'on' | 'off') => configure({ wifi: v === 'on' })"
        />
      </SettingsGroup>

      <SettingsGroup title="还原">
        <SettingsRow
          icon="arrowDown"
          title="从备份恢复"
          subtitle="选择备份 zip；当前数据会被覆盖"
          tone="danger"
          chevron
          @click="restore"
        />
      </SettingsGroup>

      <p class="foot">备份只存本机，不上传。恢复后请重启引擎。</p>
    </template>

    <SettingsGroup v-else title="备份">
      <p class="empty">备份需要在手机 App 里使用。</p>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.pad { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.field-label { margin: 0; font-size: var(--fs-label); color: var(--text-3); }
.field-label.gap { margin-top: var(--sp-3); }
.primary {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-1);
  min-height: 46px; border-radius: var(--r-md); background: var(--blue); color: #fff;
  font-size: var(--fs-sub); font-weight: 600;
}
.primary:disabled { opacity: .55; }
.wide { width: 100%; }
.notice { margin: var(--sp-3) 0 0; padding: 10px var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-label); line-height: 1.5; }
.notice.ok { color: var(--ok); background: var(--ok-soft); }
.notice.err { color: var(--danger); background: var(--danger-soft); }
.empty { margin: 0; padding: var(--sp-4); text-align: center; font-size: var(--fs-sub); color: var(--text-3); }
.foot { margin: var(--sp-7) 0 0; text-align: center; font-size: var(--fs-caption); color: var(--text-3); }
</style>
