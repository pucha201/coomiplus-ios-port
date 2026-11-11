<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet, apiSend } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import { useConfigStore } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import UiButton from '@/components/ui/UiButton.vue'

interface LifeProfile {
  name: string
  address: string
  preset?: string
  personality?: Record<string, string>
  paused: boolean
  emotion: string
  valence?: number
  arousal?: number
  attention: string
  bond: number
  needs: Record<string, number>
  memory_count: number
  turn_count?: number
  milestone?: string
  agenda?: Array<{ text: string; done?: boolean }>
  updated_at_ms: number
}

interface LifeStatus {
  installed: boolean
  runtime_ready: boolean
  nativeEngine?: boolean
  prootReady?: boolean
  termuxReady?: boolean
  profile: LifeProfile | null
  dependencies: string[]
  upstream_commit: string
  background_heartbeat: boolean
}

interface IdentityConfig {
  name: string
  address: string
  preset: string
}

interface LifeSettings {
  enabled: boolean
  delivery: string
  dailyMode: 'off' | 'auto' | 'custom'
  dailyLimitCustom: number
  globalMode: boolean
  windowStartMinutes: number
  windowEndMinutes: number
  minIntervalMinutes: number
  quietAfterTurnMinutes: number
}

interface JournalEntry {
  at_ms: number
  text: string
  trigger: string
  life_name: string
  emotion: string
  bond: number
  needs: Record<string, number>
}

interface MemoryEntry {
  at_ms: number
  user: string
  assistant: string
}

const router = useRouter()
const config = useConfigStore()
const session = useSessionStore()
const status = ref<LifeStatus | null>(null)
const busy = ref('')
const message = ref('')
const error = ref('')
const name = ref('CoomiPlus Life')
const address = ref('你')
const preset = ref('balanced')
const pendingIdentity = ref<IdentityConfig | null>(null)
const lifeSettings = ref<LifeSettings | null>(null)
const journal = ref<JournalEntry[]>([])
const memories = ref<MemoryEntry[]>([])
const dailyMode = ref<'off' | 'auto' | 'custom'>('auto')
const customLimit = ref(2)
const windowStart = ref(540)
const windowEnd = ref(1380)
const triggerLabels: Record<string, string> = {
  lonely: '想你了', growth_checkin: '成长', support: '关心', everyday: '日常问候',
}
const emotionLabels: Record<string, string> = {
  neutral: '平静', calm: '安宁', warm: '温暖', happy: '开心', excited: '兴奋', curious: '好奇', affectionate: '依恋', concerned: '担心', sad: '低落', anxious: '紧张', angry: '生气', tired: '疲惫',
}
const dailyModeOptions = [
  { value: 'off', label: '关闭主动' },
  { value: 'auto', label: '自动判断' },
  { value: 'custom', label: '自定义数值' },
]
const windowStartOptions = [7, 8, 9, 10, 11].map(h => ({ value: String(h * 60), label: `${h}:00` }))
const windowEndOptions = [18, 19, 20, 21, 22, 23].map(h => ({ value: String(h * 60), label: `${h}:00` }))
const presetOptions = [
  { value: 'balanced', label: '均衡' },
  { value: 'warm', label: '温柔' },
  { value: 'cool', label: '高冷' },
  { value: 'charming', label: '妩媚' },
  { value: 'direct', label: '直接' },
  { value: 'dismissive', label: '嫌弃' },
  { value: 'rational', label: '理性' },
  { value: 'playful', label: '俏皮' },
  { value: 'quiet', label: '沉静' },
  { value: 'sharp', label: '毒舌' },
  { value: 'nurturing', label: '守护' },
  { value: 'scholar', label: '学者' },
  { value: 'dreamer', label: '诗性' },
  { value: 'honest_friend', label: '挚友' },
  { value: 'guardian_angel', label: '暖阳' },
]
const presetByLabel: Record<string, string> = Object.fromEntries(presetOptions.map(option => [option.label, option.value]))
const exportedPath = ref('')

