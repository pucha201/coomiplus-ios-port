<script setup lang="ts">
/**
 * 外观：主题色卡 + 界面字号 + 列表密度 + 动效档位。
 * 主题用色卡而不是长列表 —— 一屏看全 10 套，点一下就能预览。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore, THEME_MODES, UI_FONT_SCALES, LIST_DENSITIES } from '@/stores/config'
import { goBack } from '@/bridge/navigation'
import SettingsPage from '@/components/settings/SettingsPage.vue'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import SegmentedPill from '@/components/settings/SegmentedPill.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const config = useConfigStore()
const customAppearanceEnabled = ref(document.documentElement.dataset.customAppearance === 'true')

/** 每套主题的色卡：底色 + 主色 + 文字色，直接写在这个文件里，避免额外请求。 */
const SWATCH: Record<string, { bg: string; card: string; accent: string; text: string }> = {
  system: { bg: '#f2f5f9', card: '#ffffff', accent: '#2d61c6', text: '#1b1e23' },
  light: { bg: '#f2f5f9', card: '#ffffff', accent: '#2d61c6', text: '#1b1e23' },
  dark: { bg: '#0f1319', card: '#161b22', accent: '#6b8ef0', text: '#e8edf5' },
  book: { bg: '#eee6d7', card: '#fffaf0', accent: '#496957', text: '#2d3028' },
  orange: { bg: '#fff7f1', card: '#ffffff', accent: '#a94f12', text: '#28231f' },
  ink: { bg: '#0b110f', card: '#141d19', accent: '#63b894', text: '#e8eee9' },
  abyss: { bg: '#081018', card: '#111d27', accent: '#55b8cf', text: '#e5edf2' },
  ember: { bg: '#110f0e', card: '#201a18', accent: '#d18a62', text: '#eee9e5' },
  celadon: { bg: '#edf3ef', card: '#ffffff', accent: '#39745d', text: '#202a25' },
  linen: { bg: '#f1f0ec', card: '#fffefa', accent: '#4f607f', text: '#262728' },
}

/** 动效档位：标准 / 灵动（少量回弹）/ 关闭。写到 <html data-motion>，全局 CSS 已按它降级。 */
type MotionTier = 'standard' | 'fluid' | 'off'
const MOTION_KEY = 'coomi.motionTier'
const motionTier = ref<MotionTier>((localStorage.getItem(MOTION_KEY) as MotionTier) ?? 'standard')
function applyMotion(tier: MotionTier) {
  motionTier.value = tier
  localStorage.setItem(MOTION_KEY, tier)
  const root = document.documentElement
  root.dataset.motion = tier === 'off' ? 'off' : tier === 'fluid' ? 'fluid' : ''
  root.dataset.motionTier = tier
}
applyMotion(motionTier.value)

const fontSample = computed(() => ({ 1: '12.5px', 1.08: '14px', 1.18: '15.5px' } as Record<number, string>))

function syncCustomAppearance() {
  customAppearanceEnabled.value = document.documentElement.dataset.customAppearance === 'true'
}
onMounted(() => window.addEventListener('coomi:appearance-changed', syncCustomAppearance))
onBeforeUnmount(() => window.removeEventListener('coomi:appearance-changed', syncCustomAppearance))

function back() { goBack(router, '/settings') }
</script>

