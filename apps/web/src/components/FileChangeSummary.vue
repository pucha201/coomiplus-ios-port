<script setup lang="ts">
/**
 * 一轮结束后的文件改动汇总（主流 AI 软件同款）：
 * 折叠态一行「N 个文件已更改 +X −Y」；展开分两页：
 *  · 文件：逐文件状态 + 行数，点开看统一 diff；
 *  · 记录：本次轮里每一次写入（工具名 + 路径 + 行数），按发生顺序。
 */
import { computed, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import FileDiff from '@/components/FileDiff.vue'
import type { TurnAction, TurnFileChange } from '@/stores/viewModel'

const props = withDefaults(defineProps<{ files: TurnFileChange[]; actions?: TurnAction[] }>(), {
  actions: () => [],
})

const open = ref(false)
const tab = ref<'files' | 'log'>('files')
const opened = ref<string | null>(null)

const added = computed(() => props.files.reduce((sum, f) => sum + (f.added ?? 0), 0))
const removed = computed(() => props.files.reduce((sum, f) => sum + (f.removed ?? 0), 0))
const known = computed(() => props.files.some(f => f.added !== undefined || f.removed !== undefined))
const count = computed(() => props.files.length)

function fileName(f: TurnFileChange): string { return f.name || f.path.split('/').pop() || f.path }
function dirName(f: TurnFileChange): string {
  const parts = f.path.replace(/\\/g, '/').split('/')
  return parts.length > 1 ? parts.slice(0, -1).join('/') : ''
}
function badge(change?: string): { text: string; tone: 'add' | 'del' | 'mod' } {
  if (change === 'add') return { text: 'A', tone: 'add' }
  if (change === 'delete') return { text: 'D', tone: 'del' }
  return { text: 'M', tone: 'mod' }
}
function toggleFile(path: string): void {
  opened.value = opened.value === path ? null : path
}
function openTab(next: 'files' | 'log'): void {
  tab.value = next
}
</script>

<template>
  <div class="box">
    <button class="head" type="button" :aria-expanded="open" @click="open = !open">
      <span class="stats">
        <span class="label">{{ count }} 个文件已更改</span>
        <span v-if="known" class="add">+{{ added }}</span>
        <span v-if="known" class="del">−{{ removed }}</span>
      </span>
      <CoomiIcon name="chevronDown" :size="14" class="chev" :class="{ up: open }" />
    </button>

    <Transition name="files-drop">
      <div v-if="open" class="panel">
        <div class="tabs" role="tablist">
          <button :class="['tab', { on: tab === 'files' }]" role="tab" @click="openTab('files')">文件</button>
          <button :class="['tab', { on: tab === 'log' }]" role="tab" @click="openTab('log')">
            记录<span class="tab-count">{{ actions.length }}</span>
          </button>
        </div>

        <template v-if="tab === 'files'">
          <div v-for="f in files" :key="f.path" class="file">
            <button class="frow" type="button" :aria-expanded="opened === f.path" @click="toggleFile(f.path)">
              <span class="fbadge" :class="badge(f.change).tone">{{ badge(f.change).text }}</span>
              <span class="ftext">
                <span class="fname">{{ fileName(f) }}</span>
                <span v-if="dirName(f)" class="fdir">{{ dirName(f) }}</span>
              </span>
              <span v-if="f.added !== undefined" class="fdelta">
                <span class="add">+{{ f.added }}</span>
                <span class="del">−{{ f.removed ?? 0 }}</span>
              </span>
              <CoomiIcon
                v-if="f.diff"
                name="chevronDown"
                :size="13"
                class="fchev"
                :class="{ up: opened === f.path }"
              />
            </button>
            <div v-if="opened === f.path && f.diff" class="fdiff">
              <FileDiff :text="f.diff" />
            </div>
            <p v-else-if="opened === f.path" class="fdiff-empty">
              这次没有保留差异（文件由命令修改，引擎无法还原改前内容）。
            </p>
          </div>
        </template>

        <template v-else>
          <p v-if="!actions.length" class="empty">这次没有逐条写入记录。</p>
          <ul v-else class="log">
            <li v-for="(item, index) in actions" :key="index" class="logrow">
              <span class="ltool">{{ item.tool || '写入' }}</span>
              <span class="lpath" :title="item.path">{{ item.path.split(/[\\/]/).pop() }}</span>
              <span class="ldelta">
                <span v-if="item.added !== undefined" class="add">+{{ item.added }}</span>
                <span v-if="item.removed !== undefined" class="del">−{{ item.removed }}</span>
              </span>
            </li>
          </ul>
        </template>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.box {
  margin-top: var(--sp-2); max-width: 100%;
  border: 1px solid var(--border); border-radius: var(--r-md);
  background: var(--bg); overflow: hidden;
}
.head {
  display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2);
  width: 100%; min-height: 38px; padding: 0 var(--sp-3);
  background: transparent; text-align: left;
  font-size: var(--fs-label); color: var(--text-2);
}
.head:active { background: var(--fill); }
.stats { display: flex; align-items: center; gap: var(--sp-2); min-width: 0; }
.label { color: var(--text-2); }
.add { color: var(--ok); font-variant-numeric: tabular-nums; }
.del { color: var(--danger); font-variant-numeric: tabular-nums; }
.chev { color: var(--text-3); transition: transform var(--dur-fast) var(--ease-out); }
.chev.up { transform: rotate(180deg); }

