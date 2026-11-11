<script setup lang="ts">
/**
 * 设置首页（侧栏「控制台」进来的就是这一页）。
 *
 * 结构照 dsh-go 的枢纽页：大标题「设置」→ 搜索胶囊 → 六组意图分区。
 * 大标题随内容滚走；完全滑出后由顶栏小标题接住（阈值同 dsh-go AppPage）。
 * 首页只放入口，不放开关，也不放诊断信息。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useConfigStore, PERMISSION_MODES, REASONING_EFFORTS, THEME_MODES, UI_FONT_SCALES } from '@/stores/config'
import { useSessionsStore } from '@/stores/sessions'
import { useConnectionStore } from '@/stores/connection'
import { useDeviceStore } from '@/stores/device'
import { goBack } from '@/bridge/navigation'
import SettingsGroup from '@/components/settings/SettingsGroup.vue'
import SettingsRow from '@/components/settings/SettingsRow.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const router = useRouter()
const config = useConfigStore()
const sessions = useSessionsStore()
const connection = useConnectionStore()
const device = useDeviceStore()

const q = ref('')
const HUB_WORDS = ['ai', '模型', '厂商', '权限', '思考', '身份', '能力', '拓展', 'mcp', '钩子', '工作流',
  '外观', '主题', '字号', '通用', '运行环境', '语音', '隐私', '系统', '启动', '主机', '引擎', '电脑', '连接',
  '备份', '重试', '并发', '会话', '记忆', '帮助', '关于', '更新', '清理', '用量', '任务',
  '生命体', '数字生命', '日记', '心情', '记忆库']
const hit = (...words: string[]) => {
  const s = q.value.trim().toLowerCase()
  return !s || words.some(w => w.toLowerCase().includes(s))
}
const anyHit = () => hit(...HUB_WORDS)

const deviceLabel = ref('')
const modelLabel = ref('')
const permissionLabel = ref('')
const effortLabel = ref('')
const themeLabel = ref('')
const fontLabel = ref('')
function refreshLabels() {
  deviceLabel.value = device.mode === 'local' ? '本机' : (device.activeDevice?.name || '未选择电脑')
  modelLabel.value = config.currentModel || '未选择模型'
  permissionLabel.value = PERMISSION_MODES.find(m => m.mode === config.permissionMode)?.label ?? '询问'
  effortLabel.value = REASONING_EFFORTS.find(e => e.value === config.reasoningEffort)?.label ?? '自动'
  themeLabel.value = THEME_MODES.find(t => t.mode === config.themeMode)?.label ?? '跟随系统'
  fontLabel.value = UI_FONT_SCALES.find(s => s.value === config.uiFontScale)?.label ?? '较大'
}
refreshLabels()

/* ── 大标题滚动：完全滑出后用顶栏标题接住 ── */
const scroller = ref<HTMLElement | null>(null)
const titleEl = ref<HTMLElement | null>(null)
const headerHeight = ref(84)
const headerOpacity = ref(1)
const barTitleOpacity = ref(0)

/** 从二级页返回时恢复到上次的位置（同一次会话内）。 */
const SCROLL_KEY = 'coomi.settings.scroll.hub'

/**
 * 滚动里只做视觉计算；写 sessionStorage 是同步 IO，逐帧写会直接拖低滚动帧率。
 * 位置在停手 200ms 后落一次就够用（返回上一页时能接上即可）。
 */
let scrollSaveTimer: ReturnType<typeof setTimeout> | null = null
function onScroll() {
  const top = scroller.value?.scrollTop ?? 0
  const h = Math.max(1, headerHeight.value)
  headerOpacity.value = Math.max(0, Math.min(1, 1 - top / (h * 0.6)))
  barTitleOpacity.value = Math.max(0, Math.min(1, (top - h * 0.4) / 20))
  if (scrollSaveTimer) clearTimeout(scrollSaveTimer)
  scrollSaveTimer = setTimeout(() => {
    try { sessionStorage.setItem(SCROLL_KEY, String(scroller.value?.scrollTop ?? top)) } catch { /* 隐私模式 */ }
  }, 200)
}

let observer: ResizeObserver | null = null
onMounted(() => {
  void config.fetchProviders()
  const saved = Number(sessionStorage.getItem(SCROLL_KEY) ?? '0')
  if (saved > 0 && scroller.value) {
    scroller.value.scrollTop = saved
    onScroll()
  }
  if (titleEl.value && typeof ResizeObserver !== 'undefined') {
    observer = new ResizeObserver(() => {
      const h = titleEl.value?.offsetHeight ?? 0
      if (h) headerHeight.value = h + 6
    })
    observer.observe(titleEl.value)
  }
})
onBeforeUnmount(() => { observer?.disconnect() })
</script>