const profile = computed(() => status.value?.profile ?? null)
const bondPercent = computed(() => Math.round((profile.value?.bond ?? 0) * 100))

async function refresh() {
  error.value = ''
  try {
    status.value = await apiGet<LifeStatus>('/api/cognitive/status')
    if (status.value.profile) {
      name.value = status.value.profile.name
      address.value = status.value.profile.address
      const configuredPreset = status.value.profile.preset
      const legacyLabel = status.value.profile.personality?.label
      preset.value = configuredPreset || (legacyLabel ? presetByLabel[legacyLabel] : '') || preset.value || 'balanced'
    } else if (config.digitalLifeEnabled) {
      config.setDigitalLifeEnabled(false)
    }
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
  await refreshLifePanel()
}

async function refreshLifePanel() {
  try {
    lifeSettings.value = await apiGet<LifeSettings>('/api/life/settings')
    const settings = lifeSettings.value
    dailyMode.value = settings?.dailyMode ?? 'auto'
    customLimit.value = settings?.dailyLimitCustom ?? 2
    windowStart.value = settings?.windowStartMinutes ?? 540
    windowEnd.value = settings?.windowEndMinutes ?? 1380
    config.setLifeGlobalMode(settings?.globalMode === true)
  } catch { /* 引擎未就绪 */ }
  try {
    const data = await apiGet<{ entries: JournalEntry[] }>('/api/life/journal?limit=2')
    journal.value = data?.entries ?? []
  } catch { /* 引擎未就绪 */ }
  try {
    const data = await apiGet<{ entries: MemoryEntry[] }>('/api/life/memory?limit=2')
    memories.value = data?.entries ?? []
  } catch { /* 引擎未就绪 */ }
}

/** 全局人格开关：同步引擎 settings + 全局覆盖，ChatView 监听 lifeGlobalMode 后自动切模式。 */
function toggleGlobalMode() {
  const next = !config.lifeGlobalMode
  config.setLifeGlobalMode(next)
  session.syncLifeMode()
  void updateLifeSettings({ globalMode: next })
}

function onDailyModeChange(value: string) {
  dailyMode.value = value as 'off' | 'auto' | 'custom'
  void updateLifeSettings({ dailyMode: dailyMode.value })
}

function onCustomLimitChange(event: Event) {
  const value = Math.max(1, Math.min(100, Number((event.target as HTMLInputElement).value) || 2))
  customLimit.value = value
  void updateLifeSettings({ dailyLimitCustom: value })
}

function onWindowStartChange(value: string) {
  windowStart.value = Number(value)
  void updateLifeSettings({ windowStartMinutes: windowStart.value })
}

function onWindowEndChange(value: string) {
  windowEnd.value = Number(value)
  void updateLifeSettings({ windowEndMinutes: windowEnd.value })
}

function goMemory() { router.push('/life/memory') }
function goJournal() { router.push('/life/journal') }

/** 主动问候设置：局部更新 + 回读（引擎侧白名单+钳制后的值）。 */
async function updateLifeSettings(patch: Partial<LifeSettings>) {
  error.value = ''
  try {
    const settings = await apiSend<LifeSettings>('/api/life/settings', 'PUT', patch)
    lifeSettings.value = settings
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  }
}

function formatJournalTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

async function run(label: string, operation: () => Promise<unknown>, success: string) {
  if (busy.value) return
  busy.value = label
  error.value = ''
  message.value = ''
  try {
    await operation()
    message.value = success
    await refresh()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = ''
  }
}

const runtimeProgress = ref<{ percent: number; status: string } | null>(null)

async function install() {
  if (busy.value) return
  busy.value = 'install'
  error.value = ''
  message.value = ''
  // 轮询 Runtime V2 下载进度
  const pollTimer = setInterval(async () => {
    try {
      const rt = await apiGet<{ status?: string; downloadProgress?: { percent?: number } }>('/api/runtime/v2')
      if (rt?.downloadProgress?.percent != null) {
        runtimeProgress.value = { percent: rt.downloadProgress.percent, status: rt.status || 'downloading' }
      }
    } catch { /* ignore */ }
  }, 1000)
  try {
    await apiSend('/api/cognitive/install', 'POST')
    message.value = '扩展已安装'
    await refresh()
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    clearInterval(pollTimer)
    runtimeProgress.value = null
    busy.value = ''
  }
}

function uninstall() {
  return run('uninstall', () => apiSend('/api/cognitive/install', 'DELETE'), '扩展代码已卸载')
}

function bootstrap() {
  return run('bootstrap', () => apiSend('/api/cognitive/bootstrap', 'POST', {
    profile_id: 'primary', name: name.value, address: address.value, preset: preset.value,
  }), '觉醒完成')
}

async function configure() {
  const identity = pendingIdentity.value ?? {
    name: name.value, address: address.value, preset: preset.value,
  }
  pendingIdentity.value = null
  await run('configure', () => apiSend('/api/cognitive/configure', 'POST', {
    profile_id: 'primary', ...identity,
  }), '配置已保存')
  const queued = readPendingIdentity()
  if (queued && profile.value) {
    name.value = queued.name
    address.value = queued.address
    preset.value = queued.preset
    void configure()
  }
}

function readPendingIdentity(): IdentityConfig | null {
  return pendingIdentity.value
}

function persistIdentity() {
  if (!profile.value) return
  pendingIdentity.value = {
    name: name.value, address: address.value, preset: preset.value,
  }
  if (!busy.value) void configure()
}

function persistPreset(value: string) {
  preset.value = value
  persistIdentity()
}

function togglePause() {
  return run('pause', () => apiSend('/api/cognitive/pause', 'POST', {
    profile_id: 'primary', paused: !profile.value?.paused,
  }), profile.value?.paused ? '已恢复' : '已暂停')
}

function openRuntime() {
  router.push('/runtime')
}

function toggleEnabled() {
  if (!profile.value) return
  const enabled = !config.digitalLifeEnabled
  config.setDigitalLifeEnabled(enabled)
  // 模式决议（常驻/全局开关）后同步引擎。
  session.syncLifeMode()
  // 引擎侧主动问候总开关与前端一致：关闭时调度器不再入队。
  void updateLifeSettings({ enabled })
}

async function exportProfile() {
  if (busy.value) return
  busy.value = 'export'
  error.value = ''
  try {
    const result = await apiSend<{ path: string }>('/api/cognitive/export', 'POST', { profile_id: 'primary' })
    exportedPath.value = result.path
    message.value = '导出完成'
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = ''
  }
}

function resetProfile() {
  return run('reset', () => apiSend('/api/cognitive/reset', 'POST', { profile_id: 'primary' }), '状态和记忆已重置')
}

function deleteProfile() {
  return run('delete', () => apiSend('/api/cognitive/delete', 'POST', { profile_id: 'primary' }), '数据已彻底删除')
}

onMounted(() => {
  config.syncDigitalLifeEnabled()
  void refresh()
})
</script>
<template>
  <div class="page">
    <PageHead title="数字生命体" @back="goBack(router, 'dashboard')" />
    <main class="body">
      <div v-if="error || message" class="notice" :class="{ error: !!error }">{{ error || message }}</div>

      <section class="card hero-card">
        <button class="hero-toggle" :disabled="!profile" @click="toggleEnabled">
          <span class="hero-orb" :class="{ on: config.digitalLifeEnabled && !!profile }">
            <CoomiIcon name="lifeRings" :size="22" />
          </span>
          <span class="hero-text">
            <strong>数字生命</strong>
            <small>{{ profile ? (config.digitalLifeEnabled ? '常驻人格已开启' : '点击启用常驻人格') : '完成安装和觉醒后可开启' }}</small>
          </span>
          <i class="switch" :class="{ on: config.digitalLifeEnabled }" />
        </button>
        <button class="hero-sub" @click="toggleGlobalMode">
          <span>
            <strong>全局会话人格</strong>
            <small>所有对话都套用这个人格</small>
          </span>
          <i class="switch" :class="{ on: config.lifeGlobalMode }" />
        </button>
      </section>

      <section v-if="!status?.installed" class="card">
        <div class="card-head">
          <h3>扩展</h3>
          <span class="tag" :class="{ ok: status?.installed }">{{ status?.installed ? '已启用' : '未启用' }}</span>
        </div>
        <p class="card-desc">Rust 原生引擎 · {{ status?.nativeEngine ? '原生' : '旧版' }}</p>
        <div v-if="runtimeProgress" class="progress-wrap">
          <div class="progress">
            <div class="progress-fill" :style="{ width: runtimeProgress.percent + '%' }" />
          </div>
          <span class="progress-label">下载中 {{ runtimeProgress.percent }}%</span>
        </div>
        <div class="card-action">
          <UiButton variant="primary" block :disabled="!!busy" @click="install">
            {{ busy === 'install' ? '启用中…' : '启用扩展' }}
          </UiButton>
        </div>
      </section>

      <template v-else>
        <section class="card">
          <div class="card-head">
            <h3>身份</h3>
            <button class="link" @click="openRuntime">运行时</button>
          </div>
          <label class="row">
            <span>名称</span>
            <input v-model="name" maxlength="48" @change="persistIdentity" />
          </label>
          <label class="row">
            <span>称呼你</span>
            <input v-model="address" maxlength="48" @change="persistIdentity" />
          </label>
          <label class="row">
            <span>人格</span>
            <UiSelect v-model="preset" :options="presetOptions" block @update:model-value="persistPreset" />
          </label>
          <div v-if="!profile" class="card-action">
            <UiButton variant="primary" block :disabled="!!busy" @click="bootstrap">觉醒</UiButton>
          </div>
          <div v-else class="card-action row-btns">
            <UiButton variant="ghost" size="sm" :disabled="!!busy" @click="togglePause">
              <CoomiIcon :name="profile.paused ? 'play' : 'pause'" :size="14" />
              {{ profile.paused ? '恢复' : '暂停' }}
            </UiButton>
            <UiButton variant="ghost" size="sm" :disabled="!!busy" @click="exportProfile">导出</UiButton>
            <UiButton variant="ghost" size="sm" :disabled="!!busy" @click="uninstall">停用</UiButton>
          </div>
          <p v-if="exportedPath" class="path">{{ exportedPath }}</p>
        </section>

        <template v-if="profile">
          <section class="card">
            <div class="card-head"><h3>状态</h3></div>
            <div class="metrics">
              <div class="metric mood">
                <span class="m-label">情绪</span>
                <strong>{{ emotionLabels[profile.emotion] || profile.emotion }}</strong>
              </div>
              <div class="metric">
                <span class="m-label">关系</span>
                <div class="bond">
                  <div class="bond-bar"><i :style="{ width: bondPercent + '%' }" /></div>
                  <strong>{{ bondPercent }}%</strong>
                </div>
              </div>
              <div class="metric"><span class="m-label">效价</span><strong>{{ (profile.valence ?? 0).toFixed(2) }}</strong></div>
              <div class="metric"><span class="m-label">唤醒</span><strong>{{ (profile.arousal ?? 0).toFixed(2) }}</strong></div>
              <div class="metric"><span class="m-label">关注</span><strong>{{ profile.attention }}</strong></div>
              <div class="metric"><span class="m-label">记忆</span><strong>{{ profile.memory_count }}</strong></div>
              <div v-if="profile.turn_count != null" class="metric"><span class="m-label">轮次</span><strong>{{ profile.turn_count }}</strong></div>
              <div v-for="(value, key) in profile.needs" :key="key" class="metric">
                <span class="m-label">{{ key }}</span>
                <strong>{{ Math.round(value * 100) }}%</strong>
              </div>
            </div>
            <p v-if="profile.milestone" class="milestone">{{ profile.milestone }}</p>
            <ul v-if="profile.agenda?.length" class="agenda">
              <li v-for="(item, i) in profile.agenda.slice(0, 5)" :key="i" :class="{ done: item.done }">{{ item.text }}</li>
            </ul>
          </section>

          <section class="card">
            <div class="card-head"><h3>主动问候</h3></div>
            <label class="row switch-row">
              <span>允许主动找我</span>
              <i class="switch" :class="{ on: lifeSettings?.enabled }" @click="updateLifeSettings({ enabled: !lifeSettings?.enabled })" />
            </label>
            <label class="row">
              <span>每日上限</span>
              <UiSelect :model-value="dailyMode" :options="dailyModeOptions" block @update:model-value="onDailyModeChange" />
            </label>
            <label v-if="dailyMode === 'custom'" class="row">
              <span>条数</span>
              <input type="number" min="1" max="100" :value="customLimit" @change="onCustomLimitChange" />
            </label>
            <label class="row">
              <span>时段</span>
              <span class="window">
                <UiSelect :model-value="String(windowStart)" :options="windowStartOptions" size="sm" @update:model-value="onWindowStartChange" />
                <b>–</b>
                <UiSelect :model-value="String(windowEnd)" :options="windowEndOptions" size="sm" @update:model-value="onWindowEndChange" />
              </span>
            </label>
            <p class="hint">仅在常驻会话里出现，不弹系统通知。</p>
          </section>

          <section class="card">
            <div class="card-head">
              <h3>最近记忆</h3>
              <button class="link" @click="goMemory">更多</button>
            </div>
            <p v-if="!memories.length" class="empty-sm">和它多聊一阵，这里会留下关键对话。</p>
            <div v-for="(item, index) in memories" :key="index" class="feed-item">
              <time>{{ formatJournalTime(item.at_ms) }}</time>
              <p><b>你</b>{{ item.user }}</p>
              <p><b>{{ profile?.name || '生命体' }}</b>{{ item.assistant }}</p>
            </div>
          </section>

          <section class="card">
            <div class="card-head">
              <h3>心情日记</h3>
              <button class="link" @click="goJournal">更多</button>
            </div>
            <p v-if="!journal.length" class="empty-sm">开启主动问候后，每次主动找你都会记一笔。</p>
            <div v-for="(entry, index) in journal" :key="index" class="feed-item">
              <time>{{ formatJournalTime(entry.at_ms) }} · {{ triggerLabels[entry.trigger] ?? entry.trigger }}</time>
              <p class="journal-text">{{ entry.text }}</p>
            </div>
          </section>

          <section class="card danger-card">
            <button @click="resetProfile">重置状态和记忆</button>
            <button class="danger" :disabled="!!busy" @click="deleteProfile">彻底删除</button>
          </section>
        </template>
      </template>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body {
  flex: 1; overflow-y: auto;
  padding: var(--sp-3) 14px calc(var(--safe-bottom) + 28px);
  -webkit-overflow-scrolling: touch;
}
.notice {
  margin-bottom: 10px; padding: 10px var(--sp-3);
  border-radius: var(--r-md); background: var(--blue-soft);
  color: var(--blue); font-size: var(--fs-label);
  animation: coomi-enter-append var(--enter-block-dur) var(--ease-out) backwards;
}
.notice.error { background: var(--danger-soft); color: var(--danger); }
.card {
  margin-bottom: var(--sp-3);
  border-radius: var(--r-card);
  background: var(--bg);
  box-shadow: var(--shadow-1);
  overflow: hidden;
  animation: coomi-enter-append var(--enter-block-dur) var(--ease-out) backwards;
}
.card-head {
  display: flex; align-items: center; justify-content: space-between;
  padding: var(--sp-3) 14px 0;
}
.card-head h3 { margin: 0; font-size: var(--fs-body); font-weight: 700; color: var(--text); }
.card-desc { margin: var(--sp-1) 14px 0; font-size: var(--fs-label); color: var(--text-3); }
.card-action { padding: var(--sp-3) 14px 14px; }
.row-btns { display: flex; gap: var(--sp-2); flex-wrap: wrap; }
.link {
  border: 0; background: none; padding: 2px var(--sp-1);
  color: var(--blue); font-size: var(--fs-label); font-weight: 600; cursor: pointer;
}
.tag {
  font-size: var(--fs-caption); font-weight: 600; padding: 2px var(--sp-2);
  border-radius: var(--r-pill); background: var(--fill); color: var(--text-3);
}
.tag.ok { background: var(--ok-soft); color: var(--ok); }
.hero-card { padding: 0; }
.hero-toggle {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; padding: 14px; text-align: left;
  border: 0; background: transparent;
}
.hero-orb {
  width: 48px; height: 48px; border-radius: var(--r-card);
  display: grid; place-items: center; flex-shrink: 0;
  background: var(--fill); color: var(--text-3);
  /* 按压一律 --ease-out：--ease-spring 会让手指松开时元素「弹」一下，
     在一个可以反复点的图标上会读成卡顿。弹性只留给一次性入场。 */
  transition: background var(--dur-base) var(--ease-out), color var(--dur-base) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.hero-orb.on {
  background: linear-gradient(135deg, var(--blue), #6b8ef0);
  color: #fff;
  box-shadow: 0 4px 14px color-mix(in srgb, var(--blue) 35%, transparent);
}
.hero-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.hero-text strong { font-size: var(--fs-body-lg); font-weight: 700; color: var(--text); }
.hero-text small { font-size: var(--fs-label); color: var(--text-3); }
.hero-sub {
  display: flex; align-items: center; gap: var(--sp-3);
  width: 100%; padding: var(--sp-3) 14px; text-align: left;
  border: 0; border-top: 1px solid var(--border); background: transparent;
}
.hero-sub > span { flex: 1; display: flex; flex-direction: column; gap: 2px; }
.hero-sub strong { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.hero-sub small { font-size: var(--fs-caption); color: var(--text-3); }
.switch {
  position: relative; flex: none;
  width: 44px; height: 26px; border-radius: var(--r-pill);
  background: var(--border-strong); cursor: pointer;
  transition: background var(--dur-base) var(--ease-out);
}
.switch::after {
  content: ''; position: absolute; top: 3px; left: 3px;
  width: 20px; height: 20px; border-radius: 50%;
  background: #fff; box-shadow: 0 1px 3px rgba(0,0,0,.15);
  /* 拨杆保留 --ease-spring：这是全 app 唯一允许弹性的一处 ——
     它是「一次性状态翻转」而不是按压，滑到底的落点需要一点回弹才读作「到位了」。 */
  transition: transform var(--dur-base) var(--ease-spring);
}
.switch.on { background: var(--blue); }
.switch.on::after { transform: translateX(18px); }
.progress-wrap { margin: var(--sp-3) 14px 0; }
.progress {
  height: 6px; border-radius: 3px; background: var(--fill); overflow: hidden;
}
.progress-fill {
  height: 100%; border-radius: 3px; background: var(--blue);
  transition: width var(--dur-slow) var(--ease-out);
}
.progress-label { display: block; margin-top: 6px; font-size: var(--fs-caption); color: var(--text-3); }
.row {
  display: grid; grid-template-columns: 88px minmax(0, 1fr);
  align-items: center; gap: 10px;
  min-height: 52px; padding: var(--sp-2) 14px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-sub);
}
.card-head + .row { border-top: 0; margin-top: 10px; }
.row > span:first-child { color: var(--text-2); font-size: var(--fs-label); }
.row input {
  box-sizing: border-box; width: 100%; min-height: 38px; padding: 0 10px;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--fill); color: var(--text); font: inherit; font-size: var(--fs-sub);
  outline: none; transition: border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.row input:focus { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-soft); }
.switch-row { cursor: pointer; }
.switch-row .switch { justify-self: end; }
.window { display: flex; align-items: center; gap: var(--sp-2); }
.window b { color: var(--text-3); font-weight: 400; }
.hint {
  margin: 0; padding: 10px 14px var(--sp-3);
  border-top: 1px solid var(--border);
  font-size: var(--fs-caption); color: var(--text-3); line-height: 1.5;
}
.path {
  margin: 0; padding: 0 14px var(--sp-3);
  overflow-wrap: anywhere; font-size: var(--fs-caption); color: var(--text-3);
}
.metrics {
  display: grid; grid-template-columns: 1fr 1fr;
  gap: 1px; background: var(--border);
  border-top: 1px solid var(--border);
  margin-top: 10px;
}
.metric {
  display: flex; flex-direction: column; gap: var(--sp-1);
  padding: var(--sp-3) 14px; background: var(--bg);
  min-height: 56px;
}
.m-label { font-size: var(--fs-caption); color: var(--text-3); }
.metric strong { font-size: var(--fs-body-lg); font-weight: 700; color: var(--text); font-variant-numeric: tabular-nums; }
.metric.mood strong { color: var(--blue); }
.bond { display: flex; flex-direction: column; gap: 6px; }
.bond-bar { height: 5px; border-radius: 3px; background: var(--fill); overflow: hidden; }
.bond-bar i {
  display: block; height: 100%; border-radius: 3px;
  background: linear-gradient(90deg, var(--blue), #6b8ef0);
  transition: width var(--dur-slow) var(--ease-out);
}
.bond strong { font-size: var(--fs-body); }
.milestone {
  margin: 0; padding: 10px 14px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-label); color: var(--blue); line-height: 1.5;
}
.agenda {
  margin: 0; padding: var(--sp-2) 14px var(--sp-3) 28px;
  border-top: 1px solid var(--border);
  font-size: var(--fs-label); color: var(--text-2); line-height: 1.6;
}
.agenda .done { text-decoration: line-through; color: var(--text-3); }

.feed-item {
  padding: 10px 14px; border-top: 1px solid var(--border);
  animation: coomi-enter-append var(--enter-append-dur) var(--ease-out) backwards;
}
.feed-item:first-of-type { border-top: 0; }
.feed-item time { display: block; margin-bottom: var(--sp-1); font-size: var(--fs-caption); color: var(--text-3); }
.feed-item p {
  margin: 0 0 var(--sp-1); font-size: var(--fs-sub); line-height: 1.55; color: var(--text-2);
  word-break: break-word;
}
.feed-item p:last-child { margin-bottom: 0; }
.feed-item b {
  display: inline-block; margin-right: 6px;
  font-size: var(--fs-caption); font-weight: 700; color: var(--text-3);
}
.journal-text { white-space: pre-wrap; }
.danger-card {
  display: grid; grid-template-columns: 1fr 1fr; gap: var(--sp-2);
  padding: 10px; background: transparent; box-shadow: none;
}
.danger-card button {
  min-height: 40px; border-radius: var(--r-md);
  background: var(--fill); color: var(--text-2);
  font-size: var(--fs-sub); font-weight: 600; cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.danger-card button:active { transform: scale(var(--press-scale)); }
.danger-card button.danger { background: var(--danger-soft); color: var(--danger); }
button:disabled { opacity: 0.45; pointer-events: none; }
</style>
