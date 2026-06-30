<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
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
const subjectQuestions = ref<Question[]>([])
const typeQuotas = ref<Partial<Record<QuestionType, number>>>({})
const durationMin = ref(30)
const DEFAULT_EXAM_COUNT = 20

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

const typeStats = computed(() => {
  const counts = new Map<QuestionType, number>()
  for (const q of subjectQuestions.value) {
    counts.set(q.type, (counts.get(q.type) || 0) + 1)
  }
  return Object.entries(QUESTION_TYPE_LABELS)
    .map(([type, label]) => ({
      type: type as QuestionType,
      label,
      available: counts.get(type as QuestionType) || 0,
    }))
    .filter((item) => item.available > 0)
})

const selectedTypes = computed<QuestionType[]>(() =>
  typeStats.value
    .filter((item) => Number(typeQuotas.value[item.type] || 0) > 0)
    .map((item) => item.type),
)

const totalCount = computed(() =>
  typeStats.value.reduce((sum, item) => sum + Number(typeQuotas.value[item.type] || 0), 0),
)

function buildDefaultQuotas(stats: typeof typeStats.value) {
  const quotas: Partial<Record<QuestionType, number>> = {}
  const totalAvailable = stats.reduce((sum, item) => sum + item.available, 0)
  let remaining = Math.min(DEFAULT_EXAM_COUNT, totalAvailable)
  for (const item of stats) quotas[item.type] = 0
  while (remaining > 0) {
    let changed = false
    for (const item of stats) {
      const current = quotas[item.type] || 0
      if (current >= item.available) continue
      quotas[item.type] = current + 1
      remaining--
      changed = true
      if (remaining <= 0) break
    }
    if (!changed) break
  }
  return quotas
}

async function loadSubjectQuestions(id: string) {
  if (!id) {
    subjectQuestions.value = []
    typeQuotas.value = {}
    return
  }
  subjectQuestions.value = await questionsRepo.filter({ subjectId: id })
  typeQuotas.value = buildDefaultQuotas(typeStats.value)
}

function setTypeQuota(type: QuestionType, value: number) {
  const available = typeStats.value.find((item) => item.type === type)?.available || 0
  const next = Math.max(0, Math.min(available, Math.floor(Number(value)) || 0))
  typeQuotas.value = { ...typeQuotas.value, [type]: next }
}

function adjustTypeQuota(type: QuestionType, delta: number) {
  setTypeQuota(type, Number(typeQuotas.value[type] || 0) + delta)
}

async function start() {
  if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  }
  if (totalCount.value <= 0) {
    showFailToast('请至少设置一种题型的题量')
    return
  }

  const picked: Question[] = []
  for (const item of typeStats.value) {
    const quota = Number(typeQuotas.value[item.type] || 0)
    if (quota <= 0) continue
    const pool = subjectQuestions.value.filter((q) => q.type === item.type)
    picked.push(...shuffle(pool).slice(0, quota))
  }

  if (picked.length === 0) {
    showFailToast('没有符合条件的题目')
    return
  }

  questions.value = shuffle(picked)
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
  durationMin.value = inProgress.config.durationMin || durationMin.value
  restoredSession.value = inProgress
  started.value = true
})

watch(subjectId, (id) => {
  void loadSubjectQuestions(id)
})
</script>

<template>
  <div :class="['page page--wide', started && 'page--running']">
    <div v-if="!started" class="page-head page-head--row">
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
            <span class="form-item__title">题型与题量</span>
          </div>
          <div v-if="!subjectId" class="empty-hint">先选择科目后配置题型。</div>
          <div v-else-if="typeStats.length === 0" class="empty-hint">
            当前科目还没有可抽取的题目。
          </div>
          <div v-else class="type-quota-list">
            <div v-for="item in typeStats" :key="item.type" class="type-quota">
              <div class="type-quota__info">
                <span class="type-quota__label">{{ item.label }}</span>
                <span class="type-quota__count">题库 {{ item.available }} 道</span>
              </div>
              <div class="num-input">
                <button
                  type="button"
                  class="num-input__btn"
                  :disabled="Number(typeQuotas[item.type] || 0) <= 0"
                  @click="adjustTypeQuota(item.type, -1)"
                >
                  −
                </button>
                <input
                  :value="Number(typeQuotas[item.type] || 0)"
                  type="number"
                  inputmode="numeric"
                  class="num-input__field"
                  :min="0"
                  :max="item.available"
                  @input="
                    setTypeQuota(item.type, Number(($event.target as HTMLInputElement).value))
                  "
                  @blur="setTypeQuota(item.type, Number(($event.target as HTMLInputElement).value))"
                />
                <button
                  type="button"
                  class="num-input__btn"
                  :disabled="Number(typeQuotas[item.type] || 0) >= item.available"
                  @click="adjustTypeQuota(item.type, 1)"
                >
                  +
                </button>
              </div>
            </div>
            <div class="type-summary">本次考试共 {{ totalCount }} 道题</div>
          </div>
        </div>

        <!-- 时长 -->
        <div class="form-item-grid">
          <div class="form-item">
            <div class="form-item__header">
              <van-icon name="clock-o" class="form-item__icon" />
              <span class="form-item__title">考试时长（分钟）</span>
            </div>
            <div class="num-input">
              <button
                type="button"
                class="num-input__btn"
                :disabled="durationMin <= 1"
                @click="durationMin = Math.max(1, durationMin - 5)"
              >
                −
              </button>
              <input
                v-model.number="durationMin"
                type="number"
                inputmode="numeric"
                class="num-input__field"
                :min="1"
                :max="600"
                @blur="
                  durationMin = Math.max(1, Math.min(600, Math.floor(Number(durationMin)) || 1))
                "
              />
              <button
                type="button"
                class="num-input__btn"
                :disabled="durationMin >= 600"
                @click="durationMin = Math.min(600, durationMin + 5)"
              >
                +
              </button>
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
.page--running {
  padding: 0;
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

.empty-hint {
  padding: var(--sp-4);
  border-radius: var(--r-md);
  border: 1px solid var(--border);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
}
.type-quota-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.type-quota {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
}
.type-quota__info {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.type-quota__label {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
}
.type-quota__count {
  font-size: 12px;
  color: var(--text-3);
}
.type-summary {
  color: var(--text-2);
  font-size: 13px;
  text-align: right;
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

@media (max-width: 576px) {
  .type-quota {
    align-items: flex-start;
    flex-direction: column;
  }
  .type-summary {
    text-align: left;
  }
}
</style>
