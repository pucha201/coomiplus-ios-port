<script setup lang="ts">
/**
 * 模型与厂商（照 dsh-go providers_page 的结构）：
 *   概览 → 官方 → 自定义渠道 → 添加。
 *
 * 只做「主模型」。子代理设置不在这页；改码审查已删除。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { useConfigStore, type ProviderConfig } from '@/stores/config'
import { useDeviceStore } from '@/stores/device'
import { modelOwnerNote } from '@/utils/modelOwner'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import OverviewCard from '@/components/settings/OverviewCard.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const config = useConfigStore()
const device = useDeviceStore()

const loading = ref(true)
const error = ref('')

onMounted(async () => {
  error.value = ''
  try { await config.fetchProviders() } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally { loading.value = false }
})

const providers = computed(() => config.mergedProviders)
/**
 * 官方：随 App 一起提供的默认渠道（DeepSeek）。
 * 其余（含其它预设与用户自建）都归到「自定义渠道」——与 dsh-go 的两张卡片同口径。
 */
const OFFICIAL_ID = 'deepseek'
const official = computed(() => providers.value.filter(p => p.id === OFFICIAL_ID))
const custom = computed(() => providers.value.filter(p => p.id !== OFFICIAL_ID))

const ownerNote = computed(() => modelOwnerNote({
  mode: device.mode,
  hasDevice: Boolean(device.activeDevice),
  deviceName: device.activeDevice?.name || device.deviceName,
}))

const currentLabel = computed(() => {
  const owner = config.providers.find(p => p.id === config.currentProviderId)
  if (!owner || !config.currentModel) return '未选择模型'
  return `${owner.name} · ${config.currentModel}`
})

/** 摘要口径同 dsh-go：可用 = 有 Key 且有模型。 */
const summary = computed(() => {
  const total = providers.value.length
  const ready = providers.value.filter(p => p.hasKey && p.models.length > 0).length
  return `${total} 个渠道 · ${ready} 个可用`
})

function health(p: ProviderConfig): 'ready' | 'missingKey' | 'misconfigured' {
  if (!p.hasKey) return 'missingKey'
  if (!p.models.length) return 'misconfigured'
  return 'ready'
}
/** 行尾状态点：可用=绿、缺 Key=黄、没模型=红。 */
function dotOf(p: ProviderConfig): 'ok' | 'warn' | 'error' | 'idle' {
  const h = health(p)
  if (h === 'ready') return 'ok'
  if (h === 'missingKey') return 'warn'
  return 'error'
}
/** 首字母圆牌：字母取名字第一个字符。 */
function letterOf(p: ProviderConfig): string {
  const name = (p.name || p.id || '').trim()
  return name ? name.slice(0, 1).toUpperCase() : '?'
}
function subtitleOf(p: ProviderConfig): string {
  const h = health(p)
  if (h === 'missingKey') return '需要 API Key'
  if (h === 'misconfigured') return '还没添加模型'
  const parts: string[] = []
  if (p.type) parts.push(p.type)
  if (p.models.length) parts.push(`${p.models.length} 个模型`)
  return parts.join(' · ') || '已配置'
}

function openProvider(p: ProviderConfig) { router.push(`/providers/${encodeURIComponent(p.id)}`) }

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="模型与厂商" :subtitle="ownerNote || summary" :back="back">
    <template #actions>
      <button class="add-btn" type="button" aria-label="添加渠道" @click="router.push('/providers/new')">
        <CoomiIcon name="plus" :size="18" />
      </button>
    </template>

    <OverviewCard
      icon="cpu"
      :title="currentLabel"
      :subtitle="summary"
      :footer="device.mode === 'local' ? '本机引擎' : (device.activeDevice?.name || '电脑')"
      :online="!!config.currentModel"
      :footer-tail="config.currentProvider?.hasKey ? '已授权' : undefined"
      :chevron="false"
    />

    <p v-if="ownerNote" class="note">{{ ownerNote }}</p>
    <p v-if="config.usingMock" class="note warn">后端未连接，下面是本地示例数据，修改不会保存。</p>
    <p v-if="error" class="note err">{{ error }}</p>

    <SettingsGroup v-if="loading" title="渠道">
      <SettingsRow icon="cpu" title="读取中…" subtitle="正在从引擎拉取渠道列表" />
    </SettingsGroup>

    <template v-else>
      <SettingsGroup v-if="official.length" title="官方">
        <SettingsRow
          v-for="p in official"
          :key="p.id"
          :letter="letterOf(p)"
          :title="p.name"
          :subtitle="subtitleOf(p)"
          :dot="dotOf(p)"
          :value="p.status === 'current' ? '当前' : undefined"
          :tone="p.status === 'current' ? 'accent' : 'default'"
          chevron
          @click="openProvider(p)"
        />
      </SettingsGroup>

      <SettingsGroup title="自定义渠道" :note="custom.length ? `${custom.length} 个` : undefined">
        <SettingsRow
          v-for="p in custom"
          :key="p.id"
          :letter="letterOf(p)"
          :title="p.name"
          :subtitle="subtitleOf(p)"
          :dot="dotOf(p)"
          :value="p.status === 'current' ? '当前' : undefined"
          :tone="p.status === 'current' ? 'accent' : 'default'"
          chevron
          @click="openProvider(p)"
        />
        <SettingsRow
          icon="plus"
          title="添加渠道"
          :subtitle="custom.length ? '兼容 OpenAI / Anthropic 协议' : '还没有渠道。兼容 OpenAI / Anthropic 协议'"
          @click="router.push('/providers/new')"
        />
      </SettingsGroup>

      <SettingsGroup v-if="!providers.length" title="还没有渠道">
        <p class="empty">添加一个渠道后，这里会显示它的健康状态与模型数。</p>
      </SettingsGroup>
    </template>

    <p class="foot">渠道与密钥只存在这台设备的引擎里。</p>
  </SettingsPage>
</template>

<style scoped>
.add-btn {
  display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
  background: var(--blue-soft); color: var(--blue);
}
.note {
  margin: 0 0 var(--sp-3); padding: 10px var(--sp-3);
  border-radius: var(--r-md); background: var(--fill);
  font-size: var(--fs-label); line-height: 1.55; color: var(--text-2);
}
.note.warn { background: var(--orange-soft); color: var(--orange); }
.note.err { background: var(--danger-soft); color: var(--danger); }
.empty { margin: 0; padding: var(--sp-4); text-align: center; font-size: var(--fs-sub); line-height: 1.6; color: var(--text-3); }
.foot { margin: var(--sp-7) 0 0; text-align: center; font-size: var(--fs-caption); color: var(--text-3); }
</style>
