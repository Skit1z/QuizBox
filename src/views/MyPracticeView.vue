<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import { showConfirmDialog, showSuccessToast } from 'vant'
import { examSessionsRepo } from '@/db/examSessions'
import { useSubjectsStore } from '@/stores/subjects'
import type { ExamSession } from '@/types'

defineOptions({ name: 'MyPracticeView' })

const router = useRouter()
const subjectsStore = useSubjectsStore()

const sessions = ref<ExamSession[]>([])
const loading = ref(true)

const subjectNameMap = computed(() => new Map(subjectsStore.list.map((s) => [s.id, s.name])))

function fmtTime(ts: number) {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

function subjectName(session: ExamSession) {
  return subjectNameMap.value.get(session.config.subjectId) || '未命名科目'
}

function answeredCount(session: ExamSession) {
  return Object.values(session.answers).filter((ans) => {
    if (Array.isArray(ans)) return ans.length > 0
    return String(ans || '').trim().length > 0
  }).length
}

async function load() {
  loading.value = true
  await subjectsStore.load()
  sessions.value = await examSessionsRepo.listInProgressPractice()
  loading.value = false
}

function resume(session: ExamSession) {
  router.push({ name: 'practice', query: { sessionId: session.id } })
}

async function abandon(session: ExamSession) {
  await showConfirmDialog({
    title: '放弃自测',
    message: '确定移除这次未完成自测？已保存的答案不会再显示在“我的自测”中。',
  })
  await examSessionsRepo.abandon(session.id)
  showSuccessToast('已移除')
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
          <h1 class="page-title page-title--sm">我的自测</h1>
          <p class="page-sub">{{ sessions.length }} 个未完成</p>
        </div>
      </div>
      <button class="fab" @click="router.push({ name: 'practice' })">
        <van-icon name="plus" size="18" />
      </button>
    </div>

    <div v-if="loading" class="loading">
      <van-loading size="24" />
    </div>

    <div v-else-if="sessions.length === 0" class="empty">
      <van-icon name="clock-o" size="40" color="var(--text-3)" />
      <p class="empty__title">没有未完成自测</p>
      <p class="empty__desc">开始自测后退出，会自动保存到这里</p>
      <van-button type="primary" size="small" round @click="router.push({ name: 'practice' })">
        开始自测
      </van-button>
    </div>

    <div v-else class="session-list">
      <div v-for="session in sessions" :key="session.id" class="session-card card">
        <div class="session-card__main" @click="resume(session)">
          <div class="session-card__title">{{ subjectName(session) }}</div>
          <div class="session-card__meta">
            {{ answeredCount(session) }} / {{ session.questionIds.length }} 已作答
            <span class="session-card__dot"></span>
            {{ fmtTime(session.startTime) }}
          </div>
        </div>
        <div class="session-card__actions">
          <van-button size="small" type="primary" plain round @click="resume(session)"
            >继续</van-button
          >
          <van-button size="small" plain round @click="abandon(session)">移除</van-button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.page-head--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-4);
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
.loading {
  padding: var(--sp-8);
  text-align: center;
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
  margin: 0 0 var(--sp-4);
}
.session-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.session-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
}
.session-card__main {
  flex: 1;
  min-width: 0;
  cursor: pointer;
}
.session-card__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.session-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.session-card__dot {
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--text-3);
}
.session-card__actions {
  display: flex;
  gap: var(--sp-2);
  flex-shrink: 0;
}
</style>
