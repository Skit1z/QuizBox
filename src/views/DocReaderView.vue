<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useDocsStore } from '@/stores/docs'

defineOptions({ name: 'DocReaderView' })

const route = useRoute()
const router = useRouter()
const store = useDocsStore()

onMounted(async () => {
  const id = String(route.params.id)
  try {
    await store.open(id)
  } catch (e: any) {
    showFailToast(e?.message || '无法获取文档')
  }
})

onBeforeUnmount(() => {
  store.clearCurrent()
})
</script>

<template>
  <div class="reader-page">
    <van-nav-bar
      :title="store.current?.meta.name || '阅读'"
      left-arrow
      @click-left="router.back()"
    />
    <div class="reader-body">
      <van-loading v-if="store.currentLoading" class="reader-loading" type="spinner" vertical>
        加载中…
      </van-loading>
      <van-empty v-else-if="!store.current" description="文档无法显示" />
      <!-- 阅读零解析开销:HTML 已是渲染产物,图片 URL 浏览器自动加载 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="doc-prose" v-html="store.current.html"></div>
    </div>
  </div>
</template>

<style scoped>
.reader-page {
  min-height: 100vh;
  background: var(--surface);
}
.reader-body {
  padding: var(--sp-4) var(--sp-3) var(--sp-8);
}
.reader-loading {
  display: flex;
  justify-content: center;
  padding: var(--sp-8);
}

/* 文档 prose 排版(复用题库 RichText 的排版语义) */
.doc-prose {
  font-size: 16px;
  line-height: 1.75;
  color: var(--text);
  word-break: break-word;
}
.doc-prose :deep(h1),
.doc-prose :deep(h2),
.doc-prose :deep(h3) {
  margin: var(--sp-5) 0 var(--sp-2);
  font-weight: 700;
  line-height: 1.3;
}
.doc-prose :deep(h1) {
  font-size: 22px;
}
.doc-prose :deep(h2) {
  font-size: 19px;
}
.doc-prose :deep(h3) {
  font-size: 17px;
}
.doc-prose :deep(p) {
  margin: var(--sp-2) 0;
}
.doc-prose :deep(ul),
.doc-prose :deep(ol) {
  margin: var(--sp-2) 0;
  padding-left: var(--sp-5);
}
.doc-prose :deep(li) {
  margin: var(--sp-1) 0;
}
.doc-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: var(--sp-3) 0;
  font-size: 14px;
}
.doc-prose :deep(th),
.doc-prose :deep(td) {
  border: 1px solid var(--border);
  padding: var(--sp-2);
  text-align: left;
}
.doc-prose :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
}
.doc-prose :deep(code) {
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
}
.doc-prose :deep(pre) {
  background: var(--surface-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  overflow-x: auto;
  margin: var(--sp-3) 0;
}
.doc-prose :deep(pre code) {
  background: none;
  padding: 0;
}
.doc-prose :deep(blockquote) {
  margin: var(--sp-3) 0;
  padding: var(--sp-2) var(--sp-4);
  border-left: 3px solid var(--brand);
  color: var(--text-2);
}
.doc-prose :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-md);
  margin: var(--sp-3) 0;
}
.doc-prose :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  margin: var(--sp-3) 0;
}
</style>
