import { watch } from 'vue'
import { apiGet } from '@/bridge/http'
import { useDeviceStore } from '@/stores/device'
import { useSessionStore } from '@/stores/session'
import { pickDirectory } from '@/utils/folderPicker'
import { pairingLine } from '@/utils/pairingCountdown'

/** rc33 界面层与真实状态之间的桥：只暴露必要字段，补丁优先使用它。 */
export function installCoomiUiBridge(): void {
  const w = window as unknown as { __coomiBridge?: unknown }
  if (w.__coomiBridge) return
  const device = useDeviceStore()
  const session = useSessionStore()
  // 在线状态是后台探活改的，Vue 重绘收不到，得主动通知 rc33 界面层同步一次。
  watch(() => device.devices.map(item => `${item.id}:${item.reachability}`).join('|'), () => {
    if (typeof window !== 'undefined') window.dispatchEvent(new Event('coomi:device-status'))
  })
  w.__coomiBridge = {
    getMode: () => device.mode,
    setMode: (mode: 'local' | 'cloud') => device.setMode(mode),
    getDeviceId: () => device.deviceId,
    selectDevice: (id: string) => { if (id) device.selectDevice(id) },
    devices: () => device.devices.map(item => {
      // 配对剩余时长的措辞走 utils/pairingCountdown，和桌面端「已配对设备」同源：
      // 引擎是滑动续期，两端都不能把它报成「马上断开」；被撤销的设备干脆不报时长。
      const pairing = pairingLine({
        expiresAt: item.expiresAt,
        revoked: item.remoteRevoked,
        expiredText: '配对已过期，请在电脑上重新生成连接码',
        revokedText: '已在电脑上撤销，需在电脑重新生成连接码',
      })
      return {
        id: item.id,
        name: item.name || item.id,
        host: (item.engineBase || '').replace(/^https?:\/\//, '') || '未连接',
        online: item.reachability === 'online',
        pairingText: pairing?.text ?? '配对有效期未知',
        pairingTone: pairing?.tone ?? 'ok',
      }
    }),
    addDevice: async (payload: string) => {
      const added = await device.addDeviceByCode(payload)
      return added ? { id: added.id, name: added.name } : null
    },
    removeDevice: (id: string) => { void device.deleteDevice(id) },
    listDir: async (path: string) => {
      const query = '/api/device/remote-fs/list?path=' + encodeURIComponent(path || '')
      const data = await apiGet<{ path: string; entries: Array<{ name: string; is_dir: boolean; path?: string }> }>(query)
      return data
    },
    pickFolder: (opts?: { start?: string }) => {
      const start = opts && typeof opts.start === 'string' ? opts.start : (session.cwd || '')
      return pickDirectory(start)
    },
    scan: () => new Promise<string>((resolve, reject) => {
      const bridge = (window as unknown as { CoomiAndroid?: { scanQrCode?: () => void } }).CoomiAndroid
      if (!bridge?.scanQrCode) { reject(new Error('当前环境不支持扫码')); return }
      const onResult = (event: Event) => {
        window.removeEventListener('coomi:qr-scan-result', onResult as EventListener)
        const text = (event as CustomEvent<{ text?: string }>).detail?.text ?? ''
        if (text) resolve(text); else reject(new Error('已取消扫码'))
      }
      window.addEventListener('coomi:qr-scan-result', onResult as EventListener)
      bridge.scanQrCode()
    }),
    getDir: () => session.cwd || '',
    setDir: (path: string) => { if (path) void session.setSessionCwd(path) },
    getStatus: () => {
      const active = device.activeDevice
      if (!active) return { online: false, text: '未选择设备' }
      return { online: active.reachability === 'online', text: (active.reachability === 'online' ? '已连接 ' : '待连接 ') + (active.name || active.id) }
    },
  }
}
