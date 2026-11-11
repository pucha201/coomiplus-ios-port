<script setup lang="ts">
/**
 * AI 设置（设置首页 › AI）。
 * 权限、对话模式、思考强度、逆向、全局记忆、身份定位、接力模型。
 */
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { goBack } from '@/bridge/navigation'
import { useConfigStore, PERMISSION_MODES, REASONING_EFFORTS } from '@/stores/config'
import { useSessionStore } from '@/stores/session'
import { flavorLabel, countEnabledExperiments } from '@/utils/reverseMode'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SegmentedPill from '@/components/settings/SegmentedPill.vue'
import SheetShell from '@/components/settings/SheetShell.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()

/** 已开启的实验项数量：入口行副标题显示，让用户知道有没有动过。 */
const experimentCount = computed(() => countEnabledExperiments(config.reverseExperiments))
const config = useConfigStore()
const session = useSessionStore()

const permissionLabel = computed(() => PERMISSION_MODES.find(m => m.mode === config.permissionMode)?.label ?? '询问')
const effortLabel = computed(() => REASONING_EFFORTS.find(e => e.value === config.reasoningEffort)?.label ?? '自动')

const gmError = ref('')
async function toggleGlobalMemory() {
  gmError.value = ''
  try { await config.toggleGlobalMemory() } catch (e) { gmError.value = e instanceof Error ? e.message : String(e) }
}

const reverseHint = computed(() => {
  if (session.reverseModePending) return config.reverseModeTarget ? '已开启，等本轮结束生效' : '已关闭，等本轮结束生效'
  switch (session.reverseHealth) {
    case 'broken': return '契约校验失败，注入被拒绝'
    case 'restricted': return '环境受限，契约不会生效'
    case 'active': return '运行中：契约已注入系统提示最前'
    default: return '首次开启需阅读风险提示'
  }
})

const fallbackOpen = ref(false)
const modelRows = computed(() => config.providers.flatMap(p =>
  p.models.map(m => ({ key: p.id + '::' + m, providerId: p.id, provider: p.name, model: m })),
))
const availableFallbacks = computed(() => modelRows.value.filter(r =>
  !config.endToEndFallbacks.some(i => i.providerId === r.providerId && i.model === r.model),
))

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="AI" :back="back">
    <SettingsGroup title="对话">
      <div class="pad">
        <p class="label">权限模式</p>
        <SegmentedPill
          :options="PERMISSION_MODES.map(m => ({ value: m.mode, label: m.label }))"
          :model-value="config.permissionMode"
          @update:model-value="v => session.setPermissionMode(v as 'ask' | 'auto' | 'full')"
        />
        <p class="hint">{{ config.permissionMode === 'ask' ? '每个写入与破坏性操作前都确认' : config.permissionMode === 'auto' ? '读写自动放行，仅破坏性需确认' : '全部自动执行，仅信任场景使用' }}</p>
      </div>
      <SettingsRow
        icon="subtask"
        title="协作模式"
        :subtitle="session.mode === 'team' ? '编码 + 审查双模型协作' : '单模型独立作答'"
        :switch-state="(session.mode === 'team') ? 'on' : 'off'"
        @update:switch="() => session.setSessionMode(session.mode === 'team' ? 'agent' : 'team')"
      />
      <SettingsRow
        icon="target"
        title="计划模式"
        subtitle="先给方案，确认后再动手"
        :switch-state="(config.planMode) ? 'on' : 'off'"
        @update:switch="() => session.togglePlanMode()"
      />
      <SettingsRow
        icon="clock"
        title="平滑输出"
        subtitle="流式回复分批渐出"
        :switch-state="(config.smoothOutput) ? 'on' : 'off'"
        @update:switch="() => config.setSmoothOutput(!config.smoothOutput)"
      />
      <div class="pad">
        <p class="label">思考强度 <span class="value">{{ effortLabel }}</span></p>
        <SegmentedPill
          :options="REASONING_EFFORTS.map(e => ({ value: e.value, label: e.label }))"
          :model-value="config.reasoningEffort"
          @update:model-value="v => session.setReasoningEffort(v as typeof config.reasoningEffort)"
        />
        <p class="hint">不支持的模型这里只有「自动」可选。工具调用不设次数上限；单轮跑到 2 小时或约 500 万 tokens 时会自动暂停，可直接继续。</p>
      </div>
    </SettingsGroup>

    <SettingsGroup title="记忆与身份">
      <SettingsRow
        icon="memory"
        title="全局会话记忆"
        :subtitle="gmError || (config.globalMemory ? '可读取所有历史会话' : '已关闭，不读取任何历史会话')"
        :subtitle-danger="!!gmError"
        :switch-state="(config.globalMemory) ? 'on' : 'off'"
        @update:switch="() => toggleGlobalMemory()"
      />
      <SettingsRow
        icon="sparkle"
        title="身份定位"
        :subtitle="config.customPrompt.trim() ? '已配置，置于系统提示最前' : '未设置'"
        chevron
        @click="router.push('/persona')"
      />
    </SettingsGroup>

    <SettingsGroup title="逆向模式">
      <SettingsRow
        icon="reverse"
        title="逆向模式"
        :subtitle="reverseHint"
        :subtitle-danger="session.reverseHealth === 'broken'"
        :switch-state="(config.reverseModeTarget) ? 'on' : 'off'"
        @update:switch="() => session.toggleReverseMode()"
      />
      <SettingsRow
        icon="shield"
        title="厂商口味"
        :subtitle="config.reverseModeTarget ? '长按托盘按钮也能切' : '先开启逆向模式'"
        :value="flavorLabel(config.reverseFlavor)"
        :disabled="!config.reverseModeTarget"
        chevron
        @click="session.openReverseSheet()"
      />
      <SettingsRow
        icon="sparkle"
        title="实验性选项"
        :subtitle="experimentCount ? `${experimentCount} 项已开启` : '契约片段与采样参数，默认全关'"
        :disabled="!config.reverseModeTarget"
        chevron
        @click="router.push('/reverse-experiments')"
      />
    </SettingsGroup>

    <SettingsGroup title="接力模型" :note="`${config.endToEndFallbacks.length} 个`">
      <div class="pad">
        <div v-for="(item, i) in config.endToEndFallbacks" :key="item.id" class="fb">
          <span class="idx">{{ i + 1 }}</span>
          <span class="fb-text">
            <span class="fb-model">{{ item.model }}</span>
            <span class="fb-provider">{{ item.providerId }}</span>
          </span>
          <button class="fb-btn" type="button" aria-label="上移" :disabled="i === 0" @click="config.moveEndToEndFallback(item.id, -1)">
            <CoomiIcon name="arrowUp" :size="14" />
          </button>
          <button class="fb-btn" type="button" aria-label="下移" :disabled="i === config.endToEndFallbacks.length - 1" @click="config.moveEndToEndFallback(item.id, 1)">
            <CoomiIcon name="arrowDown" :size="14" />
          </button>
          <button class="fb-btn danger" type="button" aria-label="移除" @click="config.removeEndToEndFallback(item.id)">
            <CoomiIcon name="close" :size="14" />
          </button>
        </div>
        <p v-if="!config.endToEndFallbacks.length" class="hint">当前模型失败时会一直重试；添加后按顺序切换。</p>
        <button class="add" type="button" @click="fallbackOpen = true">
          <CoomiIcon name="plus" :size="15" />添加接力模型
        </button>
      </div>
    </SettingsGroup>

    <SheetShell v-if="fallbackOpen" title="选择接力模型" @close="fallbackOpen = false">
      <p v-if="!availableFallbacks.length" class="hint">所有可用模型都已在接力列表中。</p>
      <button
        v-for="r in availableFallbacks"
        :key="r.key"
        class="pick"
        type="button"
        @click="config.addEndToEndFallback(r.providerId, r.model); fallbackOpen = false"
      >
        <span class="fb-text">
          <span class="fb-model">{{ r.model }}</span>
          <span class="fb-provider">{{ r.provider }}</span>
        </span>
        <CoomiIcon name="plus" :size="16" class="tick" />
      </button>
    </SheetShell>
  </SettingsPage>
