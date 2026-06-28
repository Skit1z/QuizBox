<script setup lang="ts">
import { ref, onMounted, watch } from 'vue'
import { useRouter } from 'vue-router'
defineOptions({ name: 'WrongBookView' })
import { showConfirmDialog, showSuccessToast } from 'vant'
import { db } from '@/db'
import { wrongBookRepo } from '@/db/wrongbook'
import { useSubjectsStore } from '@/stores/subjects'
import { QUESTION_TYPE_LABELS, type WrongItem, type Question } from '@/types'

const router = useRouter()
const subjectsStore = useSubjectsStore()

const items = ref<(WrongItem & { question?: Question })[]>([])
const filter = ref<'pending' | 'all'>('pending')

async function load() {
  // pending：仅到期需复习；all：所有未掌握（含未到期）
  const wrongs = filter.value === 'pending' ? await wrongBookRepo.listPending() : await wrongBookRepo.listAll()
  const questions = await db.questions.bulkGet(wrongs.map((w) => w.questionId))
  items.value = wrongs.map((w, i) => ({ ...w, question: questions[i] as Question }))
}

watch(filter, load)

function review(item: WrongItem & { question?: Question }) {
  if (!item.question) return
  // 把具体错题 id 传给自测页，针对性复习
  router.push({
    name: 'practice',
    query: { questionIds: item.questionId },
  })
}

function reviewAll() {
  // 复习当前全部待复习错题
  const ids = items.value.map((i) => i.questionId).filter(Boolean)
  if (!ids.length) return
  router.push({ name: 'practice', query: { questionIds: ids.join(',') } })
}

async function markMastered(id: string) {
  await wrongBookRepo.setStatus(id, 'mastered')
  showSuccessToast('已标记掌握')
  await load()
}

async function clearAll() {
  await showConfirmDialog({ title: '清空', message: '确定把所有错题标记为已掌握？' })
  await wrongBookRepo.markAllMastered()
  showSuccessToast('已清空')
  await load()
}

onMounted(async () => {
  await subjectsStore.load()
  await load()
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">错题本</h1>
    </div>

    <div class="filter-tabs">
      <button
        :class="['filter-tab', filter === 'pending' && 'filter-tab--active']"
        @click="filter = 'pending'"
      >待复习</button>
      <button
        :class="['filter-tab', filter === 'all' && 'filter-tab--active']"
        @click="filter = 'all'"
      >全部</button>
    </div>

    <div v-if="items.length === 0" class="empty">
      <van-icon name="warning-o" size="40" color="var(--text-3)" />
      <p class="empty__title">还没有错题</p>
      <p class="empty__desc">做错的题会自动收录到这里</p>
    </div>

    <div v-else>
      <van-button
        type="primary"
        block
        round
        plain
        icon="refresh"
        style="margin-bottom: var(--sp-4)"
        @click="reviewAll"
      >
        一键复习全部（{{ items.length }}）
      </van-button>

      <div class="wrong-list">
        <div v-for="item in items" :key="item.id" class="wrong-card card">
          <div class="wrong-card__meta">
            <span class="chip chip--danger">待复习</span>
            <van-tag v-if="item.question" plain>
              {{ QUESTION_TYPE_LABELS[item.question.type] }}
            </van-tag>
            <span class="wrong-card__reason">{{ item.reason || '' }}</span>
            <span class="wrong-card__count">复习 {{ item.reviewCount }} 次</span>
          </div>
          <div class="wrong-card__stem">
            {{ item.question?.stem?.slice(0, 60) || '(题目已删除)' }}
          </div>
          <div class="wrong-card__actions">
            <van-button size="small" type="primary" plain round @click="review(item)">复习</van-button>
            <van-button size="small" type="success" plain round @click="markMastered(item.id)">已掌握</van-button>
          </div>
        </div>
      </div>

      <van-button
        v-if="items.length"
        block
        plain
        size="small"
        style="margin-top: var(--sp-4); color: var(--text-3)"
        @click="clearAll"
      >
        全部标记已掌握
      </van-button>
    </div>
  </div>
</template>

<style scoped>
.filter-tabs {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-4);
}
.filter-tab {
  padding: 6px var(--sp-4);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
  border-radius: var(--r-full);
  cursor: pointer;
  transition: all 0.15s;
}
.filter-tab--active {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
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
.wrong-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.wrong-card {
  padding: var(--sp-4) var(--sp-5);
}
.wrong-card__meta {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
  font-size: 12px;
  color: var(--text-3);
  margin-bottom: var(--sp-2);
}
.chip--danger {
  background: rgba(245, 63, 63, 0.1);
  color: var(--danger);
}
.wrong-card__reason {
  color: var(--danger);
}
.wrong-card__count {
  margin-left: auto;
}
.wrong-card__stem {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
  margin-bottom: var(--sp-3);
}
.wrong-card__actions {
  display: flex;
  gap: var(--sp-2);
}
</style>
