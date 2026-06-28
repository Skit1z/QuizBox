<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showSuccessToast } from 'vant'
import { questionsRepo } from '@/db/questions'
import { useSubjectsStore } from '@/stores/subjects'
import QuestionCard from '@/components/QuestionCard.vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import type { Question } from '@/types'

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const subjectId = route.params.subjectId as string
const focusId = (route.query.focus as string) || ''
const questions = ref<Question[]>([])
const loading = ref(true)
const subjectName = ref('')

async function load() {
  loading.value = true
  const [qs, sub] = await Promise.all([
    questionsRepo.listBySubject(subjectId),
    subjectsStore.load(),
  ])
  questions.value = qs
  subjectName.value = subjectsStore.list.find((s) => s.id === subjectId)?.name || ''
  loading.value = false
}

async function removeQuestion(id: string) {
  await showConfirmDialog({ title: '删除题目', message: '确定删除这道题？' })
  await questionsRepo.remove(id)
  showSuccessToast('已删除')
  await load()
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <div>
          <h1 class="page-title page-title--sm">{{ subjectName || '题目列表' }}</h1>
          <p class="page-sub">{{ questions.length }} 道题</p>
        </div>
      </div>
      <button class="fab" @click="router.push({ name: 'import', query: { subjectId } })">
        <van-icon name="add-o" size="18" />
      </button>
    </div>

    <div v-if="loading" style="padding: var(--sp-8); text-align: center">
      <van-loading size="24" />
    </div>

    <div v-else-if="questions.length === 0" class="empty">
      <van-icon name="notes-o" size="40" color="var(--text-3)" />
      <p class="empty__title">还没有题目</p>
      <p class="empty__desc">点击右上角导入 Word 题库</p>
    </div>

    <!-- 题量大时用虚拟滚动；少量时直接渲染 -->
    <div v-else-if="questions.length <= 30">
      <van-swipe-cell v-for="(q, i) in questions" :key="q.id">
        <QuestionCard :question="q" :index="i" :show-answer="true" :highlight="focusId === q.id" />
        <template #right>
          <van-button square type="danger" text="删除" style="height: 100%" @click="removeQuestion(q.id)" />
        </template>
      </van-swipe-cell>
    </div>

    <DynamicScroller
      v-else
      :items="questions"
      :min-item-size="160"
      key-field="id"
      style="height: calc(100vh - 130px)"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem :item="item" :active="active" :data-index="index">
          <van-swipe-cell>
            <QuestionCard :question="item" :index="index" :show-answer="true" :highlight="focusId === item.id" />
            <template #right>
              <van-button square type="danger" text="删除" style="height: 100%" @click="removeQuestion(item.id)" />
            </template>
          </van-swipe-cell>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>
  </div>
</template>

<style scoped>
.page-head--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.fab {
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  border: none;
  background: var(--brand);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-brand);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-8) var(--sp-4);
  text-align: center;
  gap: var(--sp-2);
}
.empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin: var(--sp-3) 0 0;
}
.empty__desc {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
}
</style>
