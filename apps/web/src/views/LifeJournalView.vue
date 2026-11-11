<script setup lang="ts">
/**
 * 数字生命体 · 心情日记（三级页）。
 * 由 LifeView「心情日记 > 查看更多」进入：全部主动问候日记 + 触发类型筛选。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet } from '@/bridge/http'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'

interface JournalEntry {
  at_ms: number
  text: string
  trigger: string
  life_name: string
  emotion: string
  bond: number
  needs: Record<string, number>
}

const PAGE = 50
const FILTERS = [
  { value: '', label: '全部' },
  { value: 'everyday', label: '日常问候' },
  { value: 'lonely', label: '想你了' },
  { value: 'growth_checkin', label: '成长' },
  { value: 'support', label: '关心' },
]

const router = useRouter()
const entries = ref<JournalEntry[]>([])
const loading = ref(false)
const more = ref(true)
const error = ref('')
const filter = ref('')

const filtered = computed(() =>
  filter.value ? entries.value.filter(entry => entry.trigger === filter.value) : entries.value,
)

async function load(reset: boolean) {
  if (loading.value) return
  loading.value = true
  error.value = ''
  try {
    const offset = reset ? 0 : entries.value.length
    const data = await apiGet<{ entries: JournalEntry[] }>(`/api/life/journal?limit=${PAGE}&offset=${offset}`)
    const items = data?.entries ?? []
    entries.value = reset ? items : [...entries.value, ...items]
    more.value = items.length >= PAGE
  } catch (reason) {
    error.value = reason instanceof Error ? reason.message : String(reason)
  } finally {
    loading.value = false
  }
}

function formatTime(atMs: number): string {
  const d = new Date(atMs)
  return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

onMounted(() => { void load(true) })
</script>

<template>
  <div class="page">
    <PageHead title="心情日记" @back="goBack(router, '/life')" />
    <main class="body">
      <div v-if="error" class="notice error">{{ error }}</div>
      <div class="chips">
        <button
          v-for="item in FILTERS"
          :key="item.value"
          class="chip"
          :class="{ on: filter === item.value }"
          @click="filter = item.value"
        >{{ item.label }}</button>
      </div>

      <p v-if="filtered.length === 0 && !loading && !error" class="empty-sm">
        {{ filter ? '该类型下暂无记录。' : '暂无主动问候记录。开启「主动问候」后，它每次主动找你都会在这里留下一笔。' }}
      </p>
      <div v-for="(entry, index) in filtered" :key="index" class="journal">
        <p class="head">
          <span>{{ formatTime(entry.at_ms) }}</span>
          <b>{{ FILTERS.find(item => item.value === entry.trigger)?.label ?? entry.trigger }}</b>
        </p>
        <p class="text">{{ entry.text }}</p>
      </div>

      <button v-if="more" class="more" :disabled="loading" @click="load(false)">
        {{ loading ? '加载中…' : '加载更多' }}
      </button>
      <p v-else-if="entries.length" class="end">—— 日记已全部加载 ——</p>
    </main>
  </div>
</template>

<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.body { flex: 1; overflow-y: auto; padding: 14px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6)); }
.notice { margin-bottom: 10px; padding: 9px 11px; border-radius: var(--r-sm); background: color-mix(in srgb, var(--danger) 10%, var(--bg)); color: var(--danger); font-size: var(--fs-label); }
.chips { display: flex; flex-wrap: wrap; gap: 7px; margin-bottom: var(--sp-3); }
.chip { min-height: 30px; padding: 0 var(--sp-3); border-radius: var(--r-pill); background: var(--fill); color: var(--text-2); font-size: var(--fs-label); }
.chip.on { background: var(--blue); color: #fff; }
.journal { margin-bottom: 9px; padding: 11px 13px; border-radius: var(--r-md); background: var(--bg); box-shadow: var(--shadow-1); }
.head { display: flex; align-items: center; justify-content: space-between; margin: 0 0 5px; color: var(--text-3); font-size: var(--fs-caption); }
.head b { color: var(--accent); font-size: var(--fs-caption); font-weight: 600; }
.text { margin: 0; color: var(--text-2); font-size: var(--fs-sub); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
.more { width: 100%; min-height: 42px; margin-top: var(--sp-1); border-radius: var(--r-md); background: var(--fill); color: var(--text-2); font-size: var(--fs-sub); }
.more:disabled { opacity: .5; }
.end { margin: var(--sp-3) 0 2px; text-align: center; color: var(--text-3); font-size: var(--fs-caption); }
</style>
