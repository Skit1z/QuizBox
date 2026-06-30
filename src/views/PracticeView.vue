<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { examSessionsRepo } from '@/db/examSessions'
import { attemptsRepo } from '@/db/attempts'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import ExamResult from '@/components/ExamResult.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import { QUESTION_TYPE_LABELS, type ExamSession, type Question, type QuestionType } from '@/types'

defineOptions({ name: 'PracticeView' })

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const finished = ref(false)
const result = ref<any>(null)
const questions = ref<Question[]>([])
const restoredSession = ref<ExamSession | null>(null)
const loadingSession = ref(!!route.query.sessionId)

const subjectId = ref((route.query.subjectId as string) || '')
const subjectQuestions = ref<Question[]>([])
const typeQuotas = ref<Partial<Record<QuestionType, number>>>({})
const attemptedQuestionIds = ref<Set<string>>(new Set())
const wrongQuestionIds = ref<Set<string>>(new Set())
const practiceScope = ref<'all' | 'unseen' | 'done'>('all')
const random = ref(true)
const onlyWrong = ref(false)

const allTypes: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

const scopedQuestions = computed(() =>
  subjectQuestions.value.filter((q) => {
    if (onlyWrong.value && !wrongQuestionIds.value.has(q.id)) return false
    const attempted = attemptedQuestionIds.value.has(q.id)
    if (practiceScope.value === 'done') return attempted
    if (practiceScope.value === 'unseen') return !attempted
    return true
  }),
)

const scopeCounts = computed(() => {
  let done = 0
  let unseen = 0
  for (const q of subjectQuestions.value) {
    if (onlyWrong.value && !wrongQuestionIds.value.has(q.id)) continue
    if (attemptedQuestionIds.value.has(q.id)) done++
    else unseen++
  }
  return { total: done + unseen, done, unseen }
})

const typeStats = computed(() => {
  return allTypes
    .map((type) => {
      const all = subjectQuestions.value.filter((q) => {
        if (q.type !== type) return false
        return !onlyWrong.value || wrongQuestionIds.value.has(q.id)
      })
      const done = all.filter((q) => attemptedQuestionIds.value.has(q.id)).length
      const unseen = all.length - done
      const available =
        practiceScope.value === 'done' ? done : practiceScope.value === 'unseen' ? unseen : all.length
      return { type, label: QUESTION_TYPE_LABELS[type], total: all.length, done, unseen, available }
    })
    .filter((item) => item.total > 0)
})

// 来自错题本的指定题目
const presetQuestionIds = ref<string[]>(
  route.query.questionIds ? (route.query.questionIds as string).split(',').filter(Boolean) : [],
)

function toggleType(t: QuestionType) {
  const current = Number(typeQuotas.value[t] || 0)
  const available = typeStats.value.find((item) => item.type === t)?.available || 0
  typeQuotas.value = { ...typeQuotas.value, [t]: current > 0 ? 0 : available }
}

function setTypeQuota(type: QuestionType, value: number) {
  const available = typeStats.value.find((item) => item.type === type)?.available || 0
  const next = Math.max(0, Math.min(available, Math.floor(Number(value)) || 0))
  typeQuotas.value = { ...typeQuotas.value, [type]: next }
}

function adjustTypeQuota(type: QuestionType, delta: number) {
  setTypeQuota(type, Number(typeQuotas.value[type] || 0) + delta)
}

function resetTypeQuotasToAvailable() {
  const quotas: Partial<Record<QuestionType, number>> = {}
  for (const item of typeStats.value) {
    quotas[item.type] = item.available
  }
  typeQuotas.value = quotas
}

const selectedCount = computed(() =>
  typeStats.value.reduce((sum, item) => sum + Number(typeQuotas.value[item.type] || 0), 0),
)

function applyScope(scope: 'all' | 'unseen' | 'done') {
  practiceScope.value = scope
  resetTypeQuotasToAvailable()
}

async function loadSubjectQuestions(id: string) {
  if (!id || presetQuestionIds.value.length) {
    subjectQuestions.value = []
    typeQuotas.value = {}
    attemptedQuestionIds.value = new Set()
    wrongQuestionIds.value = new Set()
    return
  }
  subjectQuestions.value = await questionsRepo.filter({ subjectId: id })
  attemptedQuestionIds.value = await attemptsRepo.getAttemptedQuestionIds(
    subjectQuestions.value.map((q) => q.id),
  )
  const wrongs = await wrongBookRepo.listAll()
  wrongQuestionIds.value = new Set(wrongs.map((w) => w.questionId))
  resetTypeQuotasToAvailable()
}

