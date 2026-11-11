<script setup lang="ts">
/**
 * 连接状态细条（ConnectionBanner）。
 *
 * 背景：stores/connection.ts 一直在维护完整连接状态，但界面上没有一处把它呈现出来，
 * 用户看不到"现在是不是断的"。这里给顶部一条细条，三态：
 *   · 正常（open / 首次 connecting）→ 不渲染、不占位；
 *   · 重连中 → 警告色 + "正在重连…"（附传输给的进度文案）；
 *   · 已断开（closed / error）→ 危险色 + 「已断开」，附传输给的断开原因；
 *     整条可点：云端未选设备时点开设备选择，其余情况点击重试。
 *
 * 位置：App.vue 把每个页面包进 .page-host / .page-content 两层 flex 中继（flex:1 1 auto）。
 * 细条本身 position:fixed，不进页面布局；但固定覆盖会压住顶栏的返回/菜单按钮
 * （云端未选设备时点「菜单」会变成「选择设备」）。所以组件同时渲染一个 28px 的
 * 悬浮胶囊：不再使用流内占位（那会把页面整体顶下去）。
 * safe-top —— 页面顶栏自己会垫 safe-top，两者相加正好落在细条内容下方。
 * 挂载位置：App.vue 模板里 <RouterView> 之前，一行 <ConnectionBanner />。
 * 动效只用两样：透明度淡入淡出 + grid-template-rows 0fr↔1fr 展开（不碰 height）。
 */
import { computed, ref } from 'vue'
import { useConnectionStore } from '@/stores/connection'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { presenceNote } from '@/utils/hostPresence'
import CoomiIcon from './CoomiIcon.vue'
import DeviceSwitcherSheet from './DeviceSwitcherSheet.vue'

const connection = useConnectionStore()
const device = useDeviceStore()
const session = useSessionStore()

type BannerPhase = 'hidden' | 'attempting' | 'reconnecting' | 'offline'

const phase = computed<BannerPhase>(() => {
  // 演示模式底下接的是脚本，不是真引擎，"断开"没有意义 —— 一律不显示。
  if (connection.demo) return 'hidden'
  switch (connection.state) {
    case 'reconnecting': return 'reconnecting'
    case 'closed':
    case 'error': return 'offline'
    // 云端降级链（直连→中转→局域网）最长要十几秒。这段路以前什么都不显示，
    // 用户只看见界面卡住；现在中性地报「正在尝试哪条通道」。本机模式没有降级链，照旧不显示。
    case 'connecting': return connection.attribution && !connection.attribution.connected ? 'attempting' : 'hidden'
    // open 与首次 connecting 都算正常：启动瞬间不该闪一条"断开"。
    default: return 'hidden'
  }
})

const offline = computed(() => phase.value === 'offline')
/**
 * 电脑应答了 = 故障在通道；没应答 = 电脑大概率没开/不在同一网络。
 * 这条结论比「哪条通道超时」更能告诉用户下一步做什么，所以优先显示。
 */
const presence = computed(() => phase.value === 'attempting' ? null : presenceNote(device.hostProbe))
/**
 * 云端优先报「哪条通道、为什么」（attribution），本机没有降级链，退回重连进度文案。
 * 重连次数仍在状态条里，不在这儿挤两句。
 */
const retryDetail = computed(() => presence.value || connection.attribution?.detail || connection.retryMessage?.trim() || '')
/** 终态断开的原因（OfflineTransport 会带 reason，例如云端未选设备）。 */
const offlineReason = computed(() => presence.value || connection.attribution?.detail || connection.offlineReason?.trim() || '')
/** 云端模式但还没选电脑：这是「缺一步操作」，不是「连接坏了」，重试没有意义。 */
const needsDevice = computed(() => device.mode === 'cloud' && !device.deviceId)
/** 探活确认电脑那边没人应答：再点一次「重试」也只是重播同一次失败，直接把它带到设备页。 */
const hostSilent = computed(() => device.mode === 'cloud' && device.hostProbe?.reachable === false)
// rc33 的运行时 UI 已经不再注入，这里直接打开组件化的设备列表。
const deviceSheetOpen = ref(false)
const openDeviceSheet = () => {
  deviceSheetOpen.value = true
  return true
}
const offlineHint = computed(() => needsDevice.value ? '点此选择要连接的电脑' : (hostSilent.value ? '点此检查设备与连接码' : (offlineReason.value || '点击重试')))

/** 重试 = 复用既有 session.reconnect()（重建 WS，游标交给 resync 补齐）。 */
function retry() {
  if (!offline.value) return
  if ((needsDevice.value || hostSilent.value) && openDeviceSheet()) return
  // 重连前先按 deviceId 在局域网里找一次新地址：电脑换了 IP/端口时，
  // 直接用旧地址重连等于把同一次失败再播一遍。
  void device.healEndpoint().catch(() => false).finally(() => session.reconnect())
}
</script>

