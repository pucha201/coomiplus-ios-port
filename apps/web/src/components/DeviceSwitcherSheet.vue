<script setup lang="ts">
/**
 * 设备切换 / 添加电脑。侧边栏与首页输入栏共用。
 * 设备名直接显示电脑名，不再出现「云端」这种抽象词。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'
import { useDeviceStore } from '@/stores/device'
import { pairingExpired } from '@/utils/pairing'

const props = defineProps<{ open: boolean }>()
const emit = defineEmits<{ close: [] }>()

const device = useDeviceStore()
const code = ref('')
const busy = ref(false)
const error = ref('')
const scanState = ref<'idle' | 'scanning' | 'error'>('idle')
/** 删除是两段式：先点垃圾桶，再点“删除”，避免 WebView 吞掉 confirm()。 */
const pendingDelete = ref('')
async function confirmDelete(id: string): Promise<void> {
  pendingDelete.value = ''
  await device.deleteDevice(id)
}

const localActive = computed(() => device.mode === 'local')
const diag = computed(() => (device.mode === 'cloud' ? device.linkDiag : null))
const diagLabel = computed(() => {
  const d = diag.value
  if (!d) return ''
  return d.channel === 'iroh' ? 'iroh 隧道' : d.channel === 'lan' ? '局域网' : '未连接'
})
const diagDetail = computed(() => {
  const d = diag.value
  if (!d) return ''
  const parts: string[] = []
  if (d.irohMs) parts.push('iroh ' + d.irohMs + 'ms')
  if (d.lanMs) parts.push('局域网 ' + d.lanMs + 'ms')
  if (d.error) parts.push(d.error)
  return parts.join(' · ') || '尚未探测'
})
/** 重新检测：重新走一遍「iroh 验活 → 局域网探活 → UDP 找回」。 */
const redetect = () => {
  const id = device.deviceId
  if (id && !busy.value) void device.selectDevice(id)
}
const devices = computed(() => device.devices)
const activeId = computed(() => device.deviceId)

watch(() => props.open, async open => {
  // 设备面板也是一层浮层：展开时系统返回先收起它。
  if (open) registerOverlay('device-switcher', () => emit('close'))
  else unregisterOverlay('device-switcher')
  if (!open) return
  error.value = ''
  device.error = null
  code.value = ''
  scanState.value = 'idle'
  try { await device.refreshDevices() } catch { /* 离线也能切本地 */ }
}, { immediate: true })
onBeforeUnmount(() => unregisterOverlay('device-switcher'))

function deviceState(item: { expiresAt?: number; reachability: string; remoteRevoked?: boolean }): string {
  if (item.remoteRevoked) return '已在电脑上移除'
  if (pairingExpired(item.expiresAt)) return '配对已过期'
  return item.reachability === 'online' ? '在线' : '离线/未检查'
}

async function useLocal() {
  device.setMode('local')
  emit('close')
}