async function start() {
  let qs: Question[]
  restoredSession.value = null

  // 清理旧的进行中自测场次：每次开始新练习前，把残留的 in_progress 练习
  // 标记为放弃，避免「我的练习」列表累积废弃场次
  const stale = await examSessionsRepo.listInProgressPractice()
  if (stale.length) {
    await Promise.all(stale.map((s) => examSessionsRepo.abandon(s.id)))
  }

  if (presetQuestionIds.value.length) {
    qs = await questionsRepo.findByIds(presetQuestionIds.value)
  } else if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  } else {
    const picked: Question[] = []
    for (const item of typeStats.value) {
      const quota = Number(typeQuotas.value[item.type] || 0)
      if (quota <= 0) continue
      const pool = scopedQuestions.value.filter((q) => q.type === item.type)
      picked.push(...(random.value ? shuffle(pool) : pool).slice(0, quota))
    }
    qs = picked
  }

  questions.value = random.value ? shuffle(qs) : qs
  if (questions.value.length === 0) {
    showFailToast('没有符合条件的题目')
    return
  }
  finished.value = false
  started.value = true
}

function onFinish(r: any) {
  result.value = r
  finished.value = true
  started.value = false
}

onMounted(async () => {
  await subjectsStore.load()
  try {
    let session: ExamSession | undefined
    const sessionId = route.query.sessionId as string | undefined
    if (sessionId) {
      session = await examSessionsRepo.get(sessionId)
    }

    if (session && session.status === 'in_progress' && session.config.subMode === 'practice') {
      const rows = await questionsRepo.findByIds(session.questionIds)
      const byId = new Map(rows.map((q) => [q.id, q]))
      questions.value = session.questionIds
        .map((id) => byId.get(id))
        .filter((q): q is Question => !!q)
      if (questions.value.length) {
        restoredSession.value = session
        subjectId.value = session.config.subjectId
        started.value = true
        return
      }
      await examSessionsRepo.abandon(session.id)
    }
    if (!subjectId.value && subjectsStore.list.length === 1) {
      subjectId.value = subjectsStore.list[0].id
    }
  } finally {
    loadingSession.value = false
  }
})

watch(
  subjectId,
  (id) => {
    void loadSubjectQuestions(id)
  },
  { immediate: true },
)

watch(onlyWrong, () => {
  resetTypeQuotasToAvailable()
})
</script>

<template>
  <div :class="['page page--wide', started && 'page--running']">
    <div v-if="!loadingSession && !started && !finished" class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">自测模式</h1>
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
      mode="practice"
      :questions="questions"
      :initial-session="restoredSession || undefined"
      @finish="onFinish"
    />

    <div v-else-if="loadingSession" class="loading-session">
      <van-loading size="24" />
    </div>

    <div v-else class="setup-body">
      <div v-if="presetQuestionIds.length" class="preset-banner">
        <van-icon name="warning-o" /> 本次练习将针对 {{ presetQuestionIds.length }} 道指定错题
      </div>

      <div class="card">
        <div class="field">
          <label class="field__label">科目</label>
          <ThemedSelect
            v-model="subjectId"
            :options="subjectOptions"
            placeholder="选择科目"
            :disabled="!!presetQuestionIds.length"
          />
        </div>
      </div>

      <div v-if="!presetQuestionIds.length" class="card">
        <!-- 题型多选 -->
        <div class="field">
          <div class="field__header">
            <label class="field__label"
              >题型与题量{{ selectedCount ? `（${selectedCount} 道）` : '' }}</label
            >
            <span class="field__hint">按当前筛选结果抽题</span>
          </div>
          <div v-if="!subjectId" class="empty-hint">先选择科目后配置题型。</div>
          <div v-else-if="typeStats.length === 0" class="empty-hint">
            当前科目还没有可练习的题目。
          </div>
          <div v-else class="practice-picker">
            <div class="scope-tabs">
              <button
                type="button"
                :class="['scope-tab', practiceScope === 'all' && 'scope-tab--active']"
                @click="applyScope('all')"
              >
                全部 <span>{{ scopeCounts.total }}</span>
              </button>
              <button
                type="button"
                :class="['scope-tab', practiceScope === 'unseen' && 'scope-tab--active']"
                @click="applyScope('unseen')"
              >
                未做 <span>{{ scopeCounts.unseen }}</span>
              </button>
              <button
                type="button"
                :class="['scope-tab', practiceScope === 'done' && 'scope-tab--active']"
                @click="applyScope('done')"
              >
                做过 <span>{{ scopeCounts.done }}</span>
              </button>
            </div>

            <div class="type-quota-list">
              <div
                v-for="item in typeStats"
                :key="item.type"
                :class="['type-quota', Number(typeQuotas[item.type] || 0) > 0 && 'type-quota--active']"
                @click.self="toggleType(item.type)"
              >
                <button
                  type="button"
                  class="type-quota__toggle"
                  :aria-label="`${item.label}${Number(typeQuotas[item.type] || 0) > 0 ? '已选择' : '未选择'}`"
                  @click="toggleType(item.type)"
                >
                  <van-icon v-if="Number(typeQuotas[item.type] || 0) > 0" name="success" />
                </button>
                <div class="type-quota__info">
                  <span class="type-quota__label">{{ item.label }}</span>
                  <span class="type-quota__count">
                    可选 {{ item.available }} · 已做 {{ item.done }} · 未做 {{ item.unseen }}
                  </span>
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
                    @blur="
                      setTypeQuota(item.type, Number(($event.target as HTMLInputElement).value))
                    "
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
              <div class="type-summary">
                本次自测 {{ selectedCount }} 道题
              </div>
            </div>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="switch-row" :class="{ 'switch-row--disabled': !!presetQuestionIds.length }">
          <div>
            <div class="switch-row__title">仅错题</div>
            <div class="switch-row__desc">只做错题本里的题</div>
          </div>
          <van-switch v-model="onlyWrong" :disabled="!!presetQuestionIds.length" />
        </div>
        <div class="switch-row">
          <div>
            <div class="switch-row__title">随机顺序</div>
            <div class="switch-row__desc">打乱题目顺序练习</div>
          </div>
          <van-switch v-model="random" />
        </div>
      </div>

      <van-button type="primary" round block @click="start">开始自测</van-button>
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
  gap: var(--sp-3);
  max-width: 560px;
  margin: 0 auto;
}