<template>
  <SettingsPage title="外观" :back="back">
    <SettingsGroup title="主题" :note="customAppearanceEnabled ? '当前由系统接管' : undefined">
      <div class="swatches" :class="{ disabled: customAppearanceEnabled }">
        <button
          v-for="m in THEME_MODES"
          :key="m.mode"
          class="swatch"
          type="button"
          :class="{ on: config.themeMode === m.mode }"
          :disabled="customAppearanceEnabled"
          :aria-label="m.label"
          @click="config.setThemeMode(m.mode)"
        >
          <span class="chip" :style="{ background: SWATCH[m.mode]?.bg, borderColor: SWATCH[m.mode]?.card }">
            <span class="chip-card" :style="{ background: SWATCH[m.mode]?.card }">
              <span class="chip-line" :style="{ background: SWATCH[m.mode]?.text, opacity: .75 }" />
              <span class="chip-line short" :style="{ background: SWATCH[m.mode]?.text, opacity: .35 }" />
            </span>
            <span class="chip-dot" :style="{ background: SWATCH[m.mode]?.accent }" />
          </span>
          <span class="swatch-label">{{ m.label }}</span>
          <CoomiIcon v-if="config.themeMode === m.mode" name="check" :size="14" class="swatch-tick" />
        </button>
      </div>
      <SettingsRow
        v-if="customAppearanceEnabled"
        icon="alert"
        title="主题由系统接管"
        subtitle="跟随壁纸取色时，这里的选择不生效"
      />
    </SettingsGroup>

    <SettingsGroup title="界面字号">
      <div class="pad">
        <SegmentedPill
          :options="UI_FONT_SCALES.map(s => ({ value: s.value, label: s.label }))"
          :model-value="config.uiFontScale"
          @update:model-value="v => config.setUiFontScale(Number(v) as 1 | 1.08 | 1.18)"
        />
        <p class="sample" :style="{ fontSize: fontSample[config.uiFontScale] }">
          海内存知己，天涯若比邻
        </p>
      </div>
    </SettingsGroup>

    <SettingsGroup title="列表密度">
      <div class="pad">
        <SegmentedPill
          :options="LIST_DENSITIES.map(d => ({ value: d.value, label: d.label }))"
          :model-value="config.listDensity"
          @update:model-value="v => config.setListDensity(v as 'cozy' | 'compact')"
        />
      </div>
    </SettingsGroup>

    <SettingsGroup title="动效">
      <div class="pad">
        <SegmentedPill
          :options="[{ value: 'standard', label: '标准' }, { value: 'fluid', label: '灵动' }, { value: 'off', label: '关闭' }]"
          :model-value="motionTier"
          @update:model-value="v => applyMotion(v as MotionTier)"
        />
        <p class="hint">
          {{ motionTier === 'off'
            ? '关闭后所有过渡瞬时完成，动画不参与布局。'
            : motionTier === 'fluid'
              ? '灵动：按压有轻微回弹，列表可回弹，其余动画只加位移与缩放。'
              : '标准：克制的一次性过渡，不回弹。' }}
        </p>
      </div>
    </SettingsGroup>
  </SettingsPage>
</template>

<style scoped>
.swatches {
  display: grid; grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: var(--sp-3); padding: var(--sp-3) var(--sp-4) var(--sp-4);
}
.swatches.disabled { opacity: .5; }
.swatch {
  position: relative; display: flex; flex-direction: column; align-items: stretch; gap: var(--sp-1);
  padding: 0; text-align: left;
}
.chip {
  position: relative; display: block; height: 62px;
  border-radius: var(--r-md); border: 1px solid transparent;
  overflow: hidden;
  transition: transform var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out);
}
.swatch:active .chip { transform: scale(var(--press-scale)); }
.swatch.on .chip { box-shadow: 0 0 0 2px var(--blue); }
.chip-card {
  position: absolute; left: 8px; right: 8px; top: 10px; bottom: 10px;
  border-radius: var(--r-sm); padding: 7px 6px;
  display: flex; flex-direction: column; gap: var(--sp-1); justify-content: center;
}
.chip-line { display: block; height: 4px; border-radius: 2px; }
.chip-line.short { width: 60%; }
.chip-dot {
  position: absolute; right: 6px; bottom: 6px;
  width: 12px; height: 12px; border-radius: 50%;
}
.swatch-label {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-label); color: var(--text-2); text-align: center;
}
.swatch.on .swatch-label { color: var(--blue); font-weight: 600; }
.swatch-tick { position: absolute; right: var(--sp-1); top: var(--sp-1); color: var(--blue); }

.pad { padding: var(--sp-3) var(--sp-4) var(--sp-4); }
.sample { margin: var(--sp-3) 0 0; text-align: center; color: var(--text); line-height: 1.6; }
.hint { margin: var(--sp-3) 0 0; font-size: var(--fs-label); line-height: 1.55; color: var(--text-3); }
</style>
