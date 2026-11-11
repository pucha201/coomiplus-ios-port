<script setup lang="ts">
/**
 * 页面过渡：用「方向」表达层级变化。
 *   forward（history 里 position 变大）→ 新页面从右进、旧页面向左退；
 *   back（position 变小）→ 从左进、向右退。
 * position 由 vue-router 自己维护：push 时 +1，pop 时回到较小的值。
 * 拿不到 position（首次进入 / 特殊内嵌环境）或 replace（position 不变）时，
 * 统一退化成「轻微上移 8px + 淡入」，不为此维护任何全局状态。
 *
 * 为什么要在外壳包 .page-host / .page-content 两层（而不是逐页去加入场）：
 *   1. 32 个页面里 19 个自己一行入场都没有，逐页改既慢又容易和同事的改动撞车。
 *      在外壳统一包一层，页面零改动就获得入场 —— .enter-page / .enter-flat 是
 *      global.css 里的公用类，时长与位移全部取自 --enter-* 令牌，页面无需知晓。
 *   2. 方向位移必须走 Vue <Transition>（靠 class 切换驱动 transition），
 *      而入场是「挂载即播一次」更适合 CSS animation。同一元素上 animation 的
 *      opacity/transform 会盖住 transition 的结果，两者不能叠在一层，
 *      所以拆成：外层 .page-host 只做方向过渡，内层 .page-content 只做入场。
 *   3. 两层都写成「透明」的弹性中继（flex 列 + min-height:0），
 *      被包的页面在布局上仍等价于以前直接挂在 #app 下面，
 *      页面自己的 .page{height:100%} / flex:1 都照常生效。
 */
import { ref } from 'vue'
import { RouterView, useRouter } from 'vue-router'
import ConnectionBanner from '@/components/ConnectionBanner.vue'
import FolderPicker from '@/components/FolderPicker.vue'
import UpdatePrompt from '@/components/UpdatePrompt.vue'
import { useConnectionContext } from '@/composables/useConnectionContext'
import { installKeyboardInsetWatcher } from '@/utils/keyboardInset'
import { installPerfHud } from '@/utils/perfHud'

// 连接上下文必须在根组件常驻：原生桥/任意页面都可能切设备或模式，
// 不能等聊天页挂载才去换会话历史。
useConnectionContext()
installPerfHud()
// 键盘占位兜底：visualViewport 差值写成 --kb-inset，与原生 insets 垫高互为备份。
installKeyboardInsetWatcher()

type Direction = 'forward' | 'back' | 'none'
const router = useRouter()
const direction = ref<Direction>('none')

function positionOf(): number | null {
  const state = router.options.history.state as unknown as { position?: number } | null
  return typeof state?.position === 'number' ? state.position : null
}

let lastPosition = positionOf()
// afterEach 的时机在 history 状态写入之后：那时 state.position 已经是新值，
// 与上一次的值比较即可判定前进 / 返回（同一 tick 内 value 会先于渲染更新）。
router.afterEach(() => {
  const next = positionOf()
  if (next == null || lastPosition == null || next === lastPosition) direction.value = 'none'
  else direction.value = next > lastPosition ? 'forward' : 'back'
  lastPosition = next
})
</script>

<template>
  <!-- 连接状态条：正常时不渲染、不占位；断线时覆盖在顶部（组件自身 position:fixed，
       所以不影响下面 .page-host 的 flex 布局）。 -->
  <FolderPicker />
  <UpdatePrompt />
  <RouterView v-slot="{ Component, route }">
    <Transition :name="`page-${direction}`" mode="out-in">
      <!-- key 用「路由记录的 path 模板」（如 /im/:roomId）而不是完整 path：
           换路由记录才等于换页面组件，这时才重播过渡与入场；
           同一记录的参数变化（/im/1 → /im/2）保持旧行为 —— 组件复用、不重播。
           用 route.path 会把每次参数变化都当成换页并强制重建组件，属于行为回退。 -->
      <div :key="route.matched[route.matched.length - 1]?.path ?? route.path" class="page-host">
        <!-- 有方向时外层已是纯淡入，内层同样纯淡入（.enter-flat）不叠加位移，
             不让两个方向的位移叠成斜着飞；无方向（首屏 / replace）时外层不位移，
             由内层 .enter-page 的「上移 8px + 淡入」收尾。 -->
        <div class="page-content" :class="direction === 'none' ? 'enter-page' : 'enter-flat'">
          <component :is="Component" />
        </div>
      </div>
    </Transition>
  </RouterView>