.loading-session {
  min-height: 320px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}

.field__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: var(--sp-1);
}
.field__hint {
  font-size: 11px;
  color: var(--text-3);
}
.practice-picker {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.scope-tabs {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
}
.scope-tab {
  min-width: 0;
  min-height: 34px;
  border: none;
  border-radius: var(--r-sm);
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  cursor: pointer;
  transition:
    background 0.15s,
    color 0.15s,
    box-shadow 0.15s;
}
.scope-tab span {
  color: var(--text-3);
  margin-left: 2px;
}
.scope-tab--active {
  background: var(--surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.scope-tab--active span {
  color: var(--brand);
}
.type-quota-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.type-quota {
  display: grid;
  grid-template-columns: 20px minmax(0, 1fr) auto;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.type-quota--active {
  background: var(--brand-soft);
  border-color: var(--brand);
  box-shadow: 0 4px 12px rgba(var(--brand-rgb), 0.08);
}
.type-quota__toggle {
  width: 20px;
  height: 20px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-full);
  background: var(--surface);
  color: transparent;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 12px;
  transition: all 0.15s;
}
.type-quota--active .type-quota__toggle {
  border-color: var(--brand);
  background: var(--brand);
  color: #ffffff;
}
.type-quota__info {
  display: flex;
  flex-direction: column;
  min-width: 0;
  gap: 3px;
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
  font-size: 13px;
  color: var(--text-2);
  text-align: right;
}
.num-input {
  display: flex;
  align-items: center;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface);
  width: fit-content;
}
.num-input__btn {
  width: 34px;
  height: 34px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.12s;
  flex-shrink: 0;
}
.num-input__btn:hover:not(:disabled) {
  background: var(--surface-2);
  color: var(--brand);
}
.num-input__btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.num-input__field {
  width: 52px;
  height: 34px;
  border: none;
  border-left: 1px solid var(--border);
  border-right: 1px solid var(--border);
  background: transparent;
  text-align: center;
  font-size: 15px;
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
@media (max-width: 576px) {
  .setup-body {
    max-width: none;
  }
  .type-quota {
    grid-template-columns: 20px minmax(0, 1fr);
  }
  .num-input {
    grid-column: 2;
  }
  .type-summary {
    text-align: left;
  }
}

.empty-hint {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
}

.switch-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) 0;
}
.switch-row + .switch-row {
  border-top: 1px solid var(--border);
}
.switch-row--disabled {
  opacity: 0.5;
}
.switch-row__title {
  font-size: 15px;
  font-weight: 500;
  color: var(--text);
}
.switch-row__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.preset-banner {
  background: var(--brand-soft);
  color: var(--brand);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  font-size: 13px;
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
