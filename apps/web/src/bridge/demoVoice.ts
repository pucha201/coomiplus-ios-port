import { isDemoMode } from './demoMode'

/** 仅 ?demo=1 时启用：让浏览器里也能看到语音浮卡与上滑取消效果（不接真实识别）。 */
export function installDemoVoiceBridge(): void {
  if (!isDemoMode()) return
  const w = window as unknown as { CoomiAndroid?: Record<string, unknown> }
  const existing = w.CoomiAndroid as Record<string, unknown> | undefined
  if (existing?.startVoiceInput) return
  let timer: ReturnType<typeof setInterval> | undefined
  const emit = (name: string, detail: unknown) => window.dispatchEvent(new CustomEvent(name, { detail }))
  w.CoomiAndroid = {
    ...(existing || {}),
    getVoiceConfig: () => JSON.stringify({ engine: 'builtin', cloud: {}, voskReady: false, systemAvailable: true }),
    getVoiceEngine: () => 'builtin',
    startVoiceInput: () => {
      const samples = ['你好', '你好，帮我', '你好，帮我看一下', '你好，帮我看一下这个问题']
      let i = 0
      if (timer) clearInterval(timer)
      timer = setInterval(() => { emit('coomi:voice-partial', { text: samples[Math.min(i++, samples.length - 1)] }) }, 420)
    },
    stopVoiceInput: (cancel?: string) => {
      if (timer) { clearInterval(timer); timer = undefined }
      if (cancel === '1' || cancel === 'true') return
      emit('coomi:voice-result', { text: '你好，帮我看一下这个问题' })
    },
  }
  void w
}
