<script setup lang="ts">
import { computed, reactive, ref, watch } from 'vue'
import type { QuestionCard } from '@/stores/viewModel'
import CoomiIcon from './CoomiIcon.vue'

const props = defineProps<{ card: QuestionCard }>()
const emit = defineEmits<{ answer: [answers: Record<string, string>, comments: Record<string, string>], cancel: [] }>()

const index = ref(0)
const answers = reactive<Record<string, string>>({})
const comments = reactive<Record<string, string>>({})
const custom = reactive<Record<string, string>>({})
const customMode = ref(false)
const current = computed(() => props.card.questions[index.value])
const isLast = computed(() => index.value === props.card.questions.length - 1)
const SKIPPED = '__SKIPPED__'
const currentAnswered = computed(() => {
  const question = current.value
  return !!question && (answers[question.id] === SKIPPED || !!(answers[question.id] ?? '').trim())
})

watch(() => props.card.callId, () => {
  index.value = 0
  customMode.value = false
  for (const key of Object.keys(answers)) delete answers[key]
  for (const key of Object.keys(comments)) delete comments[key]
  for (const key of Object.keys(custom)) delete custom[key]
})

function choose(value: string) {
  const question = current.value
  if (!question) return
  answers[question.id] = value
  customMode.value = false
  if (!isLast.value) index.value += 1
}

function chooseCustom() {
  customMode.value = true
}

function updateCustom() {
  const question = current.value
  if (question) answers[question.id] = (custom[question.id] ?? '').trim()
}

function previous() {
  if (index.value > 0) index.value -= 1
  customMode.value = false
}

function next() {
  if (!isLast.value) index.value += 1
}

function submit() {
  const result: Record<string, string> = {}
  const commentResult: Record<string, string> = {}
  for (const question of props.card.questions) {
    result[question.id] = answers[question.id] ?? ''
    const c = (comments[question.id] ?? '').trim()
    if (c) commentResult[question.id] = c
  }
  emit('answer', result, commentResult)
}

/** 跳过当前题：标记为跳过；单题时直接提交（等同跳过全部并关闭）。 */
function skipCurrent() {
  choose(SKIPPED)
  if (isLast.value) submit()
}

/** 取消整个提问：清空答案并关闭（发空答案 = 全部跳过）。 */
function cancelAll() {
  emit('cancel')
}
</script>

<template>
  <div class="scrim enter-flat">
    <div class="sheet">
      <div class="grip" />
      <div v-if="current" class="progress">
        <span>{{ current.header }}</span>
        <span>{{ index + 1 }}/{{ card.questions.length }}</span>
      </div>
      <p v-if="current" class="question">{{ current.question }}</p>

      <div v-if="current" class="options">
        <button
          v-for="option in current.options"
          :key="option.label"
          class="opt"
          :class="{ selected: answers[current.id] === option.label }"
          @click="choose(option.label)"
        >
          <span><b>{{ option.label }}</b><small>{{ option.description }}</small></span>
          <CoomiIcon v-if="answers[current.id] === option.label" name="check" :size="16" />
        </button>
        <button class="opt" :class="{ selected: customMode }" @click="chooseCustom">
          <span><b>自定义</b><small>填写其他答案</small></span>
        </button>
      </div>

      <div v-if="current && customMode" class="free">
        <input v-model="custom[current.id]" class="finput" placeholder="输入自定义答案" @input="updateCustom" />
      </div>

      <!-- 补充说明（回复/补充）：独立于选项，始终显示 -->
      <div v-if="current" class="comment">
        <label class="comment-label">补充说明（可选）</label>
        <textarea
          v-model="comments[current.id]"
          class="comment-input"
          placeholder="如有补充说明请在此填写…"
          rows="2"
        />
      </div>

      <div class="actions">
        <button class="nav ghost" @click="cancelAll">取消提问</button>
        <button class="nav ghost" :disabled="index === 0" @click="previous">上一题</button>
        <button v-if="current" class="nav ghost" :class="{ skipped: answers[current.id] === SKIPPED }" @click="skipCurrent">
          <CoomiIcon name="close" :size="14" />
          <span>{{ isLast ? '跳过并提交' : '跳过' }}</span>
        </button>
        <button v-if="!isLast" class="nav primary" :disabled="!currentAnswered" @click="next">下一题</button>
        <button v-else class="nav primary" :disabled="!currentAnswered" @click="submit">提交全部</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.scrim { position: fixed; inset: 0; z-index: var(--z-overlay); display: flex; align-items: flex-end; background: rgba(17, 22, 31, .36); }
.sheet { width: 100%; max-height: 88vh; overflow-y: auto; padding: 6px var(--sp-4) calc(var(--safe-bottom) + var(--sp-4)); border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg); box-shadow: var(--shadow-sheet); }
.grip { width: 38px; height: 4px; margin: var(--sp-1) auto 14px; border-radius: 2px; background: var(--border-strong); }
.progress { display: flex; justify-content: space-between; gap: var(--sp-3); font-size: var(--fs-label); font-weight: 600; color: var(--blue); }
.question { margin: var(--sp-2) 0 0; font-size: var(--fs-body-lg); font-weight: 600; line-height: 1.55; color: var(--text); word-break: break-word; }
.options { margin-top: 14px; display: flex; flex-direction: column; gap: var(--sp-2); }
.opt { display: flex; align-items: center; justify-content: space-between; gap: 10px; width: 100%; min-height: 50px; padding: 9px var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--fill); text-align: left; color: var(--text); }
.opt.selected { border-color: var(--blue-border); background: var(--blue-soft); color: var(--blue); }
.opt span { min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.opt b { font-size: var(--fs-body); font-weight: 600; }
.opt small { font-size: var(--fs-caption); line-height: 1.4; color: var(--text-3); }
.free { display: flex; align-items: center; gap: var(--sp-2); margin-top: 10px; }
.finput { flex: 1; min-width: 0; height: 44px; padding: 0 13px; border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); color: var(--text); }
.comment { margin-top: var(--sp-3); }
.comment-label { display: block; font-size: var(--fs-label); font-weight: 600; color: var(--text-2); margin-bottom: var(--sp-1); }
.comment-input { width: 100%; padding: var(--sp-2) var(--sp-3); border: 1px solid var(--border); border-radius: var(--r-md); background: var(--bg); color: var(--text); font-size: var(--fs-body); resize: vertical; font-family: inherit; }
.nav:disabled { opacity: .45; }
.actions { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--sp-2); margin-top: var(--sp-4); }
.nav { min-height: 42px; border-radius: var(--r-md); font-size: var(--fs-sub); font-weight: 600; }
.nav.ghost { background: var(--fill-strong); color: var(--text-2); }
.nav.ghost.skipped { border-color: var(--blue-border); background: var(--blue-soft); color: var(--blue); }
.nav.primary { background: var(--blue); color: #fff; }

/* 底部弹层入场：rise（100% 上滑，已收敛 global.css）+ 遮罩淡入由 .enter-flat 类负责 */
.sheet { animation: rise var(--dur-base) var(--ease-out) backwards; }
/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .sheet { animation: none; }
}
:root[data-motion='off'] .sheet { animation: none; }
</style>