</template>

<style>
/* 页面过渡：时长 / 位移只取自 global.css 的 --enter-page-* 三件套。
   out-in 进退各 140ms，合计 280ms —— 在 320ms 总预算以内。 */
.page-forward-enter-active, .page-forward-leave-active,
.page-back-enter-active, .page-back-leave-active,
.page-none-enter-active, .page-none-leave-active {
  transition:
    opacity var(--enter-page-dur) var(--ease-out),
    transform var(--enter-page-dur) cubic-bezier(0.05, 0, 0.133, 1);
}
/* DeepSeek 式转场：位移只有 1.7%（取自其 slide_in/out 动画资源），
   配 fast_out_extra_slow_in 的路径曲线 —— 观感是「稳住换页」而不是「整屏横推」。
   前进：新页从右 1.7% 落位、旧页向左 1.7% 退出；返回反向。 */
.page-forward-enter-from { opacity: 0; transform: translateX(1.7%); }
.page-forward-leave-to { opacity: 0; transform: translateX(-1.7%); }
.page-back-enter-from { opacity: 0; transform: translateX(-1.7%); }
.page-back-leave-to { opacity: 0; transform: translateX(1.7%); }
/* 方向不可靠（取不到 position / replace）：外层不做空间移动，
   交给内层 .enter-page 的上移 8px + 淡入兜底。 */
.page-none-enter-from, .page-none-leave-to { opacity: 0; transform: none; }

/* 外壳两级容器：布局上等价于「把页面直接挂在 #app 下」。
   #app 是 flex 列，所以这里也做 flex 列中继并显式 min-height:0，
   页面根节点高度 100% 的百分比基准、以及 flex:1 的分配都与改动前一致。 */
.page-host, .page-content {
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 外壳补的这层内容入场默认开启；页面若自带动画、不想要这一层，
   在自己的根节点加 class="enter-off" 或 data-enter="off" 即可让位。
   用 :has() 而不是 JS 判断，是为了不碰页面、也不引入任何通信状态；
   浏览器不支持 :has() 时只是多播一次淡入，无副作用。 */
.page-content:has(.enter-off),
.page-content:has([data-enter='off']) { animation: none !important; }

/* ── 降级 1：系统级 prefers-reduced-motion ──
   页面过渡只留纯 opacity，位移归零（入场公用类在 global.css 里同样降级）。 */
@media (prefers-reduced-motion: reduce) {
  .page-forward-enter-active, .page-forward-leave-active,
  .page-back-enter-active, .page-back-leave-active,
  .page-none-enter-active, .page-none-leave-active {
    transition: opacity var(--enter-page-dur) linear !important;
  }
  .page-forward-enter-from, .page-forward-leave-to,
  .page-back-enter-from, .page-back-leave-to,
  .page-none-enter-from, .page-none-leave-to { transform: none !important; }
}

/* ── 降级 2：应用内「减弱动态效果」开关（<html data-motion="off">）──
   与上面的媒体查询同等待遇：不允许出现任何页面过渡位移。 */
[data-motion='off'] .page-forward-enter-active, [data-motion='off'] .page-forward-leave-active,
[data-motion='off'] .page-back-enter-active, [data-motion='off'] .page-back-leave-active,
[data-motion='off'] .page-none-enter-active, [data-motion='off'] .page-none-leave-active {
  transition: opacity var(--enter-page-dur) linear !important;
}
[data-motion='off'] .page-forward-enter-from, [data-motion='off'] .page-forward-leave-to,
[data-motion='off'] .page-back-enter-from, [data-motion='off'] .page-back-leave-to,
[data-motion='off'] .page-none-enter-from, [data-motion='off'] .page-none-leave-to {
  transform: none !important;
}
</style>
