<script setup lang="ts">
/**
 * 会话历史整页版（抽屉的补充：多了搜索结果计数和「清空全部」）。
 *
 * 列表来自引擎磁盘会话（/api/sessions 为权威源），本地 localStorage 保存标题/置顶等
 * 元数据与最近对话正文；删除会话会同时删除引擎磁盘记录与本地记录。
 */
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { useSessionStore } from '@/stores/session'
import { useSessionsStore, formatSessionTime, type SessionMeta } from '@/stores/sessions'
import { useConfigStore } from '@/stores/config'
import { useDeviceStore } from '@/stores/device'
import PageHead from '@/components/PageHead.vue'
import CoomiIcon from '@/components/CoomiIcon.vue'
import AgentState from '@/components/ai/AgentState.vue'
import UiEmpty from '@/components/ui/UiEmpty.vue'

const router = useRouter()
const session = useSessionStore()
const sessions = useSessionsStore()
const config = useConfigStore()
const device = useDeviceStore()

const menuFor = ref<SessionMeta | null>(null)
const askDelete = ref<SessionMeta | null>(null)
const askClear = ref(false)
/** 云端但没选电脑：这个上下文没有历史，也不能去读本地引擎的列表。 */
const cloudUnselected = computed(() => device.mode === 'cloud' && !device.deviceId)

function open(id: string) {
  session.openSession(id)
  router.push('/')
}

function startNew() {
  session.newSession()
  router.push('/')
}

function doPin() {
  if (menuFor.value) sessions.togglePin(menuFor.value.id)
  menuFor.value = null
}

function confirmDelete() {
  if (askDelete.value) session.deleteSession(askDelete.value.id)
  askDelete.value = null
  menuFor.value = null
}

function doClear() {
  askClear.value = false
  sessions.clearAll()
  session.newSession()
  router.push('/')
}

