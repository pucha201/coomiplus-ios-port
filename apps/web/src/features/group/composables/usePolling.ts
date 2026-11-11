/** 轮询：running 时 2s，idle 时 10s。 */
import { onUnmounted, watch, type Ref } from 'vue'

export function usePolling(
  running: Ref<boolean>,
  fn: () => void | Promise<void>,
  fastMs = 2000,
  slowMs = 10000,
) {
  let timer: ReturnType<typeof setInterval> | undefined

  function stop() {
    if (timer) clearInterval(timer)
    timer = undefined
  }

  function start() {
    stop()
    timer = setInterval(() => { void fn() }, running.value ? fastMs : slowMs)
  }

  watch(running, () => start())
  onUnmounted(stop)

  return { start, stop }
}
