<script setup lang="ts">
/**
 * 通用设置（设置首页 › 通用）。
 * 运行环境、语音引擎、匿名统计、本地留痕、启动首页、系统入口。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { authedFetch } from '@/bridge/http'
import { useConfigStore } from '@/stores/config'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SegmentedPill from '@/components/settings/SegmentedPill.vue'

const router = useRouter()
const config = useConfigStore()

const ENV_MODES = [
  { value: 'auto', label: '自动' },
  { value: 'proot', label: 'PROOT' },
  { value: 'termux', label: 'Termux' },
  { value: 'host', label: '宿主机' },
]
const envMode = ref('auto')
function loadEnvMode() {
  try { envMode.value = window.CoomiAndroid?.getEnvMode?.() ?? 'auto' } catch { /* 非原生壳 */ }
}
loadEnvMode()
function pickEnvMode(value: string) {
  envMode.value = value
  try { window.CoomiAndroid?.setEnvMode?.(value) } catch { /* 非原生壳 */ }
}
const envLabel = computed(() => ENV_MODES.find(m => m.value === envMode.value)?.label ?? '自动')

const VOICE_ENGINES = [
  { value: 'vosk', label: '内置流式识别', desc: '离线，首次使用自动准备' },
  { value: 'cloud', label: '云语音模型', desc: 'Whisper 兼容接口' },
  { value: 'system', label: '系统语音服务', desc: '部分机型可用' },
]
const voiceEngine = ref('unset')
try {
  const raw = window.CoomiAndroid?.getVoiceConfig?.()
  if (raw) voiceEngine.value = JSON.parse(raw)?.engine ?? 'unset'
} catch { /* 忽略 */ }
function pickVoiceEngine(value: string) {
  voiceEngine.value = value
  try { window.CoomiAndroid?.setVoiceEngine?.(value) } catch { /* 忽略 */ }
}
const voiceLabel = computed(() => VOICE_ENGINES.find(v => v.value === voiceEngine.value)?.label ?? '未启用')

const telemetryEnabled = ref(true)
const telemetryError = ref('')
async function toggleTelemetry() {
  telemetryError.value = ''
  try {
    const res = await authedFetch('/api/settings/telemetry', {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ enabled: !telemetryEnabled.value }),
    })
    const text = await res.text()
    let data: any = {}
    try { data = text ? JSON.parse(text) : {} } catch { data = null }
    if (data === null) throw new Error(`电脑端返回了非 JSON 响应（HTTP ${res.status}），请检查连接`)
    if (!res.ok) throw new Error(data?.error ?? data?.message ?? `设置失败（HTTP ${res.status}）`)
    telemetryEnabled.value = data.enabled ?? !telemetryEnabled.value
  } catch (e) { telemetryError.value = `设置失败：${e instanceof Error ? e.message : String(e)}` }
}

const traceError = ref('')
const traceMaxDraft = ref(config.localTraceMaxMb)
async function toggleLocalTrace() {
  traceError.value = ''
  if (!await config.saveLocalTraceSettings({ localTraceEnabled: !config.localTraceEnabled })) {
    traceError.value = '设置失败，请确认引擎已连接'
    return
  }
  traceMaxDraft.value = config.localTraceMaxMb
}
async function commitTraceMax() {
  traceError.value = ''
  if (!await config.saveLocalTraceSettings({ localTraceMaxMb: traceMaxDraft.value })) {
    traceError.value = '设置失败，请确认引擎已连接'
    return
  }
  traceMaxDraft.value = config.localTraceMaxMb
}
const traceLabel = computed(() => config.localTraceEnabled
  ? (config.localTraceMaxMb > 0 ? `开 · ${config.localTraceMaxMb} MB` : '开 · 不限')
  : '关')

/** 启动首页（原生偏好）。 */
const homeRoute = ref('chat')
try { homeRoute.value = window.CoomiAndroid?.getHomeRoute?.() ?? 'chat' } catch { /* 忽略 */ }
function pickHome(value: string | number) {
  homeRoute.value = String(value)
  try { window.CoomiAndroid?.setHomeRoute?.(homeRoute.value) } catch { /* 忽略 */ }
}
const homeSupported = computed(() => typeof window !== 'undefined' && !!window.CoomiAndroid?.getHomeRoute)

const hasSystemBridge = computed(() => typeof window !== 'undefined' && !!window.CoomiAndroid?.openAppInfo)

