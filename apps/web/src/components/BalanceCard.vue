<script setup lang="ts">
/**
 * 厂商账户余额（用量面板底部）。
 *
 * 只做展示：请求由引擎发起（密钥不出引擎），这里拿到的就是最终结果。
 *
 * 这张卡**常驻**：查不到余额时显示「当前账户无法查询」，而不是整块消失。
 * 以前读不到就 v-if 隐藏，面板内容高度会突然变化（看起来像「余额莫名其妙没了」），
 * 用户也不知道是没有这个能力还是查询失败。
 */
import { computed, onMounted, ref, watch } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import { authedFetch } from '@/bridge/http'
import { useConfigStore } from '@/stores/config'

interface BalanceReport {
  supported?: boolean
  currency?: string
  total?: string | number | null
  granted?: string | number | null
  toppedUp?: string | number | null
  source?: string
  reason?: string
  checkedAt?: number
}

const config = useConfigStore()
const data = ref<BalanceReport | null>(null)
const busy = ref(false)

/** 错误状态只影响「这一屏显示什么」，绝不清掉上一次已知的余额。 */
const lastError = ref('')

async function load(refresh = false): Promise<void> {
  const id = config.currentProviderId
  if (!id) { lastError.value = '尚未选择模型供应商'; return }
  busy.value = true
  try {
    const url = `/api/providers/${encodeURIComponent(id)}/balance${refresh ? '?refresh=1' : ''}`
    const response = await authedFetch(url)
    if (!response.ok) { lastError.value = `查询失败（HTTP ${response.status}）`; return }
    const text = await response.text()
    if (!text.trim().startsWith('{')) { lastError.value = '厂商返回了无法识别的内容'; return }
    data.value = JSON.parse(text) as BalanceReport
    lastError.value = ''
  } catch (error) {
    lastError.value = error instanceof Error && error.message ? error.message : '网络不可用'
  } finally {
    busy.value = false
  }
}

onMounted(() => { void load() })
watch(() => config.currentProviderId, () => { void load() })

/** 有可展示的金额才算「查到了」；否则一律落到「当前账户无法查询」。 */
const hasAmount = computed(() =>
  data.value?.supported === true && data.value?.total !== null && data.value?.total !== undefined,
)
/** 查不到时的原因：优先用引擎给的 reason，其次用本轮请求的错误。 */
const unavailableHint = computed(() => {
  const reason = String(data.value?.reason ?? '').trim()
  if (reason) return reason
  if (data.value && data.value.supported === false) return '该厂商未提供余额查询接口'
  if (lastError.value) return `当前账户无法查询：${lastError.value}`
  return '暂未获取到余额信息，可点击刷新重试'
})
const symbol = computed(() => {
  const currency = String(data.value?.currency ?? '').toUpperCase()
  if (currency === 'CNY' || currency === 'RMB') return '¥'
  if (currency === 'USD') return '$'
  if (currency === 'EUR') return '€'
  return ''
})
const amount = computed(() => {
  const raw = data.value?.total
  const text = typeof raw === 'number' ? raw.toFixed(2) : String(raw ?? '')
  return `${symbol.value}${text}`
})
/** 上游给了分项才显示（DeepSeek/Moonshot 会给，OpenRouter 只有总额）。 */
const breakdown = computed(() => {
  const granted = data.value?.granted
  const topped = data.value?.toppedUp
  const parts: string[] = []
  if (granted !== null && granted !== undefined) parts.push(`赠送 ${symbol.value}${granted}`)
  if (topped !== null && topped !== undefined) parts.push(`充值 ${symbol.value}${topped}`)
  return parts.join(' · ')
})
</script>

<template>
  <div class="balance">
    <div class="brow">
      <span class="blabel">账户余额</span>
      <span class="bamount" :class="{ bunknown: !hasAmount }">
        {{ hasAmount ? amount : (busy ? '查询中…' : '当前账户无法查询') }}
      </span>
      <button class="brefresh" type="button" :aria-label="busy ? '刷新中' : '刷新余额'" :disabled="busy" @click="load(true)">
        <CoomiIcon name="refresh" :size="13" />
      </button>
    </div>
    <p v-if="hasAmount && breakdown" class="bbreak">{{ breakdown }}</p>
    <p class="bfoot">{{ hasAmount ? '来自厂商账户接口' : unavailableHint }}</p>
  </div>
</template>

<style scoped>
.balance {
  margin-top: var(--sp-2); padding-top: var(--sp-2);
  border-top: .5px solid color-mix(in srgb, var(--text) 8%, transparent);
}
.brow { display: flex; align-items: center; gap: var(--sp-2); }
.blabel { flex: 1; min-width: 0; font-size: var(--fs-label); color: var(--text-3); }
.bamount {
  font-size: var(--fs-strong); font-weight: 600; color: var(--text);
  font-variant-numeric: tabular-nums;
}
/* 查不到余额时用次一级的文字色 + 常规字重：它是状态说明，不是金额。 */
.bamount.bunknown { font-size: var(--fs-label); font-weight: 500; color: var(--text-3); }
.brefresh {
  display: grid; place-items: center; flex: none; width: 24px; height: 24px;
  border-radius: 50%; background: var(--fill); color: var(--text-3);
}
.brefresh:disabled { opacity: .5; }
.bbreak { margin: 2px 0 0; font-size: var(--fs-caption); color: var(--text-3); font-variant-numeric: tabular-nums; }
.bfoot { margin: var(--sp-1) 0 0; font-size: var(--fs-caption); color: var(--text-3); opacity: .75; }
</style>
