<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { examSessionsRepo } from '@/db/examSessions'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import ExamResult from '@/components/ExamResult.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import type { ExamSession, QuestionType } from '@/types'
import type { Question } from '@/types'
import { QUESTION_TYPE_LABELS } from '@/types'

const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const finished = ref(false)
const questions = ref<Question[]>([])
const result = ref<any>(null)
const restoredSession = ref<ExamSession | null>(null)

const subjectId = ref('')
const selectedTypes = ref<QuestionType[]>([])
const count = ref(20)
const durationMin = ref(30)

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

function toggleType(type: QuestionType) {
  const index = selectedTypes.value.indexOf(type)
  if (index > -1) {
    selectedTypes.value.splice(index, 1)
  } else {
    selectedTypes.value.push(type)
  }
}

async function start() {
  if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  }
  let base = await questionsRepo.filter({ subjectId: subjectId.value })
  if (selectedTypes.value.length > 0) {
    base = base.filter((q) => selectedTypes.value.includes(q.type))
  }

  if (base.length === 0) {
    showFailToast('没有符合条件的题目')
    return
  }

  const qs = shuffle(base).slice(0, count.value)
  questions.value = qs
  restoredSession.value = null
  started.value = true
}

function onFinish(r: any) {
  result.value = r
  finished.value = true
  started.value = false
}

onMounted(async () => {
  await subjectsStore.load()
  if (subjectsStore.list.length === 1) subjectId.value = subjectsStore.list[0].id
  const inProgress = await examSessionsRepo.findInProgressExam()
  if (!inProgress) return
  const rows = await questionsRepo.findByIds(inProgress.questionIds)
  if (rows.length === 0) {
    await examSessionsRepo.abandon(inProgress.id)
    return
  }
  const byId = new Map(rows.map((q) => [q.id, q]))
  questions.value = inProgress.questionIds
    .map((id) => byId.get(id))
    .filter((q): q is Question => !!q)
  subjectId.value = inProgress.config.subjectId
  if (inProgress.config.questionTypes) {
    selectedTypes.value = inProgress.config.questionTypes
  } else {
    selectedTypes.value = []
  }
  count.value = inProgress.config.count
  durationMin.value = inProgress.config.durationMin || durationMin.value
  restoredSession.value = inProgress
  started.value = true
})
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">考试模式</h1>
      </div>
    </div>

    <ExamResult
      v-if="finished && result"
      :result="result"
      :questions="questions"
      @restart="finished = false"
      @back="router.push({ name: 'home' })"
    />

    <QuizRunner
      v-else-if="started"
      mode="exam"
      :classic="true"
      :duration-min="durationMin"
      :questions="questions"
      :initial-session="restoredSession || undefined"
      exam-sub-mode="classic"
      :question-types="selectedTypes"
      @finish="onFinish"
    />

    <div v-else class="setup-body">
      <div class="card setup-card">
        <!-- 科目 -->
        <div class="form-item">
          <div class="form-item__header">
            <van-icon name="bookmark-o" class="form-item__icon" />
            <span class="form-item__title">考试科目</span>
          </div>
          <ThemedSelect v-model="subjectId" :options="subjectOptions" placeholder="选择科目" />
        </div>

        <!-- 题型 -->
        <div class="form-item">
          <div class="form-item__header">
            <van-icon name="filter-o" class="form-item__icon" />
            <span class="form-item__title">考试题型（不选默认全部）</span>
          </div>
          <div class="type-chips">
            <button
              v-for="(label, value) in QUESTION_TYPE_LABELS"
              :key="value"
              type="button"
              class="chip-btn"
              :class="{ 'chip-btn--active': selectedTypes.includes(value) }"
              @click="toggleType(value)"
            >
              {{ label }}
            </button>
          </div>
        </div>

        <!-- 题量与时长 -->
        <div class="form-item-grid">
          <div class="form-item">
            <div class="form-item__header">
              <van-icon name="records-o" class="form-item__icon" />
              <span class="form-item__title">考试题量</span>
            </div>
            <div class="num-input">
              <button type="button" class="num-input__btn" :disabled="count <= 1" @click="count = Math.max(1, count - 1)">−</button>
              <input
                v-model.number="count"
                type="number"
                inputmode="numeric"
                class="num-input__field"
                :min="1"
                :max="999"
                @blur="count = Math.max(1, Math.min(999, Math.floor(Number(count)) || 1))"
              />
              <button type="button" class="num-input__btn" :disabled="count >= 999" @click="count = Math.min(999, count + 1)">+</button>
            </div>
          </div>

          <div class="form-item">
            <div class="form-item__header">
              <van-icon name="clock-o" class="form-item__icon" />
              <span class="form-item__title">考试时长（分钟）</span>
            </div>
            <div class="num-input">
              <button type="button" class="num-input__btn" :disabled="durationMin <= 1" @click="durationMin = Math.max(1, durationMin - 5)">−</button>
              <input
                v-model.number="durationMin"
                type="number"
                inputmode="numeric"
                class="num-input__field"
                :min="1"
                :max="600"
                @blur="durationMin = Math.max(1, Math.min(600, Math.floor(Number(durationMin)) || 1))"
              />
              <button type="button" class="num-input__btn" :disabled="durationMin >= 600" @click="durationMin = Math.min(600, durationMin + 5)">+</button>
            </div>
          </div>
        </div>
      </div>

      <button type="button" class="btn-start" @click="start">开始考试</button>
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

.setup-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  max-width: var(--content-max);
  margin: 0 auto;
}

.setup-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-5);
  padding: var(--sp-5) var(--sp-6);
}

.form-item {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.form-item__header {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-1);
}
.form-item__icon {
  color: var(--brand);
  font-size: 16px;
}
.form-item__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.form-item-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}
@media (max-width: 576px) {
  .form-item-grid {
    grid-template-columns: 1fr;
    gap: var(--sp-4);
  }
}

.type-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.chip-btn {
  padding: 8px 16px;
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s cubic-bezier(0.4, 0, 0.2, 1);
}
.chip-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.chip-btn--active {
  background: var(--brand);
  border-color: var(--brand);
  color: #ffffff !important;
  box-shadow: var(--shadow-brand);
}

.num-input {
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface-2);
  width: fit-content;
}
.num-input__btn {
  width: 38px;
  height: 38px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 20px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
  flex-shrink: 0;
}
.num-input__btn:hover:not(:disabled) {
  background: var(--surface);
  color: var(--brand);
}
.num-input__btn:disabled {
  opacity: 0.3;
  cursor: not-allowed;
}
.num-input__field {
  width: 64px;
  height: 38px;
  border: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: transparent;
  text-align: center;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  outline: none;
  -moz-appearance: textfield;
}
.num-input__field::-webkit-outer-spin-button,
.num-input__field::-webkit-inner-spin-button {
  -webkit-appearance: none;
  margin: 0;
}

.btn-start {
  width: 100%;
  height: 46px;
  border: none;
  border-radius: var(--r-full);
  background: linear-gradient(135deg, var(--brand) 0%, rgb(99, 102, 241) 100%);
  color: #ffffff;
  font-size: 15px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: var(--shadow-brand);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  display: flex;
  align-items: center;
  justify-content: center;
}
.btn-start:hover {
  transform: translateY(-1.5px);
  box-shadow: 0 10px 24px rgba(var(--brand-rgb), 0.25);
}
.btn-start:active {
  transform: translateY(0);
}
</style>
