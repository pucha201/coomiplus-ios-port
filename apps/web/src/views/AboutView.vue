<script setup lang="ts">
/**
 * 关于（原 CoomiAppInfoActivity + CoomiUpdateActivity 的版本块）。
 * 应用信息、引擎状态、系统入口、诊断复制。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { apiGet } from '@/bridge/http'
import { useConnectionStore } from '@/stores/connection'
import { useDeviceStore } from '@/stores/device'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import OverviewCard from '@/components/settings/OverviewCard.vue'

const router = useRouter()
const connection = useConnectionStore()
const device = useDeviceStore()

const versionName = ref('')
const versionCode = ref(0)
const engineVersion = ref('')
const uptime = ref('')
const copied = ref(false)

onMounted(async () => {
  try {
    versionName.value = window.CoomiAndroid?.getAppVersionName?.() ?? ''
    versionCode.value = window.CoomiAndroid?.getAppVersionCode?.() ?? 0
  } catch { /* 网页预览 */ }
  try {
    const health = await apiGet<{ version?: string; uptimeSec?: number }>('/api/runtime/health')
    engineVersion.value = health?.version ?? ''
    if (typeof health?.uptimeSec === 'number') uptime.value = formatUptime(health.uptimeSec)
  } catch { /* 引擎未连接时留空 */ }
})

function formatUptime(sec: number): string {
  const h = Math.floor(sec / 3600)
  const m = Math.floor((sec % 3600) / 60)
  return h > 0 ? `${h} 小时 ${m} 分` : `${m} 分钟`
}

const versionLabel = computed(() => {
  if (!versionName.value) return '未知'
  return versionCode.value ? `${versionName.value} (${versionCode.value})` : versionName.value
})

const hasBridge = computed(() => typeof window !== 'undefined' && !!window.CoomiAndroid?.openAppInfo)

function copyDiag() {
  const lines = [
    `应用：${versionLabel.value}`,
    `引擎：${engineVersion.value || '未知'}`,
    `模式：${device.mode}`,
    `设备：${device.activeDevice?.name || '未选择'}（${device.deviceId || '-'}）`,
    `端点：${device.engineBase || '同源'}`,
    `令牌：${device.tokenStatus.configured ? '已配置' : '缺失'}`,
    `通道：${connection.label}`,
    `最后错误：${device.engineStatus?.error || connection.attribution?.detail || '无'}`,
  ]
  const text = lines.join('\n')
  if (window.CoomiAndroid?.copyText) window.CoomiAndroid.copyText(text)
  else void navigator.clipboard?.writeText(text)
  copied.value = true
  window.setTimeout(() => { copied.value = false }, 1600)
}

/** 系统入口：桥不存在时静默（浏览器预览）。 */
type BridgeMethod = 'openNotificationSettings' | 'requestBatteryExemption' | 'openAppInfo'
function openBridge(name: BridgeMethod) {
  window.CoomiAndroid?.[name]?.()
}

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="关于" :back="back">
    <OverviewCard
      icon="sparkle"
      title="CoomiPlus"
      :subtitle="versionLabel"
      :footer="engineVersion ? `引擎 ${engineVersion}${uptime ? ' · ' + uptime : ''}` : '引擎未连接'"
      :online="connection.isOpen"
      :chevron="false"
    />

    <SettingsGroup title="应用">
      <SettingsRow icon="arrowDown" title="检查更新" subtitle="获取最新版本" chevron @click="router.push('/updates')" />
      <SettingsRow
        icon="terminal"
        title="运行环境"
        :subtitle="`${device.mode === 'local' ? '本机' : '远程'} · ${connection.label}`"
        chevron
        @click="router.push('/runtime')"
      />
    </SettingsGroup>

    <SettingsGroup v-if="hasBridge" title="系统">
      <SettingsRow icon="plug" title="通知权限" subtitle="任务完成与后台提醒" chevron @click="openBridge('openNotificationSettings')" />
      <SettingsRow icon="plug" title="电池优化" subtitle="加入白名单，避免后台被清理" chevron @click="openBridge('requestBatteryExemption')" />
      <SettingsRow icon="phone" title="应用信息" subtitle="权限 · 存储 · 卸载" chevron @click="openBridge('openAppInfo')" />
    </SettingsGroup>

    <SettingsGroup title="诊断">
      <SettingsRow
        icon="copy"
        title="复制诊断信息"
        :subtitle="copied ? '已复制到剪贴板' : '版本、通道、探活与最后错误'"
        :value="copied ? '已复制' : undefined"
        tone="ok"
        @click="copyDiag"
      />
    </SettingsGroup>

    <p class="foot">CoomiPlus · 手机端</p>
  </SettingsPage>
</template>

<style scoped>
.foot { margin: var(--sp-7) 0 0; text-align: center; font-size: var(--fs-caption); color: var(--text-3); }
</style>
