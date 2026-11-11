/**
 * 本地 TTS 工具：优先 Android 系统 TTS 桥，回退 Web SpeechSynthesis。
 */
export function ttsAvailable(): boolean {
  if (typeof window === 'undefined') return false
  if (window.CoomiAndroid?.isTtsAvailable) return window.CoomiAndroid.isTtsAvailable()
  return Boolean((window as any).speechSynthesis)
}

export function speakLocal(text: string, rate = 1): void {
  const t = (text || '').trim()
  if (!t) return
  if (window.CoomiAndroid?.speak) {
    window.CoomiAndroid.speak(t, rate)
    return
  }
  try {
    const synth = (window as any).speechSynthesis
    if (!synth) return
    synth.cancel()
    const u = new SpeechSynthesisUtterance(t)
    u.lang = 'zh-CN'
    u.rate = Math.max(0.5, Math.min(2, rate))
    synth.speak(u)
  } catch { /* ignore */ }
}

export function stopSpeakLocal(): void {
  window.CoomiAndroid?.stopSpeak?.()
  try {
    ;(window as any).speechSynthesis?.cancel()
  } catch { /* ignore */ }
}
