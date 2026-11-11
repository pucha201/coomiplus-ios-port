<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { registerOverlay, unregisterOverlay } from '@/bridge/overlayStack'

const props = defineProps<{
  candidates: string[]
  selected: string[]
}>()
const emit = defineEmits<{
  confirm: [models: string[]]
  cancel: []
}>()

const query = ref('')
const selected = ref(new Set<string>())
// 只在展开时挂载：挂载即登记返回栈。
onMounted(() => registerOverlay('model-picker', () => emit('cancel')))
onBeforeUnmount(() => unregisterOverlay('model-picker'))

watch(() => props.selected, value => { selected.value = new Set(value) }, { immediate: true })

const filtered = computed(() => {
  const needle = query.value.trim().toLowerCase()
  return props.candidates.filter(model => !needle || model.toLowerCase().includes(needle))
})

const allFilteredSelected = computed(() => (
  filtered.value.length > 0 && filtered.value.every(model => selected.value.has(model))
))

function toggle(model: string) {
  const next = new Set(selected.value)
  if (next.has(model)) next.delete(model)
  else next.add(model)
  selected.value = next
}

function toggleAll() {
  const next = new Set(selected.value)
  if (allFilteredSelected.value) {
    filtered.value.forEach(model => next.delete(model))
  } else {
    filtered.value.forEach(model => next.add(model))
  }
  selected.value = next
}

function confirm() {
  emit('confirm', Array.from(selected.value))
}
</script>

<template>
  <div class="mask enter-flat" @click.self="emit('cancel')">
    <section class="sheet" role="dialog" aria-modal="true" aria-label="选择模型">
      <div class="grip" />
      <div class="sheet-head">
        <div>
          <h2>选择模型</h2>
          <p>{{ selected.size }} 个已选择</p>
        </div>
        <button class="icon-btn" aria-label="关闭" @click="emit('cancel')"><CoomiIcon name="close" :size="18" /></button>
      </div>
      <label class="search">
        <CoomiIcon name="search" :size="16" />
        <input v-model="query" type="search" placeholder="搜索模型" autocomplete="off" />
        <button
          type="button"
          class="select-all"
          :class="{ on: allFilteredSelected }"
          :aria-label="allFilteredSelected ? '取消全选' : '全选当前结果'"
          @click="toggleAll"
        >
          <span class="select-all-box"><CoomiIcon v-if="allFilteredSelected" name="check" :size="14" /></span>
        </button>
      </label>
      <div class="models">
        <button v-for="model in filtered" :key="model" class="model-row" @click="toggle(model)">
          <span class="check" :class="{ on: selected.has(model) }"><CoomiIcon v-if="selected.has(model)" name="check" :size="14" /></span>
          <code>{{ model }}</code>
        </button>
        <p v-if="filtered.length === 0" class="empty-sm">没有匹配的模型。</p>
      </div>
      <div class="actions">
        <button class="btn btn-ghost" @click="emit('cancel')">取消</button>
        <button class="btn btn-primary" @click="confirm">确认加入</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mask { position: fixed; inset: 0; z-index: var(--z-popover); display: flex; align-items: flex-end; background: rgba(17, 22, 31, .42); }
.sheet { display: flex; flex-direction: column; box-sizing: border-box; width: 100%; height: 78vh; max-height: 620px; padding: 7px var(--sp-4) calc(var(--safe-bottom) + var(--sp-4)); border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.grip { width: 38px; height: 4px; margin: 3px auto var(--sp-3); border-radius: 2px; background: var(--border-strong); }
.sheet-head { display: flex; align-items: center; justify-content: space-between; gap: var(--sp-2); }
h2 { font-size: var(--fs-strong); color: var(--text); }
.sheet-head p { margin: 2px 0 0; font-size: var(--fs-label); color: var(--text-3); }
.search { display: flex; align-items: center; gap: var(--sp-2); height: 42px; margin-top: var(--sp-3); padding: 0 var(--sp-3); border-radius: var(--r-md); background: var(--fill); color: var(--text-3); }
.search input { flex: 1; min-width: 0; border: 0; outline: 0; background: transparent; color: var(--text); font-size: var(--fs-body); }
.select-all { display: grid; place-items: center; flex: 0 0 32px; width: 32px; height: 32px; border-radius: var(--r-sm); color: var(--blue); }
.select-all:active { background: var(--fill-strong); }
.select-all-box { display: grid; place-items: center; width: 20px; height: 20px; border: 1px solid var(--border-strong); border-radius: 5px; }
.select-all.on .select-all-box { border-color: var(--blue); background: var(--blue); color: #fff; }
.models { flex: 1 1 auto; min-height: 0; margin-top: var(--sp-2); overflow-y: auto; -webkit-overflow-scrolling: touch; overscroll-behavior: contain; }
.model-row { display: flex; align-items: center; gap: 10px; width: 100%; min-height: 44px; padding: 7px 3px; text-align: left; }
.model-row:active { background: var(--fill); }
.model-row code { min-width: 0; overflow-wrap: anywhere; font-family: var(--font-mono); font-size: var(--fs-label); color: var(--text); }
.check { display: grid; place-items: center; flex-shrink: 0; width: 20px; height: 20px; border: 1px solid var(--border-strong); border-radius: var(--r-sm); color: #fff; }
.check.on { border-color: var(--blue); background: var(--blue); }
.actions { display: flex; gap: 9px; margin-top: var(--sp-3); }
.actions .btn { flex: 1; }

/* 底部弹层入场：rise（100% 上滑，已收敛 global.css）+ 遮罩淡入由 .enter-flat 类负责 */
.sheet { animation: rise var(--dur-base) var(--ease-out) backwards; }
/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
