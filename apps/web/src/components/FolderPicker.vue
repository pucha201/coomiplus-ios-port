<script setup lang="ts">
/**
 * 应用内目录选择器（无原生 SAF 桥时的替代）。
 * 数据源跟着连接上下文走：本地读 /api/fs/list，云端读电脑的 /api/device/remote-fs/list。
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { apiGet } from '@/bridge/http'
import { useDeviceStore } from '@/stores/device'
import { folderPicker, joinPath, parentPath, settleDirectory } from '@/utils/folderPicker'
import CoomiIcon from './CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

interface DirEntry { name: string; is_dir: boolean; path?: string }

const device = useDeviceStore()
const current = ref('')
const entries = ref<DirEntry[]>([])
const loading = ref(false)
const error = ref('')
let loadToken = 0

const remote = computed(() => device.mode === 'cloud' && !!device.deviceId)
const up = computed(() => parentPath(current.value))

async function load(path: string): Promise<void> {
  if (device.mode === 'cloud' && !device.deviceId) {
    current.value = ''
    entries.value = []
    error.value = '请先在侧栏选择要连接的电脑'
    return
  }
  const token = ++loadToken
  loading.value = true
  error.value = ''
  const endpoint = device.mode === 'cloud' && device.deviceId ? '/api/device/remote-fs/list' : '/api/fs/list'
  try {
    const data = await apiGet<{ path?: string; entries?: DirEntry[] }>(`${endpoint}?path=${encodeURIComponent(path || '')}`)
    if (token !== loadToken) return
    current.value = data.path ?? path
    entries.value = (data.entries ?? []).filter(entry => entry.is_dir)
  } catch (cause) {
    if (token !== loadToken) return
    entries.value = []
    error.value = cause instanceof Error ? cause.message : '目录读取失败'
  } finally {
    if (token === loadToken) loading.value = false
  }
}

watch(() => [folderPicker.open, folderPicker.start] as const, ([open, start]) => {
  if (open) void load(start)
})

function enter(entry: DirEntry): void {
  void load(entry.path || joinPath(current.value, entry.name))
}

function onKey(event: KeyboardEvent): void {
  if (event.key === 'Escape' && folderPicker.open) settleDirectory(null)
}
window.addEventListener('keydown', onKey)
// 目录选择器也是一层浮层：系统返回先按「取消」收起它。
watch(() => folderPicker.open, open => {
  if (open) registerOverlay('folder-picker', () => settleDirectory(null))
  else unregisterOverlay('folder-picker')
})
onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKey)
  unregisterOverlay('folder-picker')
})
</script>

<template>
  <Teleport to="body">
    <div v-if="folderPicker.open" class="scrim" @click.self="settleDirectory(null)">
      <div class="sheet" role="dialog" aria-modal="true" aria-label="选择工作目录">
        <div class="grip" />
        <header class="head">
          <button class="icon" type="button" aria-label="上一级" :disabled="!up" @click="up && load(up)">
            <CoomiIcon name="arrowLeft" :size="16" />
          </button>
          <div class="path" :title="current">{{ current || '当前目录' }}</div>
          <button class="icon" type="button" aria-label="关闭" @click="settleDirectory(null)">
            <CoomiIcon name="close" :size="16" />
          </button>
        </header>
        <p v-if="remote" class="hint">浏览电脑上的目录</p>

        <div class="list">
          <div v-if="loading" class="state">读取中…</div>
          <div v-else-if="error" class="state err">{{ error }}</div>
          <div v-else-if="!entries.length" class="state">这个目录下没有子目录</div>
          <template v-else>
            <button
              v-for="entry in entries"
              :key="entry.name"
              class="dir"
              type="button"
              @click="enter(entry)"
            >
              <CoomiIcon name="folder" :size="16" />
              <span>{{ entry.name }}</span>
              <CoomiIcon name="chevronRight" :size="14" class="chev" />
            </button>
          </template>
        </div>

        <footer class="actions">
          <button class="nav ghost" type="button" @click="settleDirectory(null)">取消</button>
          <button class="nav primary" type="button" :disabled="!current" @click="settleDirectory(current)">选择此目录</button>
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: var(--z-overlay); display: flex; align-items: flex-end; background: rgba(17, 22, 31, .36); }
.sheet {
  display: flex; flex-direction: column;
  width: 100%; max-height: 82vh;
  padding: 6px var(--sp-4) calc(var(--safe-bottom) + var(--sp-4));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg); box-shadow: var(--shadow-sheet);
  animation: rise var(--dur-base) var(--ease-out) backwards;
}
.grip { width: 38px; height: 4px; margin: var(--sp-1) auto 10px; border-radius: 2px; background: var(--border-strong); }
.head { display: flex; align-items: center; gap: var(--sp-2); }
.icon {
  display: grid; place-items: center; width: 36px; height: 36px; flex: none;
  border-radius: var(--r-md); background: var(--fill); color: var(--text-2);
}
.icon:disabled { opacity: .35; }
.path {
  flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-sub); font-weight: 600; color: var(--text);
}
.hint { margin: var(--sp-2) 0 0; font-size: var(--fs-label); color: var(--text-3); }
.list { flex: 1; min-height: 120px; overflow-y: auto; margin-top: 10px; }
.dir {
  display: flex; align-items: center; gap: 10px; width: 100%; min-height: 46px;
  padding: var(--sp-2); border-radius: var(--r-md);
  color: var(--text); font-size: var(--fs-body); text-align: left;
}
.dir:active { background: var(--fill); }
.dir span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.dir :deep(svg:first-child) { color: var(--blue); }
.chev { flex: none; color: var(--text-3); }
.state { padding: 28px 0; text-align: center; font-size: var(--fs-sub); color: var(--text-3); }
.state.err { color: var(--danger); }
.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); margin-top: var(--sp-3); }
.nav { min-height: 44px; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.nav:disabled { opacity: .45; }
.nav.ghost { background: var(--fill-strong); color: var(--text-2); }
.nav.primary { background: var(--blue); color: #fff; }
@media (prefers-reduced-motion: reduce) { .sheet { animation: none; } }
:root[data-motion='off'] .sheet { animation: none; }
</style>