// 进入页面时先同步引擎磁盘会话（权威源），再刷新各会话的后台运行状态。
// 只刷新 running 会导致直接从对话页跳进来时列表为空/无摘要。
onMounted(() => {
  // 云端未选设备时本地引擎的列表不属于当前上下文：确保内存里也没有残留。
  if (cloudUnselected.value) { sessions.clearSessions(); return }
  void sessions.syncFromEngine({ replace: device.mode === 'cloud' })
  sessions.refreshRunning()
})
</script>
<template>
  <div class="page">
    <PageHead title="会话历史" @back="router.push('/')">
      <template #right>
        <button class="icon-btn blue" aria-label="新对话" @click="startNew">
          <CoomiIcon name="plus" />
        </button>
      </template>
    </PageHead>

    <div class="searchrow">
      <span class="search">
        <CoomiIcon name="search" :size="16" />
        <input v-model="sessions.query" class="sinput" placeholder="搜索会话标题" />
        <button v-if="sessions.query" class="clr" aria-label="清空" @click="sessions.query = ''">
          <CoomiIcon name="close" :size="14" />
        </button>
      </span>
    </div>

    <main class="body">
      <!-- 历史会话列表始终可见；「全局会话记忆」开关只控制模型能否读取这些记录。 -->
      <!-- 空态统一走 <UiEmpty>：图标 + 标题 + 一句说明，规格在 global.css 一处。
           这两种情况都没有可执行的动作（新建入口在页头右上角），所以不给 action 槽。 -->
      <UiEmpty
        v-if="sessions.metas.length === 0"
        icon="chat"
        :title="cloudUnselected ? '还没有选择电脑' : '还没有历史会话'"
        :desc="cloudUnselected ? '先回到对话页侧栏选择一台电脑，历史会从这台电脑同步。' : '回到对话随便说点什么，标题会用你的第一句话。'"
      />
      <UiEmpty
        v-else-if="sessions.filtered.length === 0"
        icon="search"
        title="没有匹配的会话"
        :desc="'没有匹配「' + sessions.query + '」的会话，换个关键词试试。'"
      />

        <div class="group">
          <!-- .enter-item：列表项档入场 + 前 8 项错峰。
               :key 是稳定的 m.id，所以 syncFromEngine 回来刷新时已有行是就地 patch，
               不会重挂载、不会整列重播；只有真正新增的会话才走一次入场。 -->
          <div v-for="m in sessions.flat" :key="m.id" class="row enter-item" :class="{ cur: m.id === session.sessionId }">
            <button class="rmain" @click="open(m.id)">
              <span class="rtitle">
                <CoomiIcon v-if="m.pinned" name="pin" :size="13" class="pin" />
                <span class="ttext">{{ m.title }}</span>
              </span>
              <span v-if="m.summary" class="rsummary">{{ m.summary }}</span>
              <span class="rmeta">
                <span v-if="m.id === session.sessionId" class="badge">当前</span>
                {{ formatSessionTime(m.updatedAt) }} · {{ m.turns }} 轮
                <AgentState
                  v-if="sessions.isRunning(m.id)"
                  state="running"
                  size="xs"
                  tone="primary"
                  label="后台运行中"
                  class="rspin"
                />
              </span>
            </button>
            <button class="more" aria-label="更多" @click="menuFor = m"><CoomiIcon name="more" :size="18" /></button>
          </div>
        </div>
        <button v-if="sessions.metas.length" class="btn btn-danger wide" @click="askClear = true">清空全部记录</button>
        <p class="note">
          历史会话保存在引擎里（这台手机的应用私有目录），最近 12 条会留完整对话内容。
          用同一个会话继续时，只要引擎进程还活着就是真的接上了上下文；引擎重启过的话，
          就只剩本机这份记录。
        </p>
    </main>
    <div v-if="menuFor" class="scrim" @click.self="menuFor = null">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">{{ menuFor.title }}</p>
        <button class="sact" @click="doPin">
          <CoomiIcon name="pin" :size="17" /><span>{{ menuFor.pinned ? '取消置顶' : '置顶' }}</span>
        </button>
        <button class="sact danger" @click="askDelete = menuFor; menuFor = null">
          <CoomiIcon name="trash" :size="17" /><span>删除会话</span>
        </button>
        <button class="sact plain" @click="menuFor = null"><span>取消</span></button>
      </div>
    </div>

    <div v-if="askDelete" class="scrim" @click.self="askDelete = null">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">删除这个会话？</p>
        <p class="ssub">「{{ askDelete.title }}」的引擎记录与本机记录都会被删除，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="askDelete = null">取消</button>
          <button class="btn btn-danger" @click="confirmDelete">删除</button>
        </div>
      </div>
    </div>

    <div v-if="askClear" class="scrim" @click.self="askClear = false">
      <div class="sheet">
        <div class="grip" />
        <p class="stitle">清空全部 {{ sessions.metas.length }} 条记录？</p>
        <p class="ssub">本机的标题和对话内容都会删掉，无法恢复。</p>
        <div class="sacts">
          <button class="btn" @click="askClear = false">取消</button>
          <button class="btn btn-danger" @click="doClear">清空</button>
        </div>
      </div>
    </div>

  </div>
</template>
<style scoped>
.page { display: flex; flex-direction: column; height: 100%; background: var(--page); }
.icon-btn.blue { color: var(--blue); }

.searchrow { flex-shrink: 0; padding: 10px var(--sp-3) var(--sp-1); background: var(--page); }
.search {
  display: flex; align-items: center; gap: var(--sp-2);
  height: 40px; padding: 0 var(--sp-3); border-radius: var(--r-pill);
  background: var(--bg); color: var(--text-3); box-shadow: var(--shadow-1);
}
.sinput { flex: 1; min-width: 0; border: 0; background: none; font-size: var(--fs-body); color: var(--text); }
.sinput:focus { outline: none; }
.sinput::placeholder { color: var(--text-3); }
.clr { display: grid; place-items: center; width: 22px; height: 22px; border-radius: 50%; background: var(--fill-strong); color: var(--text-2); }

.body { flex: 1; overflow-y: auto; padding: 6px var(--sp-3) calc(var(--safe-bottom) + var(--sp-6)); }
/* 空态不再由本页定义，已统一到 <UiEmpty>。 */
.sec-label { margin: 14px 0 0; }

