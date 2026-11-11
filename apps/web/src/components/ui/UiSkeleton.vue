<script setup lang="ts">
/**
 * 加载骨架。
 *
 * 规范：加载态一律用骨架，不用转圈、也不用一句「加载中…」顶着。
 * 骨架按「真实内容的形状」摆位（形状基元都在 global.css 的「加载骨架」段），
 * 这样数据到达时行高、缩进、留白都对得上，整列内容不会往下跳。
 *
 * 四种变体对应本 app 真实出现的四种信息结构：
 *   list    —— 会话 / 群聊 / 提供商列表：圆头像 + 标题 + 副标题
 *   card    —— 目录 / 记忆 / 任务卡片：标题 + 两行正文 + 一个药丸标签
 *   message —— 聊天记录：左头像 + 右气泡（每条正文行数不同，才不像一段灰栅栏）
 *   detail  —— 键值详情：一短标签 + 一长值
 *
 * 新增结构请先复用这四种；确实需要新形状时，先在 global.css 加基元，再在这里加变体，
 * 不要在调用方各写一堆 .sk + 内联宽高。
 */
withDefaults(defineProps<{
  variant?: 'list' | 'card' | 'message' | 'detail'
  rows?: number
}>(), { variant: 'list', rows: 4 })

/** 每行的正文行数：让骨架的纹理有起伏，全部等长会像一段灰色栅栏。 */
function lineWidths(i: number): [string, string] {
  const a = [58, 72, 46, 66][i % 4]
  const b = [86, 64, 78, 54][i % 4]
  return [a + '%', b + '%']
}
</script>

<template>
  <div
    :class="['sk-wrap', 'sk-wrap--' + variant]"
    role="status"
    aria-label="加载中"
  >
    <!-- 列表行：头像 + 两行文字 -->
    <template v-if="variant === 'list'">
      <div v-for="i in rows" :key="i" class="sk-row">
        <span class="sk sk-avatar" />
        <span class="sk-body">
          <span class="sk sk-title" :style="{ width: lineWidths(i)[0] }" />
          <span class="sk sk-line" :style="{ width: lineWidths(i)[1] }" />
        </span>
      </div>
    </template>

    <!-- 卡片：标题 + 两行正文 + 一个标签 -->
    <template v-else-if="variant === 'card'">
      <div v-for="i in rows" :key="i" class="sk-card">
        <span class="sk sk-title" style="width: 62%" />
        <span class="sk sk-line" :style="{ width: lineWidths(i)[1] }" />
        <span class="sk sk-line" :style="{ width: lineWidths(i)[0] }" />
        <span class="sk sk-chip" />
      </div>
    </template>

    <!-- 消息：偶数条留右侧气泡（自己发的），和真实对话的左右分布一致 -->
    <template v-else-if="variant === 'message'">
      <div v-for="i in rows" :key="i" class="sk-msg" :class="{ mine: i % 3 === 0 }">
        <span v-if="i % 3 !== 0" class="sk sk-avatar" />
        <span class="sk sk-bubble" :class="{ mine: i % 3 === 0 }">
          <span class="sk sk-line" :style="{ width: lineWidths(i)[0] }" />
          <span class="sk sk-line" :style="{ width: lineWidths(i)[1] }" />
        </span>
      </div>
    </template>

    <!-- 详情：一短标签 + 一长值 -->
    <template v-else>
      <div v-for="i in rows" :key="i" class="sk-row sk-detail">
        <span class="sk sk-line" style="width: 84px; flex: none" />
        <span class="sk sk-line" :style="{ width: lineWidths(i)[1] }" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* 外层容器只管排布；行高 / 圆角 / 颜色全部来自 global.css 的形状基元，
   这样骨架和正文的间距只在一处定义（列表是 --sp-4、卡片是 --sp-3、消息是 --sp-3）。 */
.sk-wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-2) var(--sp-1);
}
.sk-wrap--card { gap: var(--sp-3); }
.sk-wrap--message, .sk-wrap--detail { gap: var(--sp-3); }

/* 形状基元在 global.css，但「怎么排」必须在这里：以前只写了宽高，
   没有 flex 行/列，span 还是 inline，骨架实际塌成一条看不见的线。
   列表/卡片/消息/详情四种变体都要给出各自的容器布局。 */
.sk { display: block; }
.sk-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  min-width: 0;
}
.sk-body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sk-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.sk-msg {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-2);
}
.sk-msg.mine { justify-content: flex-end; }
.sk-detail { gap: var(--sp-3); }

.sk-row .sk-avatar { width: 40px; height: 40px; }
.sk-msg .sk-avatar { width: 32px; height: 32px; }

/* 气泡内部自己排两行：真实气泡是竖着堆两行的，不排就退化成一根灰条 */
.sk-bubble {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding: 10px var(--sp-3);
  border-radius: var(--r-card) var(--r-card) var(--r-sm) var(--r-card);
}
.sk-bubble.mine { border-radius: var(--r-card) var(--r-card) var(--r-card) var(--r-sm); }
.sk-bubble .sk-line { height: 12px; }

/* 卡片骨架里的药丸要和正文标签同高，标签才会在数据到达时停在原位 */
.sk-card .sk-chip { margin-top: var(--sp-1); }
</style>
