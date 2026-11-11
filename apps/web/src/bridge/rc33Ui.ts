import cloudCss from '../../vendor/rc33-ui/coomi-cloud.css?raw'
import compatCss from '../../vendor/rc33-ui/compat-rc104.css?raw'

/**
 * rc33 界面层（只保留样式）。
 *
 * 历史上的 rc33 还有一套运行时脚本（vendor/rc33-ui/coomi-cloud.js），
 * 它会在首页与侧栏各插一个「本地 / 云端」切换器。那套东西和现在
 * 组件自己的入口重复：
 *   · 侧栏顶部是 SideDrawer 的 device-head（设备行）
 *   · 输入框下方是 Composer 的 dock chip（设备 / 工作目录）
 * 而且它用 !important 改写了空态布局，把主标题顶得不在视觉中心。
 * 所以脚本注入被移除，这里只负责把样式压到最后。
 */
let stylesInstalled = false
let headObserver: MutationObserver | null = null

function injectStyle(css: string, id: string): void {
  if (document.getElementById(id)) return
  const style = document.createElement('style')
  style.id = id
  style.textContent = css
  document.head.appendChild(style)
}

/**
 * 路由 chunk 的 CSS 是**懒加载**的：`ChatView-*.css` 会在本文件注入之后才进 head。
 * 同特异性时后来者胜 —— 于是 scoped 的 `.shell[data-v-xxx]{ background: … }`
 * 会把我们的 `.chat > .shell` 反压掉（缺陷 3「背景透明」就是栽在这里）。
 * 这里盯住 head：每有新样式表进来，就把我们的 style 重新挪到末尾，保证始终最后生效。
 */
function keepStyleLast(id: string): void {
  if (headObserver || typeof MutationObserver === 'undefined') return
  headObserver = new MutationObserver(() => {
    const style = document.getElementById(id)
    if (!style) return
    if (style.nextSibling && style.nextSibling.nodeType === 1) {
      document.head.appendChild(style)   // appendChild 会自动把它移动到末尾
    }
  })
  headObserver.observe(document.head, { childList: true })
}

/**
 * 只注入样式，可在首帧渲染前调用。
 * 抽屉面板的定位/隐藏全在这张表里：晚 350ms 注入时，首帧会先按
 * SideDrawer 自己的绝对定位把整栏文字画在对话页上（用户看到的「叠加」）。
 */
export function installRc33Styles(): void {
  if (stylesInstalled) return
  stylesInstalled = true
  try {
    injectStyle(cloudCss + String.fromCharCode(10) + compatCss, 'rc33-ui-style')
    keepStyleLast('rc33-ui-style')
  } catch (error) {
    console.error('[rc33-ui] style install failed', error)
  }
}