.group { border-radius: var(--r-card); background: var(--bg); box-shadow: var(--shadow-1); overflow: hidden; }
.row { display: flex; align-items: stretch; }
.row + .row { border-top: 1px solid var(--border); }
.row.cur { background: var(--blue-soft); }
.rmain { flex: 1; min-width: 0; padding: var(--sp-3) var(--sp-1) var(--sp-3) 14px; text-align: left; }
.rmain:active { background: var(--fill); }
.rtitle { display: flex; align-items: center; gap: 5px; }
.pin { flex-shrink: 0; color: var(--blue); }
.rmeta { display: flex; align-items: center; gap: 6px; margin-top: 2px; font-size: var(--fs-label); color: var(--text-3); }
/* 会话后台执行中的状态点阵：running 语义（环快转 + 点阵收紧放开），
   替掉原来那个单点呼吸 —— 单点只能说「有东西在动」，点阵能说「在跑」。 */
.rspin { flex-shrink: 0; }
.ttext {
  min-width: 0; font-size: var(--fs-body); font-weight: 500; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
/* 会话摘要（引擎侧推导，供检索与快速识别内容） */
.rsummary {
  display: block; margin-top: 3px; font-size: var(--fs-label); line-height: 1.5; color: var(--text-2); /* 三级墨色：标题/摘要/元信息 */
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.badge { padding: 1px 7px; border-radius: var(--r-pill); background: color-mix(in srgb, var(--blue) 82%, #000); color: #fff; font-size: var(--fs-caption); font-weight: 600; /* 白字在暗蓝上 ≥4.5 */ }
.more { display: grid; place-items: center; flex-shrink: 0; width: 44px; color: var(--text-3); }
.more:active { background: var(--fill); }
/* 选中行按压也留在蓝系（而非变灰），选中/按压态观感一致；元信息提档保证软底对比度 */
.row.cur .rmeta { color: var(--text-2); }
.row.cur .rmain:active { background: var(--blue-soft-2); }

.wide { width: 100%; margin-top: 18px; }
.note { margin-top: 14px; padding: 0 var(--sp-1); font-size: var(--fs-label); line-height: 1.75; color: var(--text-3); }
.scrim {
  position: fixed; inset: 0; z-index: 70;
  display: flex; align-items: flex-end;
  background: rgba(17, 22, 31, .36); animation: coomi-enter-flat var(--enter-flat-dur) var(--ease-out); /* fade 与 enter-flat 逐字相同，复用 token */
}
.sheet {
  width: 100%; padding: 6px 14px calc(var(--safe-bottom) + 14px);
  border-radius: var(--r-sheet) var(--r-sheet) 0 0; background: var(--bg);
  box-shadow: var(--shadow-sheet); animation: rise var(--enter-block-dur) var(--ease-out); /* rise 已收敛到 global.css */
}
/* 减弱动态效果：弹层直接出现（系统级 + 应用内开关；原 scrim/sheet 内联入场在此归零） */
@media (prefers-reduced-motion: reduce) {
  .scrim, .sheet { animation: none; }
}
:root[data-motion='off'] .scrim, :root[data-motion='off'] .sheet { animation: none; }
.grip { width: 38px; height: 4px; margin: var(--sp-1) auto var(--sp-3); border-radius: 2px; background: var(--border-strong); }
.stitle {
  padding: 0 6px 10px; font-size: var(--fs-body); font-weight: 600; color: var(--text);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ssub { padding: 0 6px; font-size: var(--fs-sub); line-height: 1.6; color: var(--text-2); }
.sact {
  display: flex; align-items: center; gap: 11px;
  width: 100%; min-height: 50px; padding: 0 var(--sp-3);
  border-radius: var(--r-md); text-align: left;
  font-size: var(--fs-body-lg); color: var(--text);
}
.sact:active { background: var(--fill); }
.sact :deep(svg) { color: var(--text-2); }
.sact.danger, .sact.danger :deep(svg) { color: var(--danger); }
.sact.plain { justify-content: center; margin-top: var(--sp-1); color: var(--text-2); font-weight: 500; }
.sacts { display: flex; gap: var(--sp-2); margin-top: var(--sp-4); }
.sacts .btn { flex: 1; }

</style>


