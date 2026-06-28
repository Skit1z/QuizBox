<script setup lang="ts">
import { computed } from 'vue'
import { isObjective, QUESTION_TYPE_LABELS, type Question } from '@/types'

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
  <div style="padding: 16px">
    <h2 class="page-title" style="text-align: center">考试完成</h2>

    <div class="score-ring">
      <div v-if="accuracy !== null" class="score-num">{{ accuracy }}<span>分</span></div>
      <div v-else class="score-num">--<span>主观题</span></div>
      <div class="score-label">正确率</div>
    </div>

    <van-grid :column-num="3" :gutter="8" style="margin: 16px 0">
      <van-grid-item icon="notes-o" :text="`${result.total} 题`" />
      <van-grid-item icon="success" :text="`${result.correct} 对`" />
      <van-grid-item icon="cross" :text="`${result.answered - result.correct} 错`" />
      <van-grid-item icon="clock-o" :text="durationText" />
      <van-grid-item icon="edit" :text="`${result.answered} 作答`" />
      <van-grid-item icon="warning-o" :text="`${wrongQuestions.length} 错题`" />
    </van-grid>

    <div v-if="wrongQuestions.length" style="margin-top: 12px">
      <div class="section-title">错题回顾（{{ wrongQuestions.length }}）</div>
      <div
        v-for="(q, i) in wrongQuestions"
        :key="q.id"
        class="wrong-item"
      >
        <div class="wrong-item__head">
          <van-tag type="danger" plain>错</van-tag>
          <van-tag plain>{{ QUESTION_TYPE_LABELS[q.type] }}</van-tag>
          <span class="wrong-item__idx">第 {{ i + 1 }} 题</span>
        </div>
        <div class="wrong-item__stem">{{ q.stem.slice(0, 80) }}</div>
      </div>
    </div>

    <div style="display: flex; gap: 12px; margin-top: 24px">
      <van-button block @click="emit('back')">返回首页</van-button>
      <van-button block type="primary" plain @click="emit('restart')">再来一次</van-button>
    </div>
  </div>
</template>

<style scoped>
.score-ring {
  width: 140px;
  height: 140px;
  border-radius: 50%;
  background: linear-gradient(135deg, #1989fa, #07c160);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  color: #fff;
}
.score-num {
  font-size: 40px;
  font-weight: 700;
  line-height: 1;
}
.score-num span {
  font-size: 14px;
  margin-left: 2px;
}
.score-label {
  font-size: 13px;
  opacity: 0.9;
  margin-top: 4px;
}
.section-title {
  font-size: 15px;
  font-weight: 600;
  margin-bottom: 10px;
}
.wrong-item {
  background: #fff;
  border-radius: 8px;
  padding: 12px;
  margin-bottom: 8px;
}
.wrong-item__head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
}
.wrong-item__idx {
  margin-left: auto;
  font-size: 12px;
  color: #969799;
}
.wrong-item__stem {
  font-size: 14px;
  line-height: 1.6;
  color: #323233;
}
</style>
