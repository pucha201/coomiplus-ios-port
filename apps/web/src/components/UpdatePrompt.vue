<script setup lang="ts">
/**
 * 全局「发现新版本」提示：由启动静默检查（main.ts → runStartupUpdateCheck）
 * 发现新版本后广播 coomi:update-available 事件触发。底部弹出，可跳转更新页或稍后。
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { readableNotes, dismissUpdatePrompt, type UpdateInfo } from '@/bridge/updater'

const router = useRouter()
const visible = ref(false)
const update = ref<UpdateInfo | null>(null)

function onUpdateAvailable(e: Event) {
  const detail = (e as CustomEvent).detail ?? {}
  const info = detail.update as UpdateInfo | undefined
  if (!info || !info.version) return
  update.value = info
  visible.value = true
}

function goUpdate() {
  visible.value = false
  void router.push('/updates')
}

function later() {
  if (update.value) dismissUpdatePrompt(update.value.version)
  visible.value = false
}

onMounted(() => window.addEventListener('coomi:update-available', onUpdateAvailable))
onBeforeUnmount(() => window.removeEventListener('coomi:update-available', onUpdateAvailable))
</script>

<template>
  <Teleport to="body">
    <Transition name="mask">
      <div v-if="visible" class="upd-mask" @click="later" />
    </Transition>
    <Transition name="sheet">
      <div v-if="visible && update" class="upd-sheet">
        <div class="upd-head">
          <span class="upd-title">发现新版本 v{{ update.version }}</span>
          <button aria-label="关闭" @click="later"><svg viewBox="0 0 20 20" width="15" height="15"><path d="M5.2 5.2 14.8 14.8M14.8 5.2 5.2 14.8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" /></svg></button>
        </div>
        <div class="upd-body">
          <p class="upd-notes">{{ readableNotes(update.notes) || '（无更新说明）' }}</p>
          <p class="upd-sha">SHA-256：{{ update.sha256.slice(0, 16) }}…</p>
        </div>
        <div class="upd-actions">
          <button class="upd-btn ghost" @click="later">稍后</button>
          <button class="upd-btn primary" @click="goUpdate">立即更新</button>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.upd-mask { position: fixed; inset: 0; z-index: 38; background: rgba(10, 15, 24, .45); }
.upd-sheet {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 39;
  border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg);
  padding: 14px var(--sp-4) calc(var(--sp-4) + env(safe-area-inset-bottom, 0));
  box-shadow: var(--shadow-2);
}
.upd-head { display: flex; align-items: center; justify-content: space-between; padding-bottom: 10px; }
.upd-title { font-size: var(--fs-body-lg); font-weight: 600; color: var(--text); }
.upd-head button { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: var(--r-sm); background: var(--fill); color: var(--text-2); }
.upd-body { max-height: 32vh; overflow-y: auto; }
.upd-notes { font-size: var(--fs-label); line-height: 1.7; color: var(--text-2); white-space: pre-wrap; word-break: break-word; }
.upd-sha { margin-top: var(--sp-2); font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-3); word-break: break-all; }
.upd-actions { display: flex; gap: 10px; margin-top: 14px; }
.upd-btn { flex: 1; min-height: 42px; border-radius: var(--r-md); font-size: var(--fs-body); }
.upd-btn.ghost { background: var(--fill); color: var(--text-2); }
.upd-btn.primary { background: var(--blue); color: #fff; }
.mask-enter-active, .mask-leave-active, .sheet-enter-active, .sheet-leave-active { transition: opacity var(--dur-base) var(--ease-out), transform var(--dur-base) var(--ease-out); }
.mask-enter-from, .mask-leave-to { opacity: 0; }
.sheet-enter-from, .sheet-leave-to { transform: translateY(100%); }
@media (prefers-reduced-motion: reduce) {
  .mask-enter-active, .mask-leave-active, .sheet-enter-active, .sheet-leave-active { transition: none; }
  .sheet-enter-from, .sheet-leave-to { transform: none; }
}
:root[data-motion='off'] .mask-enter-active, :root[data-motion='off'] .mask-leave-active,
:root[data-motion='off'] .sheet-enter-active, :root[data-motion='off'] .sheet-leave-active { transition: none; }
</style>
