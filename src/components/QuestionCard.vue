<script setup lang="ts">
import { computed } from 'vue'
import RichText from './RichText.vue'
import AttachmentImage from './AttachmentImage.vue'
import {
  QUESTION_TYPE_LABELS,
  DIFFICULTY_LABELS,
  type Question,
} from '@/types'

const props = defineProps<{
  question: Question
  index?: number
  /** 是否显示答案与解析 */
  showAnswer?: boolean
}>()

const typeLabel = computed(() => QUESTION_TYPE_LABELS[props.question.type])
const diffLabel = computed(() => DIFFICULTY_LABELS[props.question.difficulty])
const diffColor = computed(
  () =>
    ({ easy: '#07c160', medium: '#ff976a', hard: '#ee0a24' })[
      props.question.difficulty
    ] || '#969799',
)

const answerText = computed(() => {
  const a = props.question.answer
  if (Array.isArray(a)) return a.join('、')
  return a
})
</script>

<template>
  <div class="q-card">
    <div class="q-card__meta">
      <van-tag plain>{{ typeLabel }}</van-tag>
      <van-tag plain :color="diffColor">{{ diffLabel }}</van-tag>
      <span v-if="index !== undefined" class="q-card__index">第 {{ index + 1 }} 题</span>
    </div>

    <RichText :text="question.stem" class="q-card__stem" />

    <!-- 选项 -->
    <div v-if="question.options && question.options.length" class="q-card__options">
      <div v-for="(opt, i) in question.options" :key="i" class="q-card__option">
        <span class="q-card__option-key">{{ String.fromCharCode(65 + i) }}.</span>
        <RichText :text="opt" />
      </div>
    </div>

    <!-- 附件图片 -->
    <template v-if="question.attachments && question.attachments.length">
      <AttachmentImage
        v-for="h in question.attachments"
        :key="h"
        :hash="h"
      />
    </template>

    <!-- 答案与解析 -->
    <div v-if="showAnswer" class="q-card__answer">
      <div class="q-card__answer-row">
        <van-tag type="success">参考答案</van-tag>
        <span class="q-card__answer-text">{{ answerText }}</span>
      </div>
      <div v-if="question.analysis" class="q-card__analysis">
        <div class="q-card__analysis-title">解析</div>
        <RichText :text="question.analysis" />
      </div>
    </div>
  </div>
</template>

<style scoped>
.q-card {
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5);
  margin-bottom: var(--sp-3);
  box-shadow: var(--shadow-sm);
}
.q-card__meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.q-card__index {
  margin-left: auto;
  font-size: 12px;
  color: var(--text-3);
}
.q-card__stem {
  font-size: 15px;
  margin-bottom: var(--sp-2);
}
.q-card__options {
  margin-top: var(--sp-2);
}
.q-card__option {
  display: flex;
  gap: 6px;
  padding: var(--sp-2) 0;
  font-size: 14px;
  color: var(--text-2);
}
.q-card__option-key {
  flex-shrink: 0;
  font-weight: 600;
}
.q-card__answer {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--border-strong);
}
.q-card__answer-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.q-card__answer-text {
  font-weight: 600;
  color: var(--success);
}
.q-card__analysis {
  margin-top: var(--sp-3);
}
.q-card__analysis-title {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 4px;
}
</style>
