<script setup lang="ts">
/**
 * 连接电脑（原 CoomiPairingActivity）。
 * 三条配对路径（扫码 / 粘贴连接码 / 手动地址）+ 已配对设备 + 本机共享。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { useDeviceStore } from '@/stores/device'
import { useConnectionStore } from '@/stores/connection'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SegmentedPill from '@/components/settings/SegmentedPill.vue'
import OverviewCard from '@/components/settings/OverviewCard.vue'
import FieldRow from '@/components/settings/FieldRow.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const device = useDeviceStore()
const connection = useConnectionStore()

/** 本机 / 远程。 */
const target = ref<'local' | 'cloud'>(device.mode === 'cloud' ? 'cloud' : 'local')
const code = ref('')
const manualOpen = ref(false)
const manualBase = ref(device.engineBase || '')
const manualToken = ref('')
const busy = ref(false)
const message = ref('')
const error = ref('')

/** 本机共享开关（原生读引擎 settings.json 的 lanAccess）。 */
const lanOn = ref(false)
const lanSupported = computed(() => typeof window.CoomiAndroid?.getLanAccess === 'function')
try { lanOn.value = window.CoomiAndroid?.getLanAccess?.() ?? false } catch { /* 网页预览无桥 */ }
function toggleLan(next: boolean) {
  lanOn.value = next
  try { window.CoomiAndroid?.setLanAccess?.(next) } catch { /* 忽略桥异常 */ }
}

const currentLabel = computed(() => {
  if (device.mode === 'local') return '本机'
  return device.activeDevice?.name || '未连接电脑'
})
const online = computed(() => device.mode === 'local' || device.activeDevice?.reachability === 'online')

function back() { goBack(router, '/settings') }

