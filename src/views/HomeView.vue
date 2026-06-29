<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
defineOptions({ name: 'HomeView' })
import { useRouter } from 'vue-router'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'

const router = useRouter()
const subjectsStore = useSubjectsStore()

const stats = ref({ subjects: 0, questions: 0, wrong: 0 })
const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了，注意休息'
  if (h < 12) return '早上好，开始学习'
  if (h < 14) return '中午好，小憩一下'
  if (h < 18) return '下午好，继续刷题'
  return '晚上好，温故知新'
})

const features = [
  { title: '自测模式', desc: '即时反馈', icon: 'edit', route: 'practice' },
  { title: '我的自测', desc: '继续未完成', icon: 'clock-o', route: 'my-practice' },
  { title: '考试模式', desc: '限时交卷', icon: 'certificate', route: 'exam' },
  { title: '错题本', desc: '间隔复习', icon: 'warning-o', route: 'wrong' },
  { title: '导入题库', desc: 'AI 解析', icon: 'add-square', route: 'import' },
]

async function loadStats() {
  await subjectsStore.load()
  const [w, totalQ] = await Promise.all([
    wrongBookRepo.listAll(),
    questionsRepo.countAll(),
  ])
  stats.value = {
    subjects: subjectsStore.list.length,
    questions: totalQ,
    wrong: w.length,
  }
}

onMounted(loadStats)
</script>

<template>
  <div class="page">
    <!-- 头部问候 -->
    <div class="page-head">
      <img class="home-icon" src="/favicon.svg" alt="题盒图标" />
      <p class="page-sub">{{ greeting }}</p>
      <h1 class="page-title">题盒</h1>
    </div>

    <!-- 数据概览 -->
    <div class="stat-row">
      <div class="stat">
        <div class="stat__num">{{ stats.subjects }}</div>
        <div class="stat__label">科目</div>
      </div>
      <div class="stat__sep"></div>
      <div class="stat">
        <div class="stat__num">{{ stats.questions }}</div>
        <div class="stat__label">题目</div>
      </div>
      <div class="stat__sep"></div>
      <div class="stat">
        <div class="stat__num" :class="{ 'stat__num--accent': stats.wrong > 0 }">{{ stats.wrong }}</div>
        <div class="stat__label">待复习</div>
      </div>
    </div>

    <!-- 功能入口 -->
    <div class="section-title">开始学习</div>
    <div class="feature-grid">
      <div
        v-for="f in features"
        :key="f.route"
        class="feature card card--clickable"
        @click="router.push({ name: f.route })"
      >
        <div class="feature__icon">
          <van-icon :name="f.icon" size="22" />
        </div>
        <div class="feature__body">
          <div class="feature__title">{{ f.title }}</div>
          <div class="feature__desc">{{ f.desc }}</div>
        </div>
        <van-icon name="arrow" size="14" color="var(--text-3)" />
      </div>
    </div>

    <!-- 快捷：搜索 -->
    <div class="section-title">快速查找</div>
    <div class="card card--clickable search-card" @click="router.push({ name: 'search' })">
      <van-icon name="search" size="18" color="var(--text-3)" />
      <span class="search-card__hint">搜索题干、选项、解析…</span>
    </div>
  </div>
</template>

<style scoped>
.page-head {
  position: relative;
  min-height: 56px;
  padding-left: 68px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.home-icon {
  position: absolute;
  left: 0;
  top: 50%;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  transform: translateY(-50%);
  box-shadow: var(--shadow-brand);
}
.stat-row {
  display: flex;
  align-items: center;
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5) var(--sp-4);
  box-shadow: var(--shadow-sm);
}
.stat {
  flex: 1;
  text-align: center;
}
.stat__num {
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
  line-height: 1;
}
.stat__num--accent {
  color: var(--danger);
}
.stat__label {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 6px;
}
.stat__sep {
  width: 1px;
  height: 32px;
  background: var(--border-strong);
}

.feature-grid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.feature {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
}
.feature__icon {
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.feature__body {
  flex: 1;
}
.feature__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.feature__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.search-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-4) var(--sp-5);
}
.search-card__hint {
  color: var(--text-3);
  font-size: 14px;
}
</style>