async function useDevice(id: string) {
  busy.value = true
  error.value = ''
  try {
    await device.selectDevice(id)
    await device.checkEngine()
    emit('close')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
}

async function pasteCode() {
  try {
    code.value = await navigator.clipboard.readText()
  } catch {
    error.value = '无法读取剪贴板，请手动粘贴连接码'
  }
}

function scanQr() {
  scanState.value = 'scanning'
  const bridge = (window as unknown as { CoomiAndroid?: { scanQrCode?: () => void } }).CoomiAndroid
  if (bridge?.scanQrCode) bridge.scanQrCode()
  else {
    scanState.value = 'error'
    error.value = '扫码仅支持 Android 相机'
  }
}

async function addDevice() {
  const value = code.value.trim()
  if (!value) return
  busy.value = true
  error.value = ''
  try {
    const added = await device.addDeviceByCode(value)
    if (!added) throw new Error(device.error || '连接码无效或已过期')
    code.value = ''
    await device.checkEngine()
    emit('close')
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    busy.value = false
  }
}

const onScan = (event: Event) => {
  if (!props.open) return
  const text = (event as CustomEvent<{ text?: string }>).detail?.text?.trim()
  scanState.value = 'idle'
  if (text) {
    code.value = text
    void addDevice()
  }
}
window.addEventListener('coomi:qr-scan-result', onScan)
onBeforeUnmount(() => window.removeEventListener('coomi:qr-scan-result', onScan))
</script>

<template>
  <div v-if="open" class="mask" @click.self="emit('close')">
    <section class="sheet">
      <div class="grip" />
      <header class="head">
        <span class="tile"><CoomiIcon name="cpu" :size="20" /></span>
        <div class="title">
          <h2>选择设备</h2>
          <p>本机直接运行；电脑需要先配对。</p>
        </div>
        <button class="x" aria-label="关闭" @click="emit('close')"><CoomiIcon name="close" :size="16" /></button>
      </header>

      <div class="list">
        <button class="row" :class="{ on: localActive }" @click="useLocal">
          <span class="icon"><CoomiIcon name="phone" :size="17" /></span>
          <span class="info"><b>本机</b><small>使用手机里的本地引擎</small></span>
          <span v-if="localActive" class="check"><CoomiIcon name="check" :size="15" /></span>
          <CoomiIcon v-else name="chevronRight" :size="14" class="chev" />
        </button>

        <div
          v-for="item in devices"
          :key="item.id"
          class="row"
          :class="{ on: item.id === activeId && !localActive, disabled: busy }"
          role="button"
          tabindex="0"
          @click="useDevice(item.id)"
          @keydown.enter="useDevice(item.id)"
        >
          <span class="icon"><CoomiIcon name="cpu" :size="17" /></span>
          <span class="info">
            <b>{{ item.name || item.id }}</b>
            <small>{{ deviceState(item) }}</small>
          </span>
          <template v-if="pendingDelete === item.id">
            <button class="del-confirm" :disabled="busy" @click.stop="confirmDelete(item.id)">删除</button>
            <button class="del-cancel" @click.stop="pendingDelete = ''">取消</button>
          </template>
          <template v-else>
            <span v-if="item.id === activeId && !localActive" class="check"><CoomiIcon name="check" :size="15" /></span>
            <CoomiIcon v-else name="chevronRight" :size="14" class="chev" />
            <button class="del" aria-label="删除这台电脑" title="删除这台电脑" @click.stop="pendingDelete = item.id">
              <CoomiIcon name="trash" :size="15" />
            </button>
          </template>
        </div>

        <p v-if="!devices.length" class="empty">还没有添加电脑。粘贴电脑上的连接码，或扫码添加。</p>
      </div>

      <div v-if="diag" class="diag">
        <span class="diag-k">当前通道</span>
        <span class="diag-v">{{ diagLabel }}</span>
        <span class="diag-d">{{ diagDetail }}</span>
        <button class="diag-btn" :disabled="busy" @click="redetect">重新检测</button>
      </div>

      <div class="add">
        <h3>添加电脑</h3>
        <label class="field">
          <span>连接码</span>
          <input v-model="code" placeholder="coomi://… 或 JSON" autocomplete="off" />
        </label>
        <p v-if="scanState === 'scanning'" class="note">正在打开相机…</p>
        <p v-if="error || device.error" class="error">{{ error || device.error }}</p>
        <div class="actions">
          <button class="btn ghost" type="button" @click="pasteCode">粘贴</button>
          <button class="btn ghost" type="button" @click="scanQr">扫码</button>
          <button class="btn primary" type="button" :disabled="busy || !code.trim()" @click="addDevice">
            {{ busy ? '连接中…' : '连接电脑' }}
          </button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; z-index: var(--z-sheet);
  display: flex; align-items: flex-end; justify-content: center;
  padding: var(--sp-2); background: rgba(0, 0, 0, .45);
}
.sheet {
  width: 100%; max-width: 560px; max-height: 88vh; overflow-y: auto;
  padding: var(--sp-2) var(--sp-4) calc(var(--sp-4) + var(--safe-bottom));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0;
  background: var(--bg); box-shadow: var(--shadow-sheet);
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grip { width: var(--sp-8); height: var(--sp-1); margin: 0 auto var(--sp-3); border-radius: var(--r-pill); background: var(--fill-strong); }
.head { display: flex; align-items: center; gap: var(--sp-2); }
.tile { display: grid; place-items: center; width: var(--sp-9); height: var(--sp-9); border-radius: var(--r-md); background: var(--blue-soft); color: var(--blue); }
.title { flex: 1; min-width: 0; }
.title h2 { margin: 0; color: var(--text); font-size: var(--fs-strong); font-weight: 700; }
.title p { margin: 2px 0 0; color: var(--text-3); font-size: var(--fs-caption); }
.x { display: grid; place-items: center; width: var(--sp-8); height: var(--sp-8); border: 0; border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); }
.list { display: flex; flex-direction: column; gap: var(--sp-1); margin-top: var(--sp-4); }
.row {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  min-height: 54px; padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); text-align: left;
}
.row.on { border-color: var(--blue-border); background: var(--blue-soft); }
.row:disabled { opacity: .6; }
.icon { display: grid; place-items: center; width: 32px; height: 32px; border-radius: var(--r-sm); background: var(--fill); color: var(--text-2); }
.row.on .icon { background: var(--bg); color: var(--blue); }
.info { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.info b { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text); font-size: var(--fs-sub); font-weight: 600; }
.info small { color: var(--text-3); font-size: var(--fs-caption); }
.check { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--blue); color: #fff; }
.chev { color: var(--text-3); }
.empty { margin: var(--sp-3) 0 0; color: var(--text-3); font-size: var(--fs-sub); line-height: var(--lh-sub); text-align: center; }
.row.disabled { opacity: .6; }
.del, .del-confirm, .del-cancel {
  flex-shrink: 0; min-height: 28px; padding: 0 var(--sp-2);
  border: 1px solid transparent; border-radius: var(--r-pill);
  background: none; color: var(--text-3); font-size: var(--fs-caption);
}
.del { display: grid; place-items: center; width: 28px; padding: 0; }
.del:active { background: var(--danger-soft); color: var(--danger); }
.del-confirm { border-color: color-mix(in srgb, var(--danger) 45%, var(--border)); color: var(--danger); font-weight: 600; }
.del-cancel { color: var(--text-2); }
/* 链路诊断：只回答「现在走哪条、为什么没连上」，不堆日志。 */
.diag {
  display: grid;
  grid-template-columns: auto 1fr auto;
  align-items: center;
  gap: 2px var(--sp-2);
  margin: var(--sp-3) 0 0;
  padding: var(--sp-2) var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--fill);
}
.diag-k { font-size: var(--fs-caption); color: var(--text-3); }
.diag-v { font-size: var(--fs-sub); font-weight: 600; color: var(--text); }
.diag-d { grid-column: 1 / 3; font-size: var(--fs-caption); color: var(--text-3); overflow-wrap: anywhere; }
.diag-btn {
  grid-row: 1 / 3; grid-column: 3;
  min-height: 28px; padding: 0 var(--sp-2);
  border: 1px solid var(--border); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-2);
  font-size: var(--fs-caption); font-weight: 600;
}
.diag-btn:disabled { opacity: .5; }
.add { margin-top: var(--sp-4); padding-top: var(--sp-4); border-top: 1px solid var(--border); }
.add h3 { margin: 0 0 var(--sp-2); color: var(--text); font-size: var(--fs-sub); font-weight: 700; }
.field { display: flex; flex-direction: column; gap: var(--sp-1); color: var(--text-2); font-size: var(--fs-label); }
.field input {
  min-height: 42px; padding: 0 var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg-input); color: var(--text); font-size: var(--fs-body); outline: none;
}
.note { margin: var(--sp-2) 0 0; color: var(--text-3); font-size: var(--fs-caption); }
.error { margin: var(--sp-2) 0 0; color: var(--danger); font-size: var(--fs-label); line-height: var(--lh-label); }
.actions { display: flex; gap: var(--sp-2); margin-top: var(--sp-3); flex-wrap: wrap; }
.btn { flex: 1; min-width: 84px; min-height: var(--sp-9); border: 0; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.btn.ghost { background: var(--fill-strong); color: var(--text); }
.btn.primary { background: var(--blue); color: #fff; }
.btn:disabled { opacity: .55; }
</style>
