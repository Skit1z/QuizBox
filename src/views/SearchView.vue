<script setup lang="ts">
import { ref, watch, onBeforeUnmount, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { questionsRepo } from '@/db/questions'
import { useSubjectsStore } from '@/stores/subjects'
import { QUESTION_TYPE_LABELS, type Question } from '@/types'

const router = useRouter()
const subjectsStore = useSubjectsStore()

onMounted(async () => {
  await subjectsStore.load()
})

const keyword = ref('')
const results = ref<Question[]>([])
const searching = ref(false)

let timer: ReturnType<typeof setTimeout> | null = null
async function doSearch() {
  if (!keyword.value.trim()) {
    results.value = []
    return
  }
  searching.value = true
  try {
    results.value = await questionsRepo.search(keyword.value)
  } finally {
    searching.value = false
  }
}

watch(keyword, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(doSearch, 300)
})

function subjectName(id: string): string {
  return subjectsStore.list.find((s) => s.id === id)?.name || ''
}

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer)
})
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">搜索题目</h1>
      </div>
    </div>

    <van-search
      v-model="keyword"
      placeholder="搜索题干、选项、解析"
      shape="round"
      @search="doSearch"
    />

    <div v-if="searching" style="text-align: center; padding: var(--sp-8)">
      <van-loading size="20" />
    </div>

    <div v-else-if="keyword && results.length === 0" class="empty">
      <van-icon name="search" size="36" color="var(--text-3)" />
      <p class="empty__desc">未找到相关题目</p>
    </div>

    <div v-else-if="results.length" class="result-list">
      <div
        v-for="q in results"
        :key="q.id"
        class="result-card card card--clickable"
        @click="router.push({ name: 'subject-detail', params: { subjectId: q.subjectId }, query: { focus: q.id } })"
      >
        <div class="result-card__meta">
          <van-tag plain>{{ QUESTION_TYPE_LABELS[q.type] }}</van-tag>
          <span class="chip">{{ subjectName(q.subjectId) }}</span>
        </div>
        <div class="result-card__stem">{{ q.stem.slice(0, 80) }}</div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}
.page-head__left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  cursor: pointer;
}
.page-title--sm {
  font-size: 18px;
  margin: 0;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-8) var(--sp-4);
  gap: var(--sp-2);
}
.empty__desc {
  font-size: 13px;
  color: var(--text-3);
}
.result-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.result-card {
  padding: var(--sp-4) var(--sp-5);
}
.result-card__meta {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.result-card__stem {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}
</style>