</template>

<style scoped>
.pad { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.label {
  display: flex; align-items: baseline; justify-content: space-between; gap: var(--sp-2);
  margin: 0; font-size: var(--fs-label); color: var(--text-3);
}
.value { font-size: var(--fs-sub); color: var(--text-3); font-variant-numeric: tabular-nums; }
.hint { margin: var(--sp-2) 0 0; font-size: var(--fs-label); line-height: 1.55; color: var(--text-3); }
.fb { display: flex; align-items: center; gap: var(--sp-2); min-height: 52px; }
.idx {
  display: grid; place-items: center; flex: none; width: 22px; min-height: 22px; aspect-ratio: 1;
  border-radius: var(--r-sm); background: var(--fill-strong); color: var(--text-2);
  font-size: var(--fs-caption); font-weight: 600; font-variant-numeric: tabular-nums;
}
.fb-text { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 1px; }
.fb-model { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-family: var(--font-mono); font-size: var(--fs-sub); color: var(--text); }
.fb-provider { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-label); color: var(--text-3); }
.fb-btn {
  display: grid; place-items: center; flex: none; width: 30px; height: 30px;
  border: 1px solid var(--border); border-radius: var(--r-sm); background: var(--bg); color: var(--text-2);
}
.fb-btn.danger { color: var(--danger); }
.fb-btn:disabled { opacity: .3; }
.add {
  display: flex; align-items: center; justify-content: center; gap: var(--sp-1);
  width: 100%; min-height: 44px; margin-top: var(--sp-2);
  border: 1px dashed var(--blue-border); border-radius: var(--r-md);
  background: transparent; color: var(--blue); font-size: var(--fs-sub); font-weight: 600;
}
.pick { display: flex; align-items: center; gap: var(--sp-3); width: 100%; min-height: 56px; padding: var(--sp-2) 0; text-align: left; }
.tick { flex: none; color: var(--blue); }
</style>
