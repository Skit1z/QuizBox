<script setup lang="ts">
import { computed } from 'vue'
import { QUESTION_TYPE_LABELS, type Question } from '@/types'

const props = defineProps<{
  result: {
    total: number
    correct: number
    answered: number
    durationMs: number
    detail: { questionId: string; correct: boolean | null; answered: boolean }[]
  }
  questions: Question[]
}>()

const emit = defineEmits<{ restart: []; back: [] }>()

const accuracy = computed(() => {
  const graded = props.result.detail.filter((d) => d.correct !== null)
  if (!graded.length) return null
  return Math.round((graded.filter((d) => d.correct).length / graded.length) * 100)
})

const durationText = computed(() => {
  const sec = Math.round(props.result.durationMs / 1000)
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}分${s}秒`
})

const wrongCount = computed(() => props.result.detail.filter((d) => d.correct === false).length)

const qMap = computed(() => {
  const m = new Map<string, Question>()
  for (const q of props.questions) m.set(q.id, q)
  return m
})

const wrongQuestions = computed(() =>
  props.result.detail
    .filter((d) => d.correct === false)
    .map((d) => qMap.value.get(d.questionId))
    .filter((q): q is Question => !!q),
)
</script>

<template>
  <div class="result">
    <div class="result__hero">
      <div class="result__emoji">{{ accuracy !== null && accuracy >= 60 ? '🎉' : '💪' }}</div>
      <h2 class="result__title">考试完成</h2>
    </div>

    <!-- 成绩环 -->
    <div class="score-ring">
      <div v-if="accuracy !== null" class="score-num">{{ accuracy }}<span>分</span></div>
      <div v-else class="score-num">--<span></span></div>
      <div class="score-label">{{ accuracy !== null ? '正确率' : '主观题为主' }}</div>
    </div>

    <!-- 统计 -->
    <div class="stat-grid">
      <div class="stat-item">
        <div class="stat-item__num">{{ result.total }}</div>
        <div class="stat-item__label">总题数</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__num stat-item__num--success">{{ result.correct }}</div>
        <div class="stat-item__label">答对</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__num stat-item__num--danger">{{ wrongCount }}</div>
        <div class="stat-item__label">答错</div>
      </div>
      <div class="stat-item">
        <div class="stat-item__num">{{ durationText }}</div>
        <div class="stat-item__label">用时</div>
      </div>
    </div>

    <!-- 错题回顾 -->
    <div v-if="wrongQuestions.length">
      <div class="section-title">错题回顾 · {{ wrongQuestions.length }}</div>
      <div class="wrong-list">
        <div v-for="(q, i) in wrongQuestions" :key="q.id" class="wrong-item card">
          <div class="wrong-item__head">
            <span class="chip chip--danger">错</span>
            <van-tag plain>{{ QUESTION_TYPE_LABELS[q.type] }}</van-tag>
            <span class="wrong-item__idx">第 {{ i + 1 }} 题</span>
          </div>
          <div class="wrong-item__stem">{{ q.stem.slice(0, 80) }}</div>
        </div>
      </div>
    </div>

    <div class="result__actions">
      <van-button block round @click="emit('back')">返回首页</van-button>
      <van-button block round type="primary" plain @click="emit('restart')">再来一次</van-button>
    </div>
  </div>
</template>

<style scoped>
.result {
  padding: var(--sp-5) var(--sp-4);
}
.result__hero {
  text-align: center;
  margin-bottom: var(--sp-5);
}
.result__emoji {
  font-size: 40px;
  line-height: 1;
}
.result__title {
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
  margin: var(--sp-3) 0 0;
}

.score-ring {
  width: 132px;
  height: 132px;
  border-radius: 50%;
  background: linear-gradient(135deg, var(--brand), rgba(var(--brand-rgb), 0.75));
  margin: 0 auto var(--sp-6);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
  box-shadow: var(--shadow-brand);
}
.score-num {
  font-size: 40px;
  font-weight: 700;
  line-height: 1;
  letter-spacing: -0.03em;
}
.score-num span {
  font-size: 14px;
  margin-left: 2px;
  font-weight: 500;
}
.score-label {
  font-size: 12px;
  opacity: 0.9;
  margin-top: 4px;
}

.stat-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-2);
  margin-bottom: var(--sp-5);
}
.stat-item {
  text-align: center;
  background: var(--surface);
  border-radius: var(--r-md);
  padding: var(--sp-3) var(--sp-2);
  box-shadow: var(--shadow-sm);
}
.stat-item__num {
  font-size: 18px;
  font-weight: 700;
  color: var(--text);
  line-height: 1.2;
}
.stat-item__num--success {
  color: var(--success);
}
.stat-item__num--danger {
  color: var(--danger);
}
.stat-item__label {
  font-size: 11px;
  color: var(--text-3);
  margin-top: 4px;
}

.wrong-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.wrong-item {
  padding: var(--sp-4) var(--sp-5);
}
.wrong-item__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.chip--danger {
  background: rgba(245, 63, 63, 0.1);
  color: var(--danger);
}
.wrong-item__idx {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
}
.wrong-item__stem {
  font-size: 14px;
  line-height: 1.6;
  color: var(--text);
}

.result__actions {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-6);
}
</style>
