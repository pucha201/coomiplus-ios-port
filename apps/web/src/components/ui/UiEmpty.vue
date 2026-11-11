<script setup lang="ts">
/**
 * 统一空态：图标（可省）→ 标题 → 一句说明 → 一个动作（可省）。
 *
 * 为什么不放插画：同一个插画在十几个空页面里重复出现，
 * 只会让人以为是同一件事出了十次；一个图标 + 一句话已经说清了「这里是空的、为什么空」。
 *
 * 用法：
 *   <UiEmpty icon="folder" title="空目录" desc="这个文件夹里还没有文件。" />
 *   <UiEmpty icon="chat" title="还没有群聊" desc="创建一个群…">
 *     <UiButton @click="openCreate">创建群聊</UiButton>
 *   </UiEmpty>
 *
 * 动效只有图标那一次 enter-pop，文字不做逐行入场：
 * 空态要的是「立刻知道发生了什么」，逐行淡入反而把它变成一次表演。
 * 视觉规格全部来自 global.css 的 .empty-state* 系列，本组件不再写一份样式。
 */
import { computed } from 'vue'
import CoomiIcon from '@/components/CoomiIcon.vue'

const props = withDefaults(defineProps<{
  icon?: string
  iconSize?: number
  title: string
  desc?: string
}>(), { iconSize: 24 })

/** 图标名兜底成空串而不是 undefined：CoomiIcon 的 name 是必填 string，
 *  而模板里的 v-if 没法把可选项收窄成 string，交给这里统一处理。 */
const iconName = computed(() => props.icon || '')
</script>

<template>
  <div class="empty-state">
    <!-- #art 里是调用方自己的插画时不再套 64px 灰圆底：
         插画自带底色，再叠一层圆会变成「圆上画圆」。用显式类而不是 :has()，
         旧 WebView 不会漏判。 -->
    <span v-if="icon || $slots.art" class="empty-state-art" :class="{ 'empty-state-art--bare': $slots.art }">
      <slot name="art">
        <CoomiIcon v-if="iconName" :name="iconName" :size="iconSize" />
      </slot>
    </span>
    <p class="empty-state-title">{{ title }}</p>
    <p v-if="desc" class="empty-state-desc">{{ desc }}</p>
    <div v-if="$slots.default" class="empty-state-action">
      <slot />
    </div>
  </div>
</template>
