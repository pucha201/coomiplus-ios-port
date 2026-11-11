<script setup lang="ts">
/**
 * 自定义下拉选择：替代原生 <select>。
 * 触发器 + fixed 浮层列表，支持键盘导航、视口翻转、动效令牌。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { CSSProperties } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

export interface UiSelectOption {
  value: string
  label: string
  description?: string
  disabled?: boolean
}

const props = withDefaults(defineProps<{
  modelValue?: string
  options: UiSelectOption[]
  placeholder?: string
  disabled?: boolean
  size?: 'sm' | 'md'
  block?: boolean
}>(), {
  modelValue: '', placeholder: '请选择', disabled: false, size: 'md', block: false,
})

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
}>()

const open = ref(false)
const triggerEl = ref<HTMLElement | null>(null)
const listEl = ref<HTMLElement | null>(null)
const activeIndex = ref(-1)
const dropUp = ref(false)

const selected = computed(() => props.options.find(o => o.value === props.modelValue) || null)
const displayLabel = computed(() => selected.value?.label ?? props.placeholder)

const popStyle = computed<CSSProperties>(() => {
  const el = triggerEl.value
  if (!el || !open.value) return { display: 'none' }
  const rect = el.getBoundingClientRect()
  const style: CSSProperties = {
    position: 'fixed', left: `${Math.max(8, Math.min(rect.left, window.innerWidth - rect.width - 8))}px`, width: `${Math.max(rect.width, 140)}px`, maxHeight: '240px',
  }
  if (dropUp.value) {
    style.bottom = `${window.innerHeight - rect.top + 6}px`
  } else {
    style.top = `${rect.bottom + 6}px`
  }
  return style
})

function toggle() {
  if (props.disabled) return
  if (open.value) close()
  else openMenu()
}

async function openMenu() {
  if (props.disabled) return
  open.value = true
  activeIndex.value = Math.max(0, props.options.findIndex(o => o.value === props.modelValue))
  await nextTick()
  positionMenu()
  const item = listEl.value?.querySelector<HTMLElement>('[data-active="true"]')
  item?.scrollIntoView({ block: 'nearest' })
}

function close() {
  open.value = false
  activeIndex.value = -1
}

function positionMenu() {
  const el = triggerEl.value
  const menu = listEl.value
  if (!el || !menu) return
  const rect = el.getBoundingClientRect()
  const menuH = Math.min(menu.scrollHeight, 240)
  const spaceBelow = window.innerHeight - rect.bottom - 12
  dropUp.value = spaceBelow < menuH && rect.top > spaceBelow
}

function selectOption(opt: UiSelectOption) {
  if (opt.disabled) return
  emit('update:modelValue', opt.value)
  emit('change', opt.value)
  close()
  triggerEl.value?.focus()
}

function onKeydown(e: KeyboardEvent) {
  if (props.disabled) return
  if (!open.value) {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      openMenu()
    }
    return
  }
  const enabled = props.options
    .map((o, i) => ({ o, i }))
    .filter(x => !x.o.disabled)
  if (!enabled.length) return
  const cur = enabled.findIndex(x => x.i === activeIndex.value)
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    activeIndex.value = enabled[(cur + 1) % enabled.length].i
  } else if (e.key === 'ArrowUp') {
    e.preventDefault()
    activeIndex.value = enabled[(cur - 1 + enabled.length) % enabled.length].i
  } else if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    const opt = props.options[activeIndex.value]
    if (opt) selectOption(opt)
  } else if (e.key === 'Escape') {
    e.preventDefault()
    close()
    triggerEl.value?.focus()
  } else if (e.key === 'Tab') {
    close()
  }
}

function onDocClick(e: MouseEvent) {
  if (!open.value) return
  const t = e.target as Node
  if (triggerEl.value?.contains(t) || listEl.value?.contains(t)) return
  close()
}

function onScrollOrResize(e: Event) {
  if (!open.value) return
  // 浮层自身滚动不关闭；页面/容器滚动才关闭，避免 fixed 在 transform 祖先下漂移。
  const t = e.target as Node | null
  if (t && listEl.value && (t === listEl.value || listEl.value.contains(t))) return
  close()
}

watch(() => props.modelValue, () => {
  const i = props.options.findIndex(o => o.value === props.modelValue)
  if (i >= 0) activeIndex.value = i
})

onMounted(() => {
  document.addEventListener('mousedown', onDocClick)
  window.addEventListener('resize', onScrollOrResize)
  window.addEventListener('scroll', onScrollOrResize, true)
})
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onDocClick)
  window.removeEventListener('resize', onScrollOrResize)
  window.removeEventListener('scroll', onScrollOrResize, true)
})
</script>

<template>
  <div
    class="ui-select"
    :class="[
      `ui-select--${size}`,
      { 'ui-select--block': block, 'ui-select--open': open, 'ui-select--disabled': disabled },
    ]"
  >
    <button
      ref="triggerEl"
      type="button"
      class="ui-select__trigger"
      role="combobox"
      :aria-expanded="open"
      aria-haspopup="listbox"
      :disabled="disabled"
      @click="toggle"
      @keydown="onKeydown"
    >
      <span class="ui-select__label" :class="{ placeholder: !selected }">{{ displayLabel }}</span>
      <CoomiIcon name="chevronDown" :size="14" class="ui-select__chev" />
    </button>

    <Teleport to="body">
      <div
        v-if="open"
        ref="listEl"
        class="ui-select__pop"
        :class="dropUp ? 'drop-up' : 'drop-down'"
        role="listbox"
        :style="popStyle"
      >
        <button
          v-for="(opt, i) in options"
          :key="opt.value"
          type="button"
          class="ui-select__option"
          :class="{
            active: i === activeIndex, selected: opt.value === modelValue, disabled: opt.disabled,
          }"
          role="option"
          :aria-selected="opt.value === modelValue"
          :data-active="i === activeIndex"
          @mouseenter="activeIndex = i"
          @click="selectOption(opt)"
        >
          <span class="opt-text">
            <span class="opt-label">{{ opt.label }}</span>
            <span v-if="opt.description" class="opt-desc">{{ opt.description }}</span>
          </span>
          <CoomiIcon v-if="opt.value === modelValue" name="check" :size="14" class="opt-check" />
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style>
/* 浮层 teleported 到 body，不能 scoped */
.ui-select__pop {
  z-index: 10000;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--sp-1);
  border: 1px solid var(--border, #e7e9ee);
  border-radius: var(--r-md);
  background: var(--bg, #fff);
  box-shadow: 0 6px 24px rgba(23, 32, 54, 0.1);
  animation: ui-select-pop var(--enter-pop-dur) var(--ease-out) backwards;
  -webkit-overflow-scrolling: touch;
  font-family: var(--font-ui, inherit);
}
.ui-select__pop.drop-up { transform-origin: bottom center; }
.ui-select__pop.drop-down { transform-origin: top center; }

@keyframes ui-select-pop {
  from { opacity: 0; transform: translateY(6px) scale(0.97); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

/* 减弱动态效果：下拉直接出现（系统级 + 应用内开关，两入口一致） */
@media (prefers-reduced-motion: reduce) {
  .ui-select__pop { animation: none; }
}
[data-motion='off'] .ui-select__pop { animation: none; }

.ui-select__option {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  width: 100%;
  padding: 9px 10px;
  border: 0;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text, #1b1e23);
  font-size: var(--fs-sub);
  text-align: left;
  cursor: pointer;
  /* 选项也走全 app 那套按压：原来这里只过渡 background，
     于是 <button> 的 :active 缩放是「瞬变」的，和别处手感对不上。
     现在补全 transform/background/color 三项，与 global.css 的按压块同值。 */
  transition:
    transform var(--dur-press) var(--ease-out), background var(--dur-fast) var(--ease-out), color var(--dur-fast) var(--ease-out);
  font-family: inherit;
}
.ui-select__option:hover,
.ui-select__option.active { background: var(--fill, #f5f6f8); }
.ui-select__option.selected {
  background: var(--blue-soft, #eaf0fc);
  color: var(--blue, #2d61c6);
  font-weight: 600;
}
.ui-select__option.disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.ui-select__option:focus-visible {
  outline: 2px solid var(--blue, #2d61c6);
  outline-offset: -2px;
}

.ui-select__option .opt-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ui-select__option .opt-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-select__option .opt-desc {
  font-size: var(--fs-caption);
  color: var(--text-3, #9096a2);
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-select__option .opt-check {
  flex-shrink: 0;
  color: var(--blue, #2d61c6);

.ui-select {
  position: relative;
  display: inline-flex;
  vertical-align: middle;
}
.ui-select--block { display: flex; width: 100%; }

.ui-select__trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  width: 100%; min-height: 36px;
  padding: 0 10px 0 11px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--bg);
  color: var(--text);
  font-size: var(--fs-sub);
  text-align: left;
  cursor: pointer;
  box-sizing: border-box;
  /* 令牌兜底值（var(--dur-fast, 140ms)）已去掉：global.css 是全局加载的，
     写兜底只会把「令牌名拼错」变成静默降级，排查时看不出问题。 */
  transition:
    border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out), background var(--dur-fast) var(--ease-out), transform var(--dur-press) var(--ease-out);
}
.ui-select--sm .ui-select__trigger {
  min-height: 30px;
  font-size: var(--fs-label);
  padding: 0 var(--sp-2) 0 9px;
}
.ui-select__trigger:hover:not(:disabled) { border-color: var(--border-strong); }
.ui-select__trigger:focus-visible {
  outline: none;
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-soft);
}
.ui-select--open .ui-select__trigger {
  border-color: var(--blue);
  box-shadow: 0 0 0 3px var(--blue-soft);
}
.ui-select--disabled .ui-select__trigger {
  opacity: 0.5;
  cursor: not-allowed;
  pointer-events: none;
}

.ui-select__label {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ui-select__label.placeholder { color: var(--text-3); }

.ui-select__chev {
  flex-shrink: 0;
  color: var(--text-3);
  transition: transform var(--dur-base) var(--ease-out);
}
.ui-select--open .ui-select__chev {
  transform: rotate(180deg);
  color: var(--blue);
}
;
  color: var(--blue);
}
</style>
