<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { examSessionsRepo } from '@/db/examSessions'
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

const subjectId = ref((route.query.subjectId as string) || '')
const subjectQuestions = ref<Question[]>([])
const types = ref<QuestionType[]>([])
const random = ref(true)
const onlyWrong = ref(false)

const allTypes: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

const availableTypes = computed(() => {
  const currentTypes = new Set(subjectQuestions.value.map((q) => q.type))
  return allTypes.filter((t) => currentTypes.has(t))
})

// 来自错题本的指定题目
const presetQuestionIds = ref<string[]>(
  route.query.questionIds ? (route.query.questionIds as string).split(',').filter(Boolean) : [],
)

function toggleType(t: QuestionType) {
  const i = types.value.indexOf(t)
  if (i >= 0) types.value.splice(i, 1)
  else types.value.push(t)
}

async function loadSubjectQuestions(id: string) {
  if (!id || presetQuestionIds.value.length) {
    subjectQuestions.value = []
    types.value = []
    return
  }
  subjectQuestions.value = await questionsRepo.filter({ subjectId: id })
  const allowed = new Set(subjectQuestions.value.map((q) => q.type))
  types.value = types.value.filter((t) => allowed.has(t))
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
  } else if (onlyWrong.value) {
    const wrongs = await wrongBookRepo.listAll()
    const wrongQids = wrongs.map((w) => w.questionId)
    qs = (await questionsRepo.findByIds(wrongQids)).filter((q) => q.subjectId === subjectId.value)
    if (types.value.length) qs = qs.filter((q) => types.value.includes(q.type))
  } else {
    qs = await questionsRepo.filter({
      subjectId: subjectId.value,
      types: types.value.length ? types.value : undefined,
    })
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
  let session: ExamSession | undefined
  const sessionId = route.query.sessionId as string | undefined
  if (sessionId) {
    session = await examSessionsRepo.get(sessionId)
  } else {
    // 自动寻找最后一场进行中的自测进行恢复
    session = await examSessionsRepo.findInProgressPractice()
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
})

watch(
  subjectId,
  (id) => {
    void loadSubjectQuestions(id)
  },
  { immediate: true },
)
</script>

<template>
  <div :class="['page page--wide', started && 'page--running']">
    <div v-if="!started && !finished" class="page-head page-head--row">
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
          <label class="field__label"
            >题型{{ types.length ? `（已选 ${types.length}）` : '（全部）' }}</label
          >
          <div v-if="!subjectId" class="empty-hint">先选择科目后配置题型。</div>
          <div v-else-if="availableTypes.length === 0" class="empty-hint">
            当前科目还没有可练习的题目。
          </div>
          <div v-else class="multi-chips">
            <button
              v-for="t in availableTypes"
              :key="t"
              :class="['mchip', types.includes(t) && 'mchip--active']"
              @click="toggleType(t)"
            >
              {{ QUESTION_TYPE_LABELS[t] }}
            </button>
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

.multi-chips {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.empty-hint {
  padding: var(--sp-3);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
}
.mchip {
  padding: 6px var(--sp-3);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
  border-radius: var(--r-full);
  cursor: pointer;
  transition: all 0.15s;
}
.mchip--active {
  background: var(--brand-soft);
  border-color: var(--brand);
  color: var(--brand);
  font-weight: 600;
}
.mchip:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