.panel { border-top: .5px solid color-mix(in srgb, var(--text) 8%, transparent); }
.tabs { display: flex; gap: var(--sp-1); padding: var(--sp-2) var(--sp-2) 0; }
.tab {
  display: inline-flex; align-items: center; gap: var(--sp-1);
  min-height: 28px; padding: 0 var(--sp-2); border-radius: var(--r-sm);
  font-size: var(--fs-caption); color: var(--text-3); background: transparent;
}
.tab.on { background: var(--fill-strong); color: var(--text); font-weight: 600; }
.tab-count { font-variant-numeric: tabular-nums; opacity: .7; }

.file { border-top: .5px solid color-mix(in srgb, var(--text) 6%, transparent); }
.file:first-of-type { border-top: 0; }
.frow {
  display: flex; align-items: center; gap: var(--sp-2); width: 100%;
  min-height: 40px; padding: 0 var(--sp-3); text-align: left;
}
.frow:active { background: var(--fill); }
.fbadge {
  display: grid; place-items: center; flex: none; width: 18px; height: 18px;
  border-radius: var(--r-sm); font-size: 10px; font-weight: 700;
  background: var(--fill-strong); color: var(--text-2);
}
.fbadge.add { background: color-mix(in srgb, var(--ok) 20%, transparent); color: var(--ok); }
.fbadge.del { background: color-mix(in srgb, var(--danger) 18%, transparent); color: var(--danger); }
.ftext { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.fname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-label); color: var(--text); }
.fdir {
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  font-size: var(--fs-caption); color: var(--text-3); font-family: var(--font-mono);
}
.fdelta { flex: none; display: flex; gap: var(--sp-1); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.fchev { flex: none; color: var(--text-3); transition: transform var(--dur-fast) var(--ease-out); }
.fchev.up { transform: rotate(180deg); }
.fdiff { padding: 0 var(--sp-2) var(--sp-2); }
.fdiff-empty { margin: 0; padding: 0 var(--sp-3) var(--sp-2); font-size: var(--fs-caption); line-height: 1.5; color: var(--text-3); }

.log { margin: 0; padding: var(--sp-1) var(--sp-2) var(--sp-2); list-style: none; max-height: 40vh; overflow-y: auto; }
.logrow { display: flex; align-items: center; gap: var(--sp-2); min-height: 30px; padding: 0 var(--sp-1); }
.ltool {
  flex: none; padding: 0 6px; border-radius: var(--r-sm);
  font-size: 10px; line-height: var(--lh-label); color: var(--text-3);
  background: var(--fill-strong); font-family: var(--font-mono);
}
.lpath { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: var(--fs-caption); color: var(--text-2); }
.ldelta { flex: none; display: flex; gap: var(--sp-1); font-size: var(--fs-caption); font-variant-numeric: tabular-nums; }
.empty { margin: 0; padding: var(--sp-3); font-size: var(--fs-caption); color: var(--text-3); }

.files-drop-enter-active, .files-drop-leave-active {
  transition: opacity var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out);
}
.files-drop-enter-from, .files-drop-leave-to { opacity: 0; transform: translateY(-4px); }
</style>