<template>
  <div class="page">
    <header class="bar">
      <!-- 毛玻璃底：滚动时内容从下面经过，顶栏始终有底，不会只剩两个裸控件。
           收到顶时底边线淡出，避免一进页面就有一条线。 -->
      <span
        class="bar-bg"
        aria-hidden="true"
        :style="{ opacity: Math.max(barTitleOpacity, 0.35), borderBottomColor: `color-mix(in srgb, var(--border) ${Math.round(barTitleOpacity * 100)}%, transparent)` }"
      />
      <button class="back" type="button" aria-label="返回" @click="goBack(router, '/')">
        <CoomiIcon name="back" :size="20" />
      </button>
      <span
        class="bar-title"
        :style="{ opacity: barTitleOpacity, transform: `translateY(${6 * (1 - barTitleOpacity)}px)` }"
      >设置</span>
      <span class="bar-end" />
    </header>

    <main ref="scroller" class="body" @scroll.passive="onScroll">
      <div ref="titleEl" class="hero" :style="{ opacity: headerOpacity }">
        <h1 class="hero-title">设置</h1>
        <p class="hero-sub">{{ deviceLabel }} · {{ connection.isOpen ? '引擎运行中' : '引擎未连接' }}</p>
      </div>

      <label class="search">
        <CoomiIcon name="search" :size="18" />
        <input v-model="q" type="search" placeholder="搜索设置" aria-label="搜索设置" />
        <button v-if="q" class="clear" type="button" aria-label="清空" @click.prevent="q = ''">
          <CoomiIcon name="close" :size="14" />
        </button>
      </label>

      <SettingsGroup v-if="hit('ai', '模型', '厂商', '权限', '思考', '身份')" title="AI">
        <SettingsRow
          icon="cpu"
          title="模型与厂商"
          :subtitle="`${config.providers.length} 个厂商`"
          :value="modelLabel"
          chevron
          @click="router.push('/providers')"
        />
        <SettingsRow
          icon="shield"
          title="权限与思考"
          subtitle="确认方式、思考强度、逆向与接力"
          :value="`${permissionLabel} · ${effortLabel}`"
          chevron
          @click="router.push('/settings/ai')"
        />
        <SettingsRow icon="sparkle" title="身份定位" :subtitle="config.customPrompt.trim() ? '已配置' : '未设置'" chevron @click="router.push('/persona')" />
      </SettingsGroup>

      <SettingsGroup v-if="hit('能力', '拓展', 'mcp', '钩子', '工作流')" title="能力">
        <SettingsRow icon="cube" title="拓展" subtitle="技能 · MCP · 注册源" chevron @click="router.push('/catalog')" />
        <SettingsRow icon="git" title="钩子" subtitle="在引擎事件上挂命令" chevron @click="router.push('/hooks')" />
        <SettingsRow icon="todo" title="工作流" subtitle="自动化流程" chevron @click="router.push('/workflows')" />
      </SettingsGroup>

      <SettingsGroup v-if="hit('生命体', '数字生命', '日记', '心情', '记忆库')" title="生命体">
        <SettingsRow
          icon="lifeRings"
          title="数字生命体"
          :subtitle="config.digitalLifeEnabled ? '常驻对话，会主动找你说话' : '已关闭'"
          chevron
          @click="router.push('/life')"
        />
        <SettingsRow icon="memory" title="生命体记忆库" subtitle="它记住的人与事" chevron @click="router.push('/life/memory')" />
        <SettingsRow icon="pencil" title="心情日记" subtitle="它每天写下的心情" chevron @click="router.push('/life/journal')" />
      </SettingsGroup>

      <SettingsGroup v-if="hit('外观', '主题', '字号')" title="外观">
        <SettingsRow
          icon="sun"
          title="主题与背景"
          subtitle="配色、聊天背景、界面字号"
          :value="`${themeLabel} · ${fontLabel}`"
          chevron
          @click="router.push('/appearance')"
        />
      </SettingsGroup>

      <SettingsGroup v-if="hit('通用', '运行环境', '语音', '隐私', '系统', '启动')" title="通用">
        <SettingsRow icon="terminal" title="运行环境与语音" subtitle="命令环境、语音引擎与测试" chevron @click="router.push('/settings/general')" />
        <SettingsRow icon="eye" title="隐私与系统" subtitle="匿名统计、本地留痕、启动首页与通知" chevron @click="router.push('/settings/general')" />
      </SettingsGroup>

      <SettingsGroup v-if="hit('主机', '引擎', '电脑', '连接', '备份', '重试', '并发', '会话', '记忆')" title="主机与数据">
        <SettingsRow
          icon="cpu"
          title="连接电脑"
          :subtitle="device.mode === 'local' ? '当前用本机引擎' : '当前用电脑引擎'"
          :value="deviceLabel"
          chevron
          @click="router.push('/devices')"
        />
        <SettingsRow
          icon="plug"
          title="引擎"
          subtitle="健康、诊断、镜像与日志"
          :value="connection.isOpen ? '运行中' : '未连接'"
          chevron
          @click="router.push('/runtime')"
        />
        <SettingsRow icon="refresh" title="连接与重试" subtitle="重试次数、并发、重连间隔" chevron @click="router.push('/settings/connection')" />
        <SettingsRow icon="chat" title="会话历史" :value="sessions.metas.length" chevron @click="router.push('/sessions')" />
        <SettingsRow icon="memory" title="记忆" subtitle="跨会话记忆" chevron @click="router.push('/memory')" />
        <SettingsRow icon="fileWrite" title="备份与还原" subtitle="会话、拓展、配置" chevron @click="router.push('/backup')" />
      </SettingsGroup>

      <SettingsGroup v-if="hit('帮助', '关于', '更新', '清理', '用量', '任务')" title="帮助与关于">
        <SettingsRow icon="todo" title="任务中心" chevron @click="router.push('/tasks')" />
        <SettingsRow icon="broom" title="清理维护" chevron @click="router.push('/maintenance')" />
        <SettingsRow icon="clock" title="用量统计" chevron @click="router.push('/usage')" />
        <SettingsRow icon="arrowDown" title="检查更新" chevron @click="router.push('/updates')" />
        <SettingsRow icon="sparkle" title="关于" subtitle="版本、诊断与系统入口" chevron @click="router.push('/about')" />
      </SettingsGroup>

      <p v-if="q && !anyHit()" class="no-hit">没有匹配「{{ q }}」的设置。</p>
      <p class="foot">设置即时生效；涉及引擎的重启项在下次连接时应用。</p>
    </main>
  </div>
