<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { apiGet } from '@/bridge/http'
import { useSessionStore } from '@/stores/session'
import { goBack } from '@/bridge/navigation'
import PageHead from '@/components/PageHead.vue'
const router = useRouter()
const now = new Date(); const start = ref(new Date(now.getTime() - 7 * 86400000).toISOString().slice(0,16)); const end = ref(now.toISOString().slice(0,16))
const data = ref<{ input_tokens:number; cached_input_tokens:number; output_tokens:number; total_tokens:number; requests:number; records:Array<{timestamp_ms:number; reasoning_effort:string; total_tokens:number; input_tokens:number; output_tokens:number; elapsed_ms:number}> }>({ input_tokens:0,cached_input_tokens:0,output_tokens:0,total_tokens:0,requests:0,records:[] }); const error=ref(''); const busy=ref(false)
const fmt=(n:number)=>n.toLocaleString('zh-CN'); const time=(n:number)=>new Date(n).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})
const session=useSessionStore()
/**
 * 缓存命中率三态（与桌面端 DockUsageTab 同一口径）：
 *  · ready        —— 有可用比例，显示百分比；
 *  · unsupported  —— 引擎明确说本模型/供应商不提供缓存计量，显示「本模型/供应商未提供」，
 *                    绝不能落成 0%（0% 会被读成「一次都没命中」）；
 *  · pending      —— 旧引擎没这个字段 / 这一拍还没算出来，显示「—」。
 * 权威来源是实时 usage 事件的 cache_data_available / cache_hit_rate；账本 /api/usage
 * 不记 availability，只能在没有实时用量时用「命中输入/输入」兜底，且只在两者都 >0
 * 时才敢显示，避免把「供应商不提供」误报成 0%。
 */
const cache=computed<{state:'ready'|'unsupported'|'pending';text:string}>(()=>{
  const u=session.usage
  if(u){
    if(u.cacheDataAvailable===false)return{state:'unsupported',text:'本模型/供应商未提供'}
    if(u.cacheHitRate!=null&&Number.isFinite(u.cacheHitRate))return{state:'ready',text:`${(Math.min(1,Math.max(0,u.cacheHitRate))*100).toFixed(1)}%`}
    return{state:'pending',text:'—'}
  }
  const input=data.value.input_tokens; const cached=data.value.cached_input_tokens
  if(input>0&&cached>0)return{state:'ready',text:`${((cached/input)*100).toFixed(1)}%`}
  return{state:'pending',text:'—'}
})
/** 卡片副标题：命中/输入 token 走账本口径；无法计量时说明原因。命中率高=前缀被复用=更省钱更快。 */
const cacheHint=computed(()=>{
  if(cache.value.state==='unsupported')return '本模型/供应商未提供缓存计量，不代表命中率是 0%'
  if(cache.value.state==='pending')return '尚未拿到缓存计量'
  return `命中 ${fmt(data.value.cached_input_tokens)} / 输入 ${fmt(data.value.input_tokens)} token · 命中率高=前缀被复用=更省钱更快`
})
async function query(){busy.value=true;error.value='';try{data.value=await apiGet(`/api/usage?from=${Date.parse(start.value)}&to=${Date.parse(end.value)}`)}catch(e){error.value=e instanceof Error?e.message:String(e)}finally{busy.value=false}}
onMounted(query)
</script>
<template><div class="page"><PageHead title="用量统计（实验）" @back="goBack(router,'dashboard')"/><main class="body"><div class="filters"><label>开始<input v-model="start" type="datetime-local"/></label><label>结束<input v-model="end" type="datetime-local"/></label><button class="query" :disabled="busy" @click="query">查询</button></div><p v-if="error" class="error">{{ error }}</p><section class="cards"><div><span>总 Token</span><strong>{{ fmt(data.total_tokens) }}</strong></div><div><span>输入</span><strong>{{ fmt(data.input_tokens) }}</strong></div><div><span>输出</span><strong>{{ fmt(data.output_tokens) }}</strong></div><div><span>请求次数</span><strong>{{ fmt(data.requests) }}</strong></div><div><span>缓存命中率</span><strong :class="{muted:cache.state!=='ready'}">{{ cache.text }}</strong><em>{{ cacheHint }}</em></div></section><p class="sec-label">用量流水</p><section class="group"><p v-if="!data.records.length && !error" class="empty-sm">当前时间范围暂无记录</p><div v-for="(r,i) in data.records" :key="i" class="row"><span class="time">{{ time(r.timestamp_ms) }}</span><span class="effort">{{ r.reasoning_effort }}</span><span class="tokens">{{ fmt(r.total_tokens) }} tokens</span></div></section></main></div></template>
<style scoped>.page{display:flex;flex-direction:column;height:100%;background:var(--page)}.body{flex:1;overflow:auto;padding: 14px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6));min-width:0}.filters{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) minmax(0,auto);gap: 7px;align-items:end;max-width:100%;overflow:hidden}.filters label{display:flex;min-width:0;flex-direction:column;gap: var(--sp-1);color:var(--text-3);font-size: var(--fs-caption)}.filters input{display:block;min-width:0;width:100%;box-sizing:border-box; min-height:36px;padding: 0 6px;border:1px solid var(--border-strong);border-radius: var(--r-sm);background:var(--bg);color:var(--text);font-size: var(--fs-caption)}.query{min-height:36px;min-width:0;padding: 0 10px;border-radius: var(--r-sm);background:var(--blue);color:#fff;font-size: var(--fs-label);white-space:nowrap}.cards{display:grid;grid-template-columns:repeat(2,1fr);gap: var(--sp-2);margin-top: 14px}.cards div{padding: var(--sp-3);border-radius:var(--r-card);background:var(--bg);box-shadow:var(--shadow-1)}.cards span{display:block;color:var(--text-3);font-size: var(--fs-caption)}.cards strong{display:block;margin-top: var(--sp-1);color:var(--text);font-size: var(--fs-heading);font-variant-numeric:tabular-nums}.cards strong.muted{font-size: var(--fs-body);color:var(--text-3)}.cards em{display:block;margin-top: var(--sp-1);color:var(--text-3);font-size: var(--fs-caption);line-height: 1.4}.sec-label{margin: 18px 0 6px}.group{overflow:hidden;border-radius:var(--r-card);background:var(--bg);box-shadow:var(--shadow-1)}.row{display:grid;grid-template-columns:1fr auto auto;gap: 10px;padding: var(--sp-3) 13px;border-bottom:1px solid var(--border);font-size: var(--fs-label)}.row:last-child{border-bottom:0}.time{color:var(--text-2)}.effort{color:var(--blue)}.tokens{color:var(--text-3);font-variant-numeric:tabular-nums}.error{color:var(--danger);font-size: var(--fs-label)}</style>
