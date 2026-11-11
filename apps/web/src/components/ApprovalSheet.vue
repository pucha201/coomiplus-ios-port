<script setup lang="ts">
/**
 * 授权弹层。破坏性操作必须先勾确认，勾之前「允许」是禁用的 ——
 * 手机上误触成本太高，这一层摩擦是故意留的。
 */
import { computed, ref } from 'vue'
import type { ToolCard } from '@/stores/viewModel'
import type { ApprovalDecision } from '@/protocol/commands'
import { asText, toolMeta, toolTarget } from '@/utils/toolMeta'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ card: ToolCard }>()
const emit = defineEmits<{ decide: [decision: ApprovalDecision] }>()

const confirmed = ref(false)
const isDestructive = computed(() => props.card.access === 'destructive')
const meta = computed(() => toolMeta(props.card.toolName))
const target = computed(() => toolTarget(props.card.arguments))

const accessMeta = computed(() => {
  switch (props.card.access) {
    case 'read_only': return { label: '只读', cls: 'read' }
    case 'write': return { label: '写入', cls: 'write' }
    case 'destructive': return { label: '破坏性', cls: 'destructive' }
    default: return { label: '', cls: '' }
  }
})

const detail = computed(() => {
  const a = props.card.arguments ?? {}
  if (typeof a.command === 'string') return a.command
  const rows = Object.entries(a).map(([k, v]) => `${k}: ${asText(v)}`)
  return rows.join('\n')
})
</script>

<template>
  <div class="scrim" @click.self="emit('decide', 'deny')">
    <div class="sheet">
      <div class="grip" />

      <div class="head">
        <span class="title">需要你的授权</span>
        <span v-if="accessMeta.label" class="access" :class="accessMeta.cls">{{ accessMeta.label }}</span>
      </div>

      <div class="tool">
        <span class="tile" :class="{ danger: isDestructive }"><CoomiIcon :name="meta.icon" :size="18" /></span>
        <span class="tinfo">
          <span class="verb">{{ meta.verb }}</span>
          <code v-if="target" class="target">{{ target }}</code>
        </span>
      </div>

      <p v-if="card.riskSummary" class="risk">
        <CoomiIcon name="alert" :size="15" /><span>{{ card.riskSummary }}</span>
      </p>

      <pre class="mono">{{ detail }}</pre>

      <label v-if="isDestructive" class="confirm">
        <input v-model="confirmed" type="checkbox" />
        <span>我已了解这是<b>不可恢复</b>的操作</span>
      </label>

      <div class="actions">
        <button class="act ghost" @click="emit('decide', 'deny')">拒绝</button>
        <button class="act soft" :disabled="isDestructive && !confirmed" @click="emit('decide', 'always')">始终允许</button>
        <button class="act primary" :class="{ danger: isDestructive }" :disabled="isDestructive && !confirmed" @click="emit('decide', 'allow')">允许一次</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim {
  position: fixed; inset: 0; z-index: var(--z-overlay);
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36);
  animation: coomi-enter-flat var(--enter-flat-dur) var(--ease-out); /* fade(纯淡入) 与 coomi-enter-flat 逐字相同，复用 token */
}

.sheet {
  width: 100%; padding: 6px var(--sp-4) calc(var(--safe-bottom) + var(--sp-4));
  border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet);
  animation: rise var(--enter-block-dur) var(--ease-out); /* rise 已收敛到 global.css（100% 高度上滑，语义 = enter-item） */
}

.grip { width: 38px; height: 4px; margin: var(--sp-1) auto 14px; border-radius: 2px; background: var(--border-strong); }

.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-size: var(--fs-heading); font-weight: 600; color: var(--text); }
.access {
  padding: var(--sp-1) 11px; border-radius: var(--r-pill);
  background: var(--fill-strong); color: var(--text-2);
  font-size: var(--fs-caption); font-weight: 600;
}
.access.write { background: var(--orange-soft); color: var(--orange); }
.access.destructive { background: var(--danger); color: #fff; }

.tool { display: flex; align-items: center; gap: 10px; margin-top: 14px; }
.tile {
  display: grid; place-items: center; flex-shrink: 0;
  width: 34px; height: 34px; border-radius: var(--r-md);
  background: var(--blue-soft); color: var(--blue);
}
.tile.danger { background: var(--danger-soft); color: var(--danger); }
.tinfo { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.verb { font-size: var(--fs-body); font-weight: 600; color: var(--text); }
.target {
  font-family: var(--font-mono); font-size: var(--fs-caption); color: var(--text-2);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}

.risk {
  display: flex; align-items: flex-start; gap: 7px; margin-top: var(--sp-3);
  padding: 9px var(--sp-3); border-radius: var(--r-md);
  background: var(--orange-soft); color: var(--orange);
  font-size: var(--fs-sub); line-height: 1.55;
}
.risk :deep(svg) { flex-shrink: 0; margin-top: 1px; color: var(--orange); }

.mono {
  max-height: 30vh; margin-top: var(--sp-3); padding: 11px var(--sp-3);
  border-radius: var(--r-md); background: var(--code-bg);
  font-family: var(--font-mono); font-size: var(--fs-label); line-height: 1.6;
  color: var(--code-text); white-space: pre-wrap; word-break: break-word;
  overflow: auto;
}

.confirm {
  display: flex; align-items: center; gap: 9px; margin-top: var(--sp-3);
  padding: 11px 13px; border-radius: var(--r-md);
  background: var(--danger-soft); font-size: var(--fs-sub); color: var(--text);
}
.confirm input { flex-shrink: 0; width: 18px; height: 18px; accent-color: var(--danger); }
.confirm b { color: var(--danger); }

.actions { display: flex; gap: var(--sp-2); margin-top: 14px; }
.act {
  flex: 1; min-height: 46px; padding: 0 var(--sp-2);
  border: 0; border-radius: var(--r-md);
  font-size: var(--fs-sub); font-weight: 600;
  transition: transform var(--dur-press) var(--ease-out);
}
.act.ghost { background: var(--fill); color: var(--text-2); }
.act.soft { background: var(--blue-soft); color: var(--blue); }
.act.primary { background: var(--blue); color: #fff; }
.act.primary.danger { background: var(--danger); }
.act:disabled { opacity: .4; pointer-events: none; }
.act:active { transform: scale(var(--press-scale)); }

/* 减弱动态效果：授权弹层直接出现（原 scrim/sheet 内联的入场在此归零） */
@media (prefers-reduced-motion: reduce) {
  .scrim, .sheet { animation: none; }
}
:root[data-motion='off'] .scrim, :root[data-motion='off'] .sheet { animation: none; }
</style>

