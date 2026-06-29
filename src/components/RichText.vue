<script setup lang="ts">
import { computed } from 'vue'
import { renderRichText } from '@/utils/katex'

const props = defineProps<{
  text: string
}>()

const html = computed(() => renderRichText(props.text))
</script>

<template>
  <!-- renderRichText 已统一处理 KaTeX/富文本输出，这里保留 HTML 渲染入口。 -->
  <!-- eslint-disable-next-line vue/no-v-html -->
  <div class="rich-text" v-html="html"></div>
</template>

<style scoped>
.rich-text {
  line-height: 1.7;
  word-break: break-word;
}
.rich-text :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  margin: 8px 0;
}
</style>
