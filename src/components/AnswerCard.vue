<script setup lang="ts">
import { computed } from 'vue'

defineOptions({ name: 'AnswerCard' })

const props = defineProps<{
  /** 总题数 */
  total: number
  /** 当前题索引（0-based） */
  current: number
  /** 各题作答状态：key 为题索引（0-based），true=已答 */
  answered: Record<number, boolean>
  /** 各题对错（仅即时反馈模式有值）：true=对，false=错 */
  correctness?: Record<number, boolean>
  /** 是否展示对错色（练习/即时反馈模式） */
  showCorrectness?: boolean
}>()

const emit = defineEmits<{
  (e: 'jump', index: number): void
}>()

const cells = computed(() =>
  Array.from({ length: props.total }, (_, i) => {
    const isCurrent = i === props.current
    const isAnswered = !!props.answered[i]
    const correct = props.showCorrectness ? props.correctness?.[i] : undefined
    return { index: i, num: i + 1, isCurrent, isAnswered, correct }
  }),
)

const answeredCount = computed(() => cells.value.filter((c) => c.isAnswered).length)
</script>

<template>
  <div class="answer-card">
    <div class="answer-card__head">
      <span class="answer-card__title">答题卡</span>
      <span class="answer-card__meta">已答 {{ answeredCount }} / {{ total }}</span>
    </div>

    <div class="answer-card__grid">
      <button
        v-for="cell in cells"
        :key="cell.index"
        type="button"
        :class="[
          'ac-cell',
          cell.isCurrent && 'ac-cell--current',
          !cell.isCurrent &&
            cell.isAnswered &&
            (cell.correct === undefined || !showCorrectness) &&
            'ac-cell--answered',
          showCorrectness && cell.correct === true && 'ac-cell--correct',
          showCorrectness && cell.correct === false && 'ac-cell--wrong',
        ]"
        @click="emit('jump', cell.index)"
      >
        {{ cell.num }}
      </button>
    </div>

    <!-- 图例 -->
    <div class="answer-card__legend">
      <span class="legend-item"><i class="legend-dot legend-dot--current"></i>当前</span>
      <span class="legend-item"><i class="legend-dot legend-dot--answered"></i>已答</span>
      <span v-if="showCorrectness" class="legend-item"
        ><i class="legend-dot legend-dot--correct"></i>正确</span
      >
      <span v-if="showCorrectness" class="legend-item"
        ><i class="legend-dot legend-dot--wrong"></i>错误</span
      >
      <span class="legend-item"><i class="legend-dot legend-dot--unanswered"></i>未答</span>
    </div>
  </div>
</template>

<style scoped>
.answer-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.answer-card__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
}
.answer-card__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.answer-card__meta {
  font-size: 12px;
  color: var(--text-3);
}
.answer-card__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, 30px);
  justify-content: space-between;
  gap: 8px 6px;
}
.ac-cell {
  width: 30px;
  height: 30px;
  border: 1.5px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--surface);
  color: var(--text-2);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s;
  display: flex;
  align-items: center;
  justify-content: center;
}
.ac-cell:hover {
  border-color: var(--brand);
}
.ac-cell--current {
  border-color: var(--brand);
  background: var(--brand);
  color: #fff;
  box-shadow: var(--shadow-brand);
}
.ac-cell--answered {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
}
.ac-cell--correct {
  border-color: var(--success);
  background: rgba(0, 180, 42, 0.1);
  color: var(--success);
}
.ac-cell--wrong {
  border-color: var(--danger);
  background: rgba(245, 63, 63, 0.1);
  color: var(--danger);
}
.answer-card__legend {
  display: flex;
  flex-wrap: wrap;
  gap: 6px var(--sp-2);
  font-size: 10px;
  color: var(--text-3);
}
.legend-item {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.legend-dot {
  width: 9px;
  height: 9px;
  border-radius: 3px;
  border: 1.5px solid var(--border);
  background: var(--surface);
  display: inline-block;
}
.legend-dot--current {
  border-color: var(--brand);
  background: var(--brand);
}
.legend-dot--answered {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.legend-dot--correct {
  border-color: var(--success);
  background: rgba(0, 180, 42, 0.1);
}
.legend-dot--wrong {
  border-color: var(--danger);
  background: rgba(245, 63, 63, 0.1);
}
.legend-dot--unanswered {
  border-color: var(--border);
  background: var(--surface);
}
</style>