</template>

<style scoped>
.page { position: relative; display: flex; flex-direction: column; height: 100%; background: var(--page); }

.bar {
  position: absolute; left: 0; right: 0; top: 0; z-index: var(--z-header);
  display: flex; align-items: center; gap: var(--sp-1);
  padding: calc(var(--safe-top) + var(--sp-2)) var(--sp-2) var(--sp-2);
  pointer-events: none;
}
/* 顶栏底：半透明页面色 + 背景模糊。只做一层静态合成，滚动时不再重绘。 */
.bar-bg {
  position: absolute; inset: 0;
  background: color-mix(in srgb, var(--page) 72%, transparent);
  -webkit-backdrop-filter: blur(18px) saturate(1.25);
  backdrop-filter: blur(18px) saturate(1.25);
  border-bottom: 1px solid transparent;
  transition: opacity var(--dur-fast) var(--ease-out);
  pointer-events: none;
}
.bar > * { pointer-events: auto; }
.back {
  display: grid; place-items: center; width: 40px; height: 40px; border-radius: 50%;
  background: color-mix(in srgb, var(--bg) 72%, transparent); color: var(--text);
  -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px);
  box-shadow: 0 1px 2px rgba(23, 32, 54, .06);
}
.bar-title {
  flex: 1; text-align: center; font-size: var(--fs-strong); font-weight: 600; color: var(--text);
  transition: opacity var(--dur-fast) var(--ease-out);
}
.bar-end { width: 40px; }

.body {
  flex: 1; min-height: 0; overflow-y: auto;
  padding: calc(var(--safe-top) + 52px) var(--sp-4) calc(var(--safe-bottom) + var(--sp-7));
  scrollbar-width: none;
}
.body::-webkit-scrollbar { display: none; }

/* 大标题：26 / 600，与 dsh-go headlineLarge 一致 */
.hero { padding: var(--sp-2) var(--sp-1) var(--sp-4); }
.hero-title { margin: 0; font-size: 26px; line-height: 1.3; font-weight: 600; letter-spacing: -.02em; color: var(--text); }
.hero-sub { margin: var(--sp-1) 0 0; font-size: var(--fs-sub); color: var(--text-3); }

.search {
  display: flex; align-items: center; gap: var(--sp-2);
  min-height: 44px; padding: 0 var(--sp-3) 0 var(--sp-4); margin-bottom: var(--sp-2);
  /* 方角（12）而不是胶囊：与设置卡片同一套圆角，搜索框不再比卡片更「圆」。 */
  border-radius: var(--r-md);
  background: color-mix(in srgb, var(--text) 5%, transparent);
  color: var(--text-3);
}
.search input {
  flex: 1; min-width: 0; min-height: 44px; padding: 10px 0; border: 0; background: transparent;
  color: var(--text); font-size: var(--fs-body-lg); outline: none;
}
.search input::placeholder { color: var(--text-3); }
.search input::-webkit-search-cancel-button { display: none; }
.clear {
  display: grid; place-items: center; flex: none;
  width: 22px; height: 22px; border-radius: 50%;
  background: color-mix(in srgb, var(--text) 10%, transparent); color: var(--text-2);
}

.no-hit { margin: var(--sp-7) 0; text-align: center; font-size: var(--fs-sub); color: var(--text-3); }
.foot { margin: var(--sp-7) 0 0; text-align: center; font-size: var(--fs-caption); color: var(--text-3); }
</style>