async function connectByCode() {
  error.value = ''
  message.value = ''
  const value = code.value.trim()
  if (!value) { error.value = '粘贴电脑上生成的连接码'; return }
  busy.value = true
  try {
    const added = await device.addDeviceByCode(value)
    if (!added) throw new Error(device.error || '连接码无效或已过期')
    target.value = 'cloud'
    message.value = `已连接「${added.name}」`
    code.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { busy.value = false }
}

function scan() {
  const bridge = window.CoomiAndroid
  if (bridge?.scanQrCode) bridge.scanQrCode()
  else if (bridge?.startQrScan) bridge.startQrScan()
  else error.value = '当前环境不支持扫码，请手动粘贴连接码'
}

function connectManual() {
  error.value = ''
  message.value = ''
  const base = manualBase.value.trim()
  if (!base) { error.value = '填写电脑的地址'; return }
  device.setEndpoint(base, manualToken.value.trim() || undefined)
  target.value = 'cloud'
  message.value = '已保存地址，正在连接'
  manualOpen.value = false
}

function pick(which: 'local' | 'cloud') {
  target.value = which
  if (which === 'local') device.setMode('local')
  else if (device.activeDevice) device.selectDevice(device.activeDevice.id)
}

async function remove(id: string) {
  device.deleteDevice(id)
}
</script>

<template>
  <SettingsPage title="连接电脑" subtitle="本机直接运行；连电脑可远程使用它的引擎" :back="back">
    <OverviewCard
      icon="cpu"
      :title="currentLabel"
      :subtitle="device.mode === 'local' ? '引擎运行在这台手机上' : (device.activeDevice?.engineBase || '未填写地址')"
      :footer="connection.label"
      :online="online"
      :footer-tail="device.tokenStatus.configured ? '已授权' : '未授权'"
      :chevron="false"
    />

    <SettingsGroup title="连接方式">
      <div class="seg-wrap">
        <SegmentedPill
          :options="[{ value: 'local', label: '本机' }, { value: 'cloud', label: '电脑' }]"
          :model-value="target"
          @update:model-value="v => pick(v as 'local' | 'cloud')"
        />
      </div>
    </SettingsGroup>

    <SettingsGroup title="配对">
      <div class="pad">
        <button class="primary wide" type="button" :disabled="busy" @click="scan">
          <CoomiIcon name="search" :size="17" />扫码配对
        </button>
        <FieldRow label="粘贴连接码" hint="电脑端「连接手机」里生成的一串码">
          <textarea v-model="code" rows="2" placeholder="粘贴连接码" />
        </FieldRow>
        <button class="secondary wide" type="button" :disabled="busy || !code.trim()" @click="connectByCode">
          {{ busy ? '连接中…' : '连接' }}
        </button>
        <button class="text wide" type="button" @click="manualOpen = !manualOpen">
          {{ manualOpen ? '收起手动地址' : '手动输入地址' }}
        </button>
        <template v-if="manualOpen">
          <FieldRow label="地址">
            <input v-model="manualBase" placeholder="http://192.168.1.10:8765" inputmode="url" autocapitalize="off" />
          </FieldRow>
          <FieldRow label="令牌" hint="电脑端显示的一串令牌，可留空">
            <input v-model="manualToken" placeholder="可选" autocapitalize="off" />
          </FieldRow>
          <button class="secondary wide" type="button" @click="connectManual">保存并连接</button>
        </template>
      </div>
    </SettingsGroup>

    <p v-if="message" class="notice ok">{{ message }}</p>
    <p v-if="error" class="notice err">{{ error }}</p>

    <SettingsGroup title="已配对设备" :note="device.devices.length ? `${device.devices.length} 台` : undefined">
      <SettingsRow
        v-for="d in device.devices"
        :key="d.id"
        icon="cpu"
        :title="d.name"
        :subtitle="d.engineBase || d.id"
        :value="d.id === device.deviceId ? '当前' : undefined"
        :tone="d.id === device.deviceId ? 'accent' : 'default'"
        :chevron="d.id !== device.deviceId"
        @click="d.id === device.deviceId ? undefined : device.selectDevice(d.id)"
      />
      <div v-if="!device.devices.length" class="empty-row">还没有配对过电脑。上面扫码或粘贴连接码即可添加。</div>
    </SettingsGroup>

    <div v-if="device.devices.length" class="manage">
      <button
        v-for="d in device.devices"
        :key="'del-' + d.id"
        class="danger-link"
        type="button"
        @click="remove(d.id)"
      >删除「{{ d.name }}」</button>
    </div>

    <SettingsGroup v-if="lanSupported" title="本机共享">
      <SettingsRow
        icon="globe"
        title="允许局域网连接"
        subtitle="让手机在同一 Wi-Fi 下连本机引擎；改完需重启引擎"
        :switch-state="(lanOn) ? 'on' : 'off'"
        @update:switch="(v: 'on' | 'off') => toggleLan(v === 'on')"
      />
    </SettingsGroup>

    <SettingsGroup v-if="device.mode === 'cloud'" title="危险操作">
      <SettingsRow
        icon="close"
        title="断开并清除连接"
        subtitle="删除保存的地址与令牌"
        tone="danger"
        @click="device.setMode('local')"
      />
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.seg-wrap { padding: var(--sp-3); }
.pad { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.primary, .secondary, .text {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-1);
  min-height: 46px; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600;
}
.primary { background: var(--blue); color: #fff; }
.secondary { margin-top: var(--sp-3); background: var(--fill); color: var(--text); }
.text { margin-top: var(--sp-2); background: transparent; color: var(--blue); }
.wide { width: 100%; }
.primary:disabled, .secondary:disabled { opacity: .45; }
.notice { margin: var(--sp-3) 0 0; padding: 10px var(--sp-3); border-radius: var(--r-md); font-size: var(--fs-label); line-height: 1.5; }
.notice.ok { color: var(--ok); background: var(--ok-soft); }
.notice.err { color: var(--danger); background: var(--danger-soft); }
.empty-row { padding: var(--sp-4); text-align: center; font-size: var(--fs-sub); line-height: 1.6; color: var(--text-3); }
.manage { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-2); }
.danger-link {
  min-height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-sm);
  background: transparent; color: var(--danger); font-size: var(--fs-sub); text-align: left;
}
</style>
