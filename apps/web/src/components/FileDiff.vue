<script setup lang="ts">
/**
 * 统一 diff 查看：按行上色，不做语法高亮（语言未知、也不该在手机小屏上抢注意力）。
 *
 * 只做三件事：`+` 绿、`-` 红、`@@` 灰；超长自动折叠。
 */
import { computed, ref } from 'vue'

const props = withDefaults(defineProps<{ text: string; collapsedLines?: number }>(), {
  collapsedLines: 120,
})

interface DiffLine { kind: '+' | '-' | '@' | ' '; text: string }

const expanded = ref(false)

const lines = computed<DiffLine[]>(() => {
  const out: DiffLine[] = []
  for (const raw of props.text.split('\n')) {
    if (!raw) continue
    // 文件头两行（--- / +++）不占正文，避免和 hunk 混在一起。
    if (raw.startsWith('--- ') || raw.startsWith('+++ ')) continue
    if (raw.startsWith('@@')) out.push({ kind: '@', text: raw })
    else if (raw.startsWith('+')) out.push({ kind: '+', text: raw.slice(1) })
    else if (raw.startsWith('-')) out.push({ kind: '-', text: raw.slice(1) })
    else out.push({ kind: ' ', text: raw.startsWith(' ') ? raw.slice(1) : raw })
  }
  return out
})

const hidden = computed(() => Math.max(0, lines.value.length - props.collapsedLines))
const visible = computed(() =>
  expanded.value || lines.value.length <= props.collapsedLines
    ? lines.value
    : lines.value.slice(0, props.collapsedLines),
)
</script>

<template>
  <div class="diff" role="region" aria-label="文件差异">
    <div class="rows">
      <div v-for="(line, index) in visible" :key="index" class="row" :class="line.kind === '+' ? 'add' : line.kind === '-' ? 'del' : line.kind === '@' ? 'hunk' : 'ctx'">
        <span class="sign" aria-hidden="true">{{ line.kind === ' ' ? '' : line.kind }}</span>
        <code class="code">{{ line.text || ' ' }}</code>
      </div>
    </div>
    <button v-if="hidden > 0" class="more" type="button" @click="expanded = !expanded">
      {{ expanded ? '收起' : `展开其余 ${hidden} 行` }}
    </button>
  </div>
</template>

<style scoped>
.diff {
  border-radius: var(--r-sm); overflow: hidden;
  background: var(--fill);
  border: .5px solid color-mix(in srgb, var(--text) 8%, transparent);
}
.rows { overflow-x: auto; scrollbar-width: thin; }
.row { display: flex; gap: var(--sp-1); padding: 0 var(--sp-2); min-height: 21px; align-items: flex-start; }
.row.add { background: color-mix(in srgb, var(--ok) 14%, transparent); }
.row.del { background: color-mix(in srgb, var(--danger) 13%, transparent); }
.row.hunk { background: color-mix(in srgb, var(--text) 6%, transparent); }
.sign {
  flex: none; width: 10px; text-align: center;
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.65;
  color: var(--text-3); user-select: none;
}
.row.add .sign { color: var(--ok); }
.row.del .sign { color: var(--danger); }
.code {
  flex: 1; min-width: 0; white-space: pre;
  font-family: var(--font-mono); font-size: var(--fs-caption); line-height: 1.65;
  color: var(--text-2);
}
.row.hunk .code { color: var(--text-3); }
.more {
  display: block; width: 100%; min-height: 30px;
  font-size: var(--fs-caption); color: var(--blue);
  background: color-mix(in srgb, var(--text) 4%, transparent);
}
</style>