<template>
  <!-- 连接条是 fixed 的，必须由这个流内占位把页面让下来 28px：
       否则顶栏返回/菜单按钮正好落在条下面，点击会被「选择设备」抢走。 -->
  <Transition name="conn">
    <div
      v-if="phase !== 'hidden'"
      class="banner"
      :class="'is-' + phase"
      role="status"
      aria-live="polite"
    >
      <!-- .rail 是 grid 子项：只有它 overflow:hidden + min-height:0，0fr 才能真塌陷。 -->
      <div class="rail">
        <!-- 断开：整条是按钮。云端还没选设备时点它打开设备选择，
             而不是重建一条注定失败的连接。 -->
        <button
          v-if="offline"
          class="bar"
          type="button"
          :aria-label="needsDevice ? '云端未选择电脑，点击选择设备' : (hostSilent ? '电脑没有应答，点击查看设备与连接码' : '连接已断开，点击重试')"
          @click="retry"
        >
          <CoomiIcon name="plug" :size="13" />
          <span class="txt">{{ needsDevice ? '未选择电脑' : '已断开' }}</span>
          <span class="sub">{{ offlineHint }}</span>
          <CoomiIcon :name="needsDevice ? 'chevronRight' : 'refresh'" :size="13" class="act" />
        </button>
        <div v-else class="bar">
          <span class="dot" aria-hidden="true" />
          <span class="txt">{{ phase === 'attempting' ? '正在连接电脑' : '正在重连…' }}</span>
          <span v-if="retryDetail" class="sub">{{ retryDetail }}</span>
        </div>
      </div>
    </div>
  </Transition>
  <Teleport to="body">
    <DeviceSwitcherSheet :open="deviceSheetOpen" @close="deviceSheetOpen = false" />
  </Teleport>
</template>

<style scoped>
/* 悬浮胶囊：落在顶栏下方，fixed + 圆角，不占任何布局空间。 */
.banner {
  position: fixed;
  top: calc(var(--safe-top, 0px) + 44px);
  left: 12px; right: 12px;
  border-radius: var(--r-md);
  overflow: hidden;
  box-shadow: var(--shadow-2);
  z-index: var(--z-header, 20);
  display: grid;
  /* 高度展开全靠这一行：0fr ↔ 1fr，不写 height，展开/收起都能过渡。 */
  grid-template-rows: 1fr;
  pointer-events: none; /* 条本身不拦触摸；只有可点的 .bar 接管，避免遮住页面点击。 */
}
.rail { overflow: hidden; min-height: 0; }
.bar {
  display: flex;
  align-items: center;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  /* 内容高 18px + 上下 5px = 28px（≤32px）；safe-top 让细条落在状态栏下面。 */
  padding: 7px var(--sp-3);
  font-size: var(--fs-label);
  line-height: var(--lh-label);
  font-weight: 500;
}
button.bar { pointer-events: auto; text-align: left; cursor: pointer; }
button.bar:active { opacity: .8; }
.banner.is-reconnecting { background: var(--warn-soft); color: var(--warn); box-shadow: inset 0 -1px 0 var(--border); }
.banner.is-offline { background: var(--danger-soft); color: var(--danger); box-shadow: inset 0 -1px 0 var(--border); }
/* 正在尝试某条通道不是故障：中性底色，只在文字里说清走到哪条路，避免一进来就红一条。 */
.banner.is-attempting { background: var(--fill); color: var(--text-3); box-shadow: inset 0 -1px 0 var(--border); }
.banner.is-attempting .dot { animation: conn-dot-pulse 1.2s ease-in-out infinite; }
@keyframes conn-dot-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
.dot { flex-shrink: 0; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.txt { flex-shrink: 0; }
.sub {
  flex: 1; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-weight: 400; opacity: .82;
}
.act { flex-shrink: 0; }

/* 动效：淡入淡出 + grid-template-rows 展开，不碰 height。 */
.conn-enter-active, .conn-leave-active {
  transition:
    grid-template-rows var(--dur-base, 220ms) var(--ease-out), opacity var(--dur-fast, 140ms) var(--ease-out);
}
.conn-enter-from, .conn-leave-to { grid-template-rows: 0fr; opacity: 0; }
.conn-enter-to, .conn-leave-from { grid-template-rows: 1fr; opacity: 1; }

/* 减弱动态效果：高度直接维持 1fr，只做淡入淡出（系统与 data-motion 两个入口都认）。 */
@media (prefers-reduced-motion: reduce) {
  .conn-enter-active, .conn-leave-active { transition: opacity var(--dur-fast) linear; }
  .conn-enter-from, .conn-leave-to { grid-template-rows: 1fr; }
  .banner.is-attempting .dot { animation: none; opacity: 1; }
}
:root[data-motion='off'] .conn-enter-active,
:root[data-motion='off'] .conn-leave-active { transition: opacity var(--dur-fast) linear; }
:root[data-motion='off'] .conn-enter-from,
:root[data-motion='off'] .conn-leave-to { grid-template-rows: 1fr; }
</style>
