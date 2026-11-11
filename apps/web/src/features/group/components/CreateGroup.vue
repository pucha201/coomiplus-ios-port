<script setup lang="ts">
/** 建群表单：名称 / 话题 / 模式 / 成员（含职业/人设/模型）。 */
import { computed, ref } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import UiSelect from '@/components/ui/UiSelect.vue'
import type { RoomMember, SpeakMode } from '../types'

const props = defineProps<{
  models: Array<{ value: string; label: string }>
  open: boolean
}>()

const emit = defineEmits<{
  close: []
  submit: [name: string, topic: string, mode: SpeakMode, members: RoomMember[]]
}>()

const name = ref('')
const topic = ref('')
const mode = ref<SpeakMode>('round_robin')
const expanded = ref<Record<string, boolean>>({})
const members = ref<RoomMember[]>([
  { id: 'coder', name: '执行者', modelSelector: '', prompt: '负责实现与改码，简洁汇报结果。', color: '#2d61c6', icon: 'terminal', quota: 0, persona: '', speakingStyle: '', values: '', emotionBias: 0 },
  { id: 'reviewer', name: '审查者', modelSelector: '', prompt: '只读审查，指出问题与建议，不改代码。', color: '#d47458', icon: 'shield', quota: 0, persona: '', speakingStyle: '', values: '', emotionBias: 0 },
])

const modeOptions = [
  { value: 'round_robin', label: '轮流发言' },
  { value: 'open', label: '开放抢麦' },
  { value: 'host', label: '主持指定' },
]
const iconOptions = [
  { value: 'chat', label: '💬 聊天' },
  { value: 'terminal', label: '💻 终端' },
  { value: 'shield', label: '🛡 审查' },
  { value: 'people', label: '👥 协作' },
  { value: 'sparkle', label: '✨ 创意' },
  { value: 'target', label: '🎯 目标' },
]
const modelOptions = computed(() => [
  { value: '', label: '默认模型' },
  ...props.models,
])

function addMember() {
  const palette = ['#2d61c6', '#d47458', '#1f9d6b', '#8b5cf6', '#db2777']
  const i = members.value.length
  const id = `m${Date.now()}_${i}`
  members.value.push({
    id, name: `成员${i + 1}`, modelSelector: props.models[0]?.value || '', prompt: '参与讨论，给出有帮助的回复。', color: palette[i % palette.length], icon: 'chat', quota: 8, persona: '', speakingStyle: '', values: '', emotionBias: 0,
  })
}

function removeMember(i: number) {
  if (members.value.length <= 1) return
  members.value.splice(i, 1)
}

function toggleExpand(id: string) {
  expanded.value[id] = !expanded.value[id]
}

function doSubmit() {
  if (!name.value.trim() || members.value.length < 1) return
  const list = members.value.map(m => ({
    ...m, modelSelector: m.modelSelector || props.models[0]?.value || '',
  }))
  emit('submit', name.value.trim(), topic.value.trim(), mode.value, list)
}
</script>