type SystemBridge = 'openNotificationSettings' | 'requestBatteryExemption' | 'openAppInfo'
function openSystem(name: SystemBridge) {
  window.CoomiAndroid?.[name]?.()
}

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="通用" :back="back">
    <SettingsGroup title="运行环境">
      <div class="pad">
        <p class="label">命令在哪个环境里执行 <span class="value">{{ envLabel }}</span></p>
        <SegmentedPill :options="ENV_MODES" :model-value="envMode" @update:model-value="v => pickEnvMode(String(v))" />
        <p class="hint">下次启动引擎生效</p>
      </div>
      <SettingsRow icon="terminal" title="运行时" subtitle="健康、诊断、镜像测速与日志" chevron @click="router.push('/runtime')" />
    </SettingsGroup>

    <SettingsGroup title="语音">
      <div class="pad">
        <p class="label">语音输入引擎 <span class="value">{{ voiceLabel }}</span></p>
        <div class="opts">
          <button
            v-for="o in VOICE_ENGINES"
            :key="o.value"
            class="opt"
            type="button"
            :class="{ on: voiceEngine === o.value }"
            @click="pickVoiceEngine(o.value)"
          >
            <span class="opt-main">
              <span class="opt-name">{{ o.label }}</span>
              <span class="opt-desc">{{ o.desc }}</span>
            </span>
            <span v-if="voiceEngine === o.value" class="dot" />
          </button>
        </div>
      </div>
    </SettingsGroup>

    <SettingsGroup title="隐私">
      <SettingsRow
        icon="eye"
        title="匿名使用统计"
        :subtitle="telemetryError || (telemetryEnabled ? '仅上报拓展安装与使用次数，不含对话内容' : '已关闭，不再上报')"
        :subtitle-danger="!!telemetryError"
        :switch-state="(telemetryEnabled) ? 'on' : 'off'"
        @update:switch="() => toggleTelemetry()"
      />
      <SettingsRow
        icon="fileWrite"
        title="本地留痕"
        :subtitle="traceError || (config.localTraceEnabled ? '只存本机，不上传' : '已关闭，不再写入轨迹')"
        :subtitle-danger="!!traceError"
        :value="traceLabel"
        :switch-state="(config.localTraceEnabled) ? 'on' : 'off'"
        @update:switch="() => toggleLocalTrace()"
      />
      <div class="pad">
        <p class="label">留痕体积上限（MB，0 为不限）</p>
        <input
          v-model.number="traceMaxDraft"
          class="num"
          type="number" min="0" max="4096" step="1" inputmode="numeric"
          :disabled="!config.localTraceEnabled"
          aria-label="本地留痕体积上限"
          @change="commitTraceMax"
        />
      </div>
    </SettingsGroup>

    <SettingsGroup v-if="homeSupported" title="启动">
      <div class="pad">
        <p class="label">打开 App 时进入</p>
        <SegmentedPill
          :options="[{ value: 'chat', label: '对话' }, { value: 'dashboard', label: '控制台' }]"
          :model-value="homeRoute"
          @update:model-value="pickHome"
        />
      </div>
    </SettingsGroup>

    <SettingsGroup v-if="hasSystemBridge" title="系统">
      <SettingsRow icon="bell" title="通知权限" subtitle="任务完成与后台提醒" chevron @click="openSystem('openNotificationSettings')" />
      <SettingsRow icon="plug" title="电池优化" subtitle="加入白名单，避免后台被清理" chevron @click="openSystem('requestBatteryExemption')" />
      <SettingsRow icon="phone" title="应用信息" subtitle="权限 · 存储 · 卸载" chevron @click="openSystem('openAppInfo')" />
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.pad { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.label {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2);
  margin: 0; font-size: var(--fs-label); color: var(--text-3);
}
.value { font-size: var(--fs-sub); color: var(--text-3); }
.hint { margin: var(--sp-2) 0 0; font-size: var(--fs-label); color: var(--text-3); }
.opts { display: flex; flex-direction: column; gap: 2px; margin-top: var(--sp-2); }
.opt { display: flex; align-items: center; gap: var(--sp-3); width: 100%; min-height: 56px; padding: var(--sp-2) 0; text-align: left; }
.opt-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.opt-name { font-size: var(--fs-body); font-weight: 500; color: var(--text); }
.opt.on .opt-name { color: var(--blue); }
.opt-desc { font-size: var(--fs-label); color: var(--text-3); }
.dot { flex: none; width: 8px; height: 8px; border-radius: 50%; background: var(--blue); }
.num {
  width: 120px; min-height: 40px; margin-top: var(--sp-2); padding: 10px var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); text-align: right;
  font-size: var(--fs-sub); font-variant-numeric: tabular-nums;
}
.num:disabled { opacity: .45; }
</style>
