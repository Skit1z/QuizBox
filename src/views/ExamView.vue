<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { attemptsRepo } from '@/db/attempts'
import { examSessionsRepo } from '@/db/examSessions'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import ExamResult from '@/components/ExamResult.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import type { ExamSession, ExamSubMode } from '@/types'
import type { Question } from '@/types'

const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const finished = ref(false)
const questions = ref<Question[]>([])
const result = ref<any>(null)
const restoredSession = ref<ExamSession | null>(null)

const subjectId = ref('')
const subMode = ref<ExamSubMode>('classic')
const count = ref(20)
const durationMin = ref(30)

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

const subModes: { value: ExamSubMode; label: string; desc: string }[] = [
  { value: 'classic', label: '传统限时', desc: '设定题量时长，做完交卷出分' },
  { value: 'wrong_redo', label: '错题重做', desc: '只做错题本里的题' },
  { value: 'random', label: '随机抽查', desc: '从题库随机抽题' },
  { value: 'shuffle', label: '乱序练习', desc: '题目顺序打乱' },
  { value: 'weak', label: '薄弱点加权', desc: '优先抽出错率高的题' },
]

const classicModes: ExamSubMode[] = ['classic', 'random', 'shuffle', 'weak', 'wrong_redo']

async function start() {
  if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  }
  const base = await questionsRepo.filter({ subjectId: subjectId.value })
  let qs: Question[]

  switch (subMode.value) {
    case 'wrong_redo':
    case 'weak': {
      const wrongs = await wrongBookRepo.listAll()
      const wMap = new Map(wrongs.map((w) => [w.questionId, w.reviewCount || 1]))
      if (subMode.value === 'wrong_redo') {
        qs = base.filter((q) => wMap.has(q.id))
        qs = shuffle(qs)
      } else {
        const stats = await attemptsRepo.getObjectiveStats(base.map((q) => q.id))
        // weak：按真实错题率和错题本状态加权，带随机扰动
        qs = base
          .map((q) => {
            const s = stats.get(q.id)
            const wrongRate = s?.total ? s.wrong / s.total : 0
            const wrongBookBoost = wMap.has(q.id) ? 1 : 0
            return { q, w: wrongBookBoost + wrongRate, r: Math.random() }
          })
          .sort((a, b) => b.w - a.w || a.r - b.r)
          .map((x) => x.q)
      }
      break
    }
    case 'random':
    case 'shuffle':
    case 'classic':
    default:
      qs = shuffle(base)
  }

  qs = qs.slice(0, count.value)
  if (qs.length === 0) {
    showFailToast('没有符合条件的题目')
    return
  }
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
  subMode.value = inProgress.config.subMode
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
      :classic="classicModes.includes(subMode)"
      :duration-min="durationMin"
      :questions="questions"
      :initial-session="restoredSession || undefined"
      :exam-sub-mode="subMode"
      @finish="onFinish"
    />

    <div v-else class="setup-body">
      <!-- 科目 -->
      <div class="card">
        <div class="field">
          <label class="field__label">科目</label>
          <ThemedSelect v-model="subjectId" :options="subjectOptions" placeholder="选择科目" />
        </div>
      </div>

      <!-- 考试模式 -->
      <div class="section-title">考试模式</div>
      <div class="card mode-list">
        <div
          v-for="m in subModes"
          :key="m.value"
          :class="['mode-item', subMode === m.value && 'mode-item--active']"
          @click="subMode = m.value"
        >
          <div class="mode-item__radio">
            <div class="mode-item__dot"></div>
          </div>
          <div class="mode-item__body">
            <div class="mode-item__label">{{ m.label }}</div>
            <div class="mode-item__desc">{{ m.desc }}</div>
          </div>
        </div>
      </div>

      <!-- 题量与时长 -->
      <div class="section-title">题量与时长</div>
      <div class="card">
        <div class="num-row">
          <span class="num-row__label">题量</span>
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
        <div class="num-row">
          <span class="num-row__label">时长（分钟）</span>
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

      <van-button type="primary" round block @click="start">开始考试</van-button>
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

.mode-list {
  padding: var(--sp-2);
}
.mode-item {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: background 0.12s;
}
.mode-item:active {
  background: var(--surface-2);
}
.mode-item--active {
  background: var(--brand-soft);
}
.mode-item__radio {
  width: 20px;
  height: 20px;
  border-radius: 50%;
  border: 2px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-top: 2px;
  transition: border-color 0.15s;
}
.mode-item--active .mode-item__radio {
  border-color: var(--brand);
}
.mode-item__dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: var(--brand);
  transform: scale(0);
  transition: transform 0.15s;
}
.mode-item--active .mode-item__dot {
  transform: scale(1);
}
.mode-item__body {
  flex: 1;
}
.mode-item__label {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.mode-item--active .mode-item__label {
  color: var(--brand);
}
.mode-item__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

.num-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--sp-3) 0;
}
.num-row + .num-row {
  border-top: 1px solid var(--border);
}
.num-row__label {
  font-size: 15px;
  color: var(--text);
}
.num-input {
  display: flex;
  align-items: center;
  gap: 0;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  overflow: hidden;
  background: var(--surface-2);
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
</style>