<template>
  <div v-if="open" class="mask enter-flat" @click.self="emit('close')">
    <div class="modal">
      <h3>创建群聊</h3>
      <label>群名称</label>
      <input v-model="name" placeholder="群名称" maxlength="30" />
      <label>话题</label>
      <input v-model="topic" placeholder="话题（可选）" maxlength="80" />
      <label>发言模式</label>
      <UiSelect v-model="mode" :options="modeOptions" block />
      <label>成员（{{ members.length }}）</label>
      <div class="members">
        <div v-for="(m, i) in members" :key="m.id" class="member-card">
          <div class="member-row">
            <span class="avatar sm" :style="{ background: m.color }">
              <CoomiIcon :name="m.icon || 'chat'" :size="14" />
            </span>
            <input v-model="m.name" class="name-input" placeholder="名字" maxlength="12" />
            <button class="expand-btn" @click="toggleExpand(m.id)">
              {{ expanded[m.id] ? '收起' : '更多' }}
            </button>
            <button class="rm" @click="removeMember(i)">✕</button>
          </div>
          <label class="fl">职业</label>
          <UiSelect v-model="m.icon" :options="iconOptions" block />
          <label class="fl">模型</label>
          <UiSelect v-model="m.modelSelector" :options="modelOptions" block placeholder="默认模型" />
          <label class="fl">职责 / 人设</label>
          <textarea v-model="m.prompt" class="field ta" placeholder="输入角色职责" rows="2" />
          <template v-if="expanded[m.id]">
            <label class="fl">扩展人设（可选）</label>
            <input v-model="m.persona" class="field" placeholder="更详细的人格描述" />
            <input v-model="m.speakingStyle" class="field" placeholder="说话风格（可选）" />
            <input v-model="m.values" class="field" placeholder="价值观（可选）" />
            <div class="quota-row">
              <label class="fl">发言配额</label>
              <input v-model.number="m.quota" type="number" min="0" class="quota-input" title="0=不限" />
            </div>
          </template>
        </div>
      </div>
      <button class="add-btn" @click="addMember">+ 添加成员</button>
      <div class="actions">
        <button class="btn ghost" @click="emit('close')">取消</button>
        <button class="btn primary" :disabled="!name.trim()" @click="doSubmit">创建</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed; inset: 0; background: rgba(0,0,0,0.4); z-index: var(--z-toast);
  display: flex; align-items: center; justify-content: center;
}
.modal {
  width: min(440px, 94vw); max-height: 85vh; overflow-y: auto;
  background: var(--bg); border-radius: var(--r-card); padding: var(--sp-4);
  /* 居中弹层入场：modalIn（已收敛 global.css，语义 = enter-pop），遮罩淡入由 .enter-flat 类负责 */
  animation: modalIn var(--dur-base) var(--ease-out) backwards;
}
.modal h3 { margin: 0 0 var(--sp-3); font-size: var(--fs-strong); }
label { display: block; font-size: var(--fs-label); font-weight: 600; color: var(--text-2); margin: 10px 0 var(--sp-1); }
input, select {
  width: 100%; padding: 9px 10px; border: 1px solid var(--border);
  border-radius: var(--r-md); font-size: var(--fs-sub); background: var(--bg); color: var(--text);
  box-sizing: border-box;
}
.members { display: flex; flex-direction: column; gap: 10px; }
.member-card {
  padding: 10px; border-radius: var(--r-md); background: var(--fill);
  display: flex; flex-direction: column; gap: 6px;
}
.member-row { display: flex; gap: 6px; align-items: center; }
.avatar {
  display: grid; place-items: center; border-radius: var(--r-md); color: #fff; flex-shrink: 0;
}
.avatar.sm { width: 28px; height: 28px; border-radius: var(--r-sm); }
.name-input { flex: 1; min-width: 0; }
.fl { font-size: var(--fs-caption); font-weight: 600; color: var(--text-2); margin-top: var(--sp-1); }
.ta { resize: none; min-height: 48px; font-family: inherit; }
.expand-btn {
  padding: var(--sp-1) var(--sp-2); border: 0; border-radius: var(--r-sm);
  background: var(--bg); font-size: var(--fs-caption); color: var(--text-2); cursor: pointer;
  flex-shrink: 0;
}
.rm {
  width: 28px; height: 28px; border: 0; border-radius: var(--r-sm);
  background: transparent; color: var(--danger); cursor: pointer;
  font-size: var(--fs-body); flex-shrink: 0;
}
.quota-row { display: flex; align-items: center; gap: var(--sp-2); font-size: var(--fs-label); color: var(--text-2); }
.quota-input {
  width: 60px; padding: 6px var(--sp-2); border: 1px solid var(--border);
  border-radius: var(--r-sm); font-size: var(--fs-sub); box-sizing: border-box;
  background: var(--bg); color: var(--text);
}
.add-btn {
  width: 100%; margin-top: 10px; padding: var(--sp-2);
  border: 1px dashed var(--border); border-radius: var(--r-sm);
  background: transparent; font-size: var(--fs-label); cursor: pointer; color: var(--text-2);
}
.actions { display: flex; gap: var(--sp-2); margin-top: 14px; }
.btn { flex: 1; padding: 10px; border: 0; border-radius: var(--r-md); font-size: var(--fs-sub); cursor: pointer; }
.btn.ghost { background: var(--fill); }
.btn.primary { background: var(--blue, #2d61c6); color: #fff; }
.btn.primary:disabled { opacity: 0.5; }

/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关） */
@media (prefers-reduced-motion: reduce) {
  .modal { animation: none; }
}
:root[data-motion='off'] .modal { animation: none; }
</style>
