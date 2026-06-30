<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import QuestionCard from './QuestionCard.vue'
import AnswerCard from './AnswerCard.vue'
import RichText from './RichText.vue'
import { isObjective, QUESTION_TYPE_LABELS, type Question } from '@/types'
import { gradeObjective } from '@/services/grading'
import { attemptsRepo } from '@/db/attempts'
import { wrongBookRepo } from '@/db/wrongbook'
import { examSessionsRepo } from '@/db/examSessions'
import type { AttemptMode, ExamSession, ExamSubMode, QuestionType } from '@/types'

const props = defineProps<{
  questions: Question[]
  mode: AttemptMode
  /** 考试模式：是否一次性交卷（不即时反馈） */
  classic?: boolean
  /** 考试时长（分钟），仅 classic 模式 */
  durationMin?: number
  /** 未完成考试恢复 */
  initialSession?: ExamSession
  examSubMode?: ExamSubMode
  questionTypes?: QuestionType[]
}>()

const emit = defineEmits<{
  finish: [
    result: {
      total: number
      correct: number
      answered: number
      durationMs: number
      session?: ExamSession
      detail: { questionId: string; correct: boolean | null; answered: boolean }[]
    },
  ]
}>()

const router = useRouter()
const idx = ref(0)
function saveCurrentIndex(newIdx = idx.value) {
  if (session.value) {
    localStorage.setItem(`quizbox_last_idx_${session.value.id}`, String(newIdx))
  }
}
watch(idx, (newIdx) => saveCurrentIndex(newIdx))
const current = computed(() => props.questions[idx.value])
const total = computed(() => props.questions.length)

const answers = ref<Record<string, string | string[]>>({})
const submitted = ref<Record<string, boolean>>({})
const gradeMap = ref<Record<string, boolean>>({})
/** 已记录 attempt 的题目 id，防止恢复会话后重做重复记录 */
const recorded = ref<Set<string>>(new Set())

const selfRating = ref<Record<string, number>>({})
const aiResult = ref<Record<string, { score: number; feedback: string }>>({})
const aiLoading = ref<Record<string, boolean>>({})

const progress = computed(() => Math.round(((idx.value + 1) / total.value) * 100))

// ===== 答题卡（题目导航网格）=====
const isDesktop = ref(typeof window !== 'undefined' && window.innerWidth >= 768)
const showCardMobile = ref(false)
function onResize() {
  isDesktop.value = window.innerWidth >= 768
}

/** 答题卡：各题是否已答（索引 → 是否作答） */
const answeredMap = computed(() => {
  const m: Record<number, boolean> = {}
  for (let i = 0; i < total.value; i++) {
    const q = props.questions[i]
    if (!q) continue
    const ans = answers.value[q.id]
    m[i] = ans != null && (!Array.isArray(ans) || ans.length > 0) && ans !== ''
  }
  return m
})
const answeredCount = computed(() => Object.values(answeredMap.value).filter(Boolean).length)
const sessionReady = ref(false)
/** 各题对错（仅非 classic 即时反馈模式有值） */
const correctnessMap = computed(() => {
  const m: Record<number, boolean> = {}
  for (let i = 0; i < total.value; i++) {
    const q = props.questions[i]
    if (!q) continue
    if (gradeMap.value[q.id] !== undefined) m[i] = gradeMap.value[q.id]
  }
  return m
})
const formatAnswerValue = (value: string | string[], type: string): string => {
  if (type !== 'judge') {
    return Array.isArray(value) ? value.join('、') : value
  }
  const display = (item: string) => {
    const normalized = item.trim().toUpperCase()
    if (normalized === 'T') return '正确'
    if (normalized === 'F') return '错误'
    return item
  }
  return Array.isArray(value) ? value.map(display).join('、') : display(value)
}

const answerText = computed(() => {
  const a = current.value?.answer
  if (!a) return ''
  return formatAnswerValue(a, current.value.type)
})

const formattedUserAnswer = computed(() => {
  const u = answers.value[current.value.id]
  if (u == null) return ''
  return formatAnswerValue(u, current.value.type)
})
async function jumpTo(i: number) {
  await persistAnswersNow()
  idx.value = i
  showCardMobile.value = false
}

// ===== 计时器（考试模式） =====
const remainingSec = ref(0)
const startedAt = ref(Date.now())
let timer: ReturnType<typeof setInterval> | null = null
const session = ref<ExamSession | null>(null)
const durationMinVal = computed(() => Number(props.durationMin || 0))

function fmtTime(sec: number): string {
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}

function startTimer() {
  if (!props.classic || !durationMinVal.value) return
  if (remainingSec.value <= 0) remainingSec.value = durationMinVal.value * 60
  timer = setInterval(() => {
    remainingSec.value--
    if (remainingSec.value <= 0) {
      showToast('时间到，自动交卷')
      finishPractice(true)
    }
  }, 1000)
}

function stopTimer() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

// ===== 会话持久化（考试 / 自测） =====
async function initSession() {
  if (props.initialSession) {
    session.value = props.initialSession
    answers.value = { ...props.initialSession.answers }
    startedAt.value = props.initialSession.startTime

    // 优先恢复上次退出的题号，其次是首个未答题号
    const savedIdx = localStorage.getItem(`quizbox_last_idx_${props.initialSession.id}`)
    if (savedIdx !== null) {
      idx.value = Number(savedIdx)
    } else {
      const firstUnanswered = props.questions.findIndex((q) => {
        const ans = answers.value[q.id]
        return ans == null || ans === '' || (Array.isArray(ans) && ans.length === 0)
      })
      if (firstUnanswered >= 0) {
        idx.value = firstUnanswered
      }
    }

    if (!props.classic) restoreSubmittedState()
    if (props.classic && durationMinVal.value) {
      const elapsedSec = Math.floor((Date.now() - props.initialSession.startTime) / 1000)
      remainingSec.value = Math.max(durationMinVal.value * 60 - elapsedSec, 0)
    }
    return
  }
  try {
    session.value = await examSessionsRepo.create(
      {
        subjectId: props.questions[0]?.subjectId || '',
        count: total.value,
        durationMin: durationMinVal.value,
        subMode:
          props.mode === 'practice'
            ? 'practice'
            : props.examSubMode || (props.classic ? 'classic' : 'wrong_redo'),
        questionTypes: props.questionTypes,
      },
      props.questions.map((q) => q.id),
    )
  } catch {
    // 持久化失败不阻塞做题
  }
}

// 答案变化后立即排队持久化，避免退出页面时防抖写入丢失。
let persistPromise: Promise<void> = Promise.resolve()
function persistAnswersNow() {
  const currentSession = session.value
  if (!currentSession) return Promise.resolve()
  const snapshot = { ...answers.value }
  persistPromise = persistPromise
    .catch(() => undefined)
    .then(async () => {
      await examSessionsRepo.updateAnswers(currentSession.id, snapshot)
      if (session.value?.id === currentSession.id) {
        session.value = { ...session.value, answers: snapshot }
      }
    })
    .catch(() => undefined)
  return persistPromise
}

function persistAnswers() {
  void persistAnswersNow()
}

function flushAnswers() {
  return persistAnswersNow()
}

function restoreSubmittedState() {
  const nextSubmitted: Record<string, boolean> = {}
  const nextGradeMap: Record<string, boolean> = {}
  for (const q of props.questions) {
    const ans = answers.value[q.id]
    if (ans == null || (Array.isArray(ans) && ans.length === 0)) continue
    nextSubmitted[q.id] = true
    if (isObjective(q.type)) {
      nextGradeMap[q.id] = gradeObjective(q, ans).isCorrect
    }
  }
  submitted.value = nextSubmitted
  gradeMap.value = nextGradeMap
}

// ===== 答题逻辑 =====
function setUserAnswerSingle(letter: string) {
  answers.value = { ...answers.value, [current.value.id]: letter }
  persistAnswers()
  if (!props.classic) submit()
}
function toggleMulti(letter: string) {
  const cur = (answers.value[current.value.id] as string[]) || []
  const arr = cur.includes(letter) ? cur.filter((x) => x !== letter) : [...cur, letter]
  answers.value = { ...answers.value, [current.value.id]: arr.sort() }
  persistAnswers()
}
function setFill(i: number, val: string) {
  const cur = (answers.value[current.value.id] as string[]) || []
  cur[i] = val
  answers.value = { ...answers.value, [current.value.id]: [...cur] }
  persistAnswers()
}
function setSubjective(val: string) {
  answers.value = { ...answers.value, [current.value.id]: val }
  persistAnswers()
}

function submit() {
  const q = current.value
  const ans = answers.value[q.id]
  if (ans == null || (Array.isArray(ans) && ans.length === 0)) {
    submitted.value = { ...submitted.value, [q.id]: false }
    return
  }
  submitted.value = { ...submitted.value, [q.id]: true }
  if (isObjective(q.type)) {
    const res = gradeObjective(q, ans)
    gradeMap.value = { ...gradeMap.value, [q.id]: res.isCorrect }
    recordAttempt(q.id, ans, res.isCorrect)
  }
}

function recordAttempt(qid: string, ans: string | string[], correct: boolean) {
  if (recorded.value.has(qid)) return
  recorded.value.add(qid)
  attemptsRepo.record({ questionId: qid, mode: props.mode, userAnswer: ans, isCorrect: correct })
  wrongBookRepo.recordAttempt({ questionId: qid, isCorrect: correct })
}

async function next() {
  await persistAnswersNow()
  if (idx.value < total.value - 1) idx.value++
  else finishPractice()
}
async function prev() {
  await persistAnswersNow()
  if (idx.value > 0) idx.value--
}

async function finishPractice(_auto = false) {
  stopTimer()
  const durationMs = Date.now() - startedAt.value

  // classic 模式：交卷时统一判分所有客观题，主观题仅记录作答
  if (props.classic) {
    for (const q of props.questions) {
      const ans = answers.value[q.id]
      if (ans != null && (!Array.isArray(ans) || ans.length > 0)) {
        if (isObjective(q.type)) {
          const res = gradeObjective(q, ans)
          gradeMap.value[q.id] = res.isCorrect
          submitted.value[q.id] = true
          recordAttempt(q.id, ans, res.isCorrect)
        } else {
          submitted.value[q.id] = true
          if (!recorded.value.has(q.id)) {
            recorded.value.add(q.id)
            attemptsRepo.record({
              questionId: q.id,
              mode: props.mode,
              userAnswer: ans,
            })
          }
        }
      }
    }
  }

  // 统计口径：correct 仅计客观题答对数（与 score 一致），answered 计实际作答题数
  const detail = props.questions.map((q) => {
    const ans = answers.value[q.id]
    const hasAns = ans != null && (!Array.isArray(ans) || ans.length > 0) && ans !== ''
    const objective = isObjective(q.type)
    return {
      questionId: q.id,
      correct: objective ? (hasAns ? !!gradeMap.value[q.id] : null) : null,
      answered: hasAns,
    }
  })
  const correct = detail.filter((d) => d.correct === true).length
  const answered = detail.filter((d) => d.answered).length

  // 持久化考试场次结果
  const finalSession = session.value
  if (finalSession) {
    const objectiveQuestions = props.questions.filter((q) => isObjective(q.type))
    const objectiveCorrect = objectiveQuestions.filter((q) => gradeMap.value[q.id]).length
    const score = objectiveQuestions.length
      ? Math.round((objectiveCorrect / objectiveQuestions.length) * 100)
      : null
    await examSessionsRepo.finish(finalSession.id, {
      answers: { ...answers.value },
      score,
    })
    localStorage.removeItem(`quizbox_last_idx_${finalSession.id}`)
    session.value = null
  }

  emit('finish', {
    total: total.value,
    correct,
    answered,
    durationMs,
    session: finalSession || undefined,
    detail,
  })
}

async function callAi() {
  const q = current.value
  const ans = answers.value[q.id]
  aiLoading.value[q.id] = true
  try {
    const { chatJson } = await import('@/services/ai')
    const res = await chatJson<{ score: number; feedback: string }>([
      {
        role: 'system',
        content:
          '你是阅卷助手。根据题目和参考答案为用户答案打分（0-100）并给出简短评语与得分点。以 JSON 输出 {"score":number,"feedback":string}',
      },
      {
        role: 'user',
        content: `题目：${q.stem}\n参考答案：${Array.isArray(q.answer) ? q.answer.join('；') : q.answer}\n用户答案：${Array.isArray(ans) ? ans.join('；') : ans}`,
      },
    ])
    aiResult.value[q.id] = res
    attemptsRepo.record({
      questionId: q.id,
      mode: props.mode,
      userAnswer: ans || '',
      aiScore: res.score,
      aiFeedback: res.feedback,
    })
  } catch (e: any) {
    showToast(e?.message || 'AI 评分失败')
  } finally {
    aiLoading.value[q.id] = false
  }
}

function submitSelf(rating: number) {
  selfRating.value[current.value.id] = rating
  persistAnswers()
  attemptsRepo.record({
    questionId: current.value.id,
    mode: props.mode,
    userAnswer: answers.value[current.value.id] || '',
    selfRating: rating,
  })
}

onMounted(async () => {
  if (!total.value) return
  window.addEventListener('resize', onResize)
  await initSession()
  sessionReady.value = true
  if (!session.value) startedAt.value = Date.now()
  if (props.initialSession && props.classic && durationMinVal.value && remainingSec.value <= 0) {
    showToast('考试已超时，自动交卷')
    finishPractice(true)
    return
  }
  startTimer()
})

onBeforeUnmount(() => {
  stopTimer()
  window.removeEventListener('resize', onResize)
  saveCurrentIndex()
  // classic 模式：若已超时但未交卷，自动完成并记录结果（避免 session 卡在 in_progress）
  if (props.classic && session.value && remainingSec.value <= 0) {
    finishPractice(true)
    return
  }
  void flushAnswers()
})

const isSelected = (letter: string) => {
  const ans = answers.value[current.value.id]
  if (ans == null) return false
  if (Array.isArray(ans)) {
    return ans.includes(letter)
  }
  return ans === letter
}

const isCorrectOption = (letter: string) => {
  const std = current.value.answer
  if (std == null) return false
  const stdArr = Array.isArray(std) ? std : [std]
  return stdArr.map((s) => s.trim().toUpperCase()).includes(letter.toUpperCase())
}

const isWrongOption = (letter: string) => {
  return isSelected(letter) && !isCorrectOption(letter)
}

// 注：各 setter 已显式调用 persistAnswers()，无需 watch(answers, deep) 重复触发
</script>

<template>
  <div v-if="total === 0" class="placeholder">没有符合条件的题目</div>

  <div v-else-if="!sessionReady" class="placeholder">
    <van-loading size="24" />
  </div>

  <div v-else :class="['quiz-shell', isDesktop && 'quiz-shell--desktop']">
    <div class="quiz-main">
      <div class="quiz-topbar">
        <div class="quiz-nav">
          <button type="button" class="quiz-back" aria-label="返回" @click="router.back()">
            <van-icon name="arrow-left" size="18" />
          </button>
          <van-progress
            class="quiz-progress"
            :percentage="progress"
            color="var(--brand)"
            track-color="var(--border)"
            :show-pivot="true"
          />
        </div>

        <div class="quiz-header">
          <span>{{ idx + 1 }} / {{ total }}</span>
          <van-tag plain>{{ QUESTION_TYPE_LABELS[current.type] }}</van-tag>
          <van-tag
            v-if="props.classic && remainingSec > 0"
            :type="remainingSec < 60 ? 'danger' : 'primary'"
          >
            ⏱ {{ fmtTime(remainingSec) }}
          </van-tag>
        </div>
      </div>

      <div class="quiz-content">
        <QuestionCard
          :question="current"
          :show-answer="false"
          hide-options
          :user-answer="answers[current.id]"
          :user-answer-correct="gradeMap[current.id]"
        />

        <!-- 答题区 -->
        <div class="answer-area">
          <!-- 单选 -->
          <template v-if="current.type === 'single'">
            <div class="options-list">
              <div
                v-for="(opt, i) in current.options"
                :key="i"
                class="option-item"
                :class="{
                  'option-item--selected': isSelected(String.fromCharCode(65 + i)),
                  'option-item--disabled': !props.classic && submitted[current.id],
                  'option-item--correct':
                    !props.classic &&
                    submitted[current.id] &&
                    isCorrectOption(String.fromCharCode(65 + i)),
                  'option-item--wrong':
                    !props.classic &&
                    submitted[current.id] &&
                    isWrongOption(String.fromCharCode(65 + i)),
                }"
                @click="
                  !props.classic && submitted[current.id]
                    ? null
                    : setUserAnswerSingle(String.fromCharCode(65 + i))
                "
              >
                <div class="option-badge">{{ String.fromCharCode(65 + i) }}</div>
                <div class="option-text"><RichText :text="opt" /></div>
              </div>
            </div>
          </template>

          <!-- 多选 -->
          <template v-else-if="current.type === 'multiple'">
            <div class="options-list">
              <div
                v-for="(opt, i) in current.options"
                :key="i"
                class="option-item"
                :class="{
                  'option-item--selected': isSelected(String.fromCharCode(65 + i)),
                  'option-item--disabled': !props.classic && submitted[current.id],
                  'option-item--correct':
                    !props.classic &&
                    submitted[current.id] &&
                    isCorrectOption(String.fromCharCode(65 + i)),
                  'option-item--wrong':
                    !props.classic &&
                    submitted[current.id] &&
                    isWrongOption(String.fromCharCode(65 + i)),
                }"
                @click="
                  !props.classic && submitted[current.id]
                    ? null
                    : toggleMulti(String.fromCharCode(65 + i))
                "
              >
                <div class="option-badge">{{ String.fromCharCode(65 + i) }}</div>
                <div class="option-text"><RichText :text="opt" /></div>
              </div>
            </div>
          </template>

          <!-- 判断 -->
          <template v-else-if="current.type === 'judge'">
            <div class="options-list">
              <div
                class="option-item"
                :class="{
                  'option-item--selected': isSelected('T'),
                  'option-item--disabled': !props.classic && submitted[current.id],
                  'option-item--correct':
                    !props.classic && submitted[current.id] && isCorrectOption('T'),
                  'option-item--wrong':
                    !props.classic && submitted[current.id] && isWrongOption('T'),
                }"
                @click="!props.classic && submitted[current.id] ? null : setUserAnswerSingle('T')"
              >
                <div class="option-badge">
                  <van-icon name="success" />
                </div>
                <div class="option-text">正确</div>
              </div>
              <div
                class="option-item"
                :class="{
                  'option-item--selected': isSelected('F'),
                  'option-item--disabled': !props.classic && submitted[current.id],
                  'option-item--correct':
                    !props.classic && submitted[current.id] && isCorrectOption('F'),
                  'option-item--wrong':
                    !props.classic && submitted[current.id] && isWrongOption('F'),
                }"
                @click="!props.classic && submitted[current.id] ? null : setUserAnswerSingle('F')"
              >
                <div class="option-badge">
                  <van-icon name="cross" />
                </div>
                <div class="option-text">错误</div>
              </div>
            </div>
          </template>

          <!-- 填空 -->
          <template v-else-if="current.type === 'fill'">
            <van-cell-group inset>
              <van-field
                v-for="(_, i) in Array.isArray(current.answer) ? current.answer : [current.answer]"
                :key="i"
                :label="`空${i + 1}`"
                placeholder="请输入"
                :model-value="((answers[current.id] as string[]) || [])[i]"
                @update:model-value="(v: string) => setFill(i, v)"
                :disabled="!props.classic && submitted[current.id]"
              />
            </van-cell-group>
          </template>

          <!-- 主观题 -->
          <template v-else>
            <van-cell-group inset>
              <van-field
                type="textarea"
                placeholder="请输入你的答案"
                rows="4"
                autosize
                :model-value="answers[current.id] as string"
                @update:model-value="(v: string) => setSubjective(v)"
              />
            </van-cell-group>

            <div v-if="!props.classic" class="subjective-grade card">
              <van-button
                size="small"
                plain
                type="primary"
                :loading="aiLoading[current.id]"
                @click="callAi"
              >
                AI 评分
              </van-button>
              <div class="self-rate">
                <span>自评：</span>
                <van-stepper
                  :min="0"
                  :max="100"
                  :step="10"
                  @change="(v: any) => submitSelf(Number(v))"
                />
              </div>
            </div>
            <div v-if="aiResult[current.id]" class="ai-feedback card">
              <van-tag type="primary">AI {{ aiResult[current.id].score }} 分</van-tag>
              <RichText :text="aiResult[current.id].feedback" />
            </div>
          </template>

          <div
            v-if="
              !props.classic &&
              !submitted[current.id] &&
              current.type !== 'single' &&
              current.type !== 'judge'
            "
            style="padding: 12px"
          >
            <van-button block type="primary" round @click="submit">确认答案</van-button>
          </div>
        </div>

        <!-- 答案与解析 (放置在选项下方，防止抖动) -->
        <div v-if="!props.classic && submitted[current.id]" class="quiz-feedback-card card">
          <div
            v-if="
              answers[current.id] != null &&
              answers[current.id] !== '' &&
              (!Array.isArray(answers[current.id]) || (answers[current.id] as string[]).length > 0)
            "
            class="feedback-row"
            style="margin-bottom: var(--sp-2)"
          >
            <van-tag
              :type="
                isObjective(current.type)
                  ? gradeMap[current.id]
                    ? 'success'
                    : 'danger'
                  : 'primary'
              "
            >
              您的答案
            </van-tag>
            <span
              class="feedback-text"
              :class="{
                'feedback-text--wrong': isObjective(current.type) && !gradeMap[current.id],
                'feedback-text--neutral': !isObjective(current.type),
              }"
            >
              {{ formattedUserAnswer }}
            </span>
          </div>
          <div class="feedback-row">
            <van-tag type="success">参考答案</van-tag>
            <span class="feedback-text feedback-text--correct">{{ answerText }}</span>
          </div>
          <div v-if="current.analysis" class="feedback-analysis">
            <div class="feedback-analysis-title">解析</div>
            <RichText :text="current.analysis" />
          </div>
        </div>
      </div>

      <!-- 导航 -->
      <div class="quiz-actions">
        <van-button round plain :disabled="idx === 0" @click="prev" class="quiz-action-btn">
          <van-icon name="arrow-left" /> 上一题
        </van-button>
        <van-button
          v-if="idx < total - 1"
          type="primary"
          round
          @click="next"
          class="quiz-action-btn quiz-action-btn--primary"
        >
          下一题 <van-icon name="arrow" />
        </van-button>
        <van-button
          v-else
          type="success"
          round
          @click="finishPractice()"
          class="quiz-action-btn quiz-action-btn--success"
        >
          {{ props.classic ? '交卷' : '完成' }} <van-icon name="passed" />
        </van-button>
        <van-button
          v-if="!isDesktop"
          round
          plain
          aria-label="打开答题卡"
          class="quiz-action-btn quiz-action-btn--card"
          @click="showCardMobile = true"
        >
          <van-icon name="apps-o" />
        </van-button>
      </div>
    </div>
    <!-- /.quiz-main -->

    <!-- 桌面端：右侧答题卡侧栏 -->
    <aside v-if="isDesktop" class="quiz-aside">
      <div class="quiz-aside__inner">
        <AnswerCard
          :total="total"
          :current="idx"
          :answered="answeredMap"
          :correctness="correctnessMap"
          :show-correctness="!props.classic"
          @jump="jumpTo"
        />
      </div>
    </aside>

    <!-- 手机端：答题卡弹层 -->
    <template v-if="!isDesktop">
      <van-action-sheet v-model:show="showCardMobile" :round="true">
        <template #title>
          <div class="mobile-sheet-head">
            <span class="mobile-sheet-title">答题卡</span>
            <span class="mobile-sheet-meta">已答 {{ answeredCount }} / {{ total }}</span>
          </div>
        </template>
        <div class="card-sheet">
          <AnswerCard
            :total="total"
            :current="idx"
            :answered="answeredMap"
            :correctness="correctnessMap"
            :show-correctness="!props.classic"
            hide-header
            @jump="jumpTo"
          />
        </div>
      </van-action-sheet>
    </template>
  </div>
</template>

<style scoped>
.quiz-shell {
  position: relative;
  height: calc(100vh - 40px);
  min-height: 480px;
  overflow: hidden;
}
@supports (height: 100dvh) {
  .quiz-shell {
    height: calc(100dvh - 40px);
  }
}
.quiz-shell--desktop {
  display: flex;
  gap: var(--sp-6);
  align-items: stretch;
}
.quiz-main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
  /* 题干行宽控制在阅读舒适范围，避免桌面端过宽 */
  max-width: 760px;
}
.quiz-aside {
  width: 290px;
  flex-shrink: 0;
  position: sticky;
  top: 0;
  align-self: flex-start;
}
.quiz-aside__inner {
  background: var(--surface);
  border-radius: var(--r-md);
  padding: var(--sp-3);
  box-shadow: var(--shadow-sm);
  max-height: calc(100vh - 40px);
  overflow-y: auto;
  overscroll-behavior: contain;
}
.card-sheet {
  max-height: min(70vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: var(--sp-2);
  padding-bottom: calc(var(--sp-2) + env(safe-area-inset-bottom, 0px));
}
.quiz-topbar {
  position: relative;
  z-index: 2;
  flex-shrink: 0;
  padding: var(--sp-2) var(--sp-1) 0;
  background: var(--bg);
}
.quiz-nav {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.quiz-back {
  width: 34px;
  height: 34px;
  border: 1px solid var(--border);
  border-radius: var(--r-full);
  background: var(--surface);
  color: var(--text-2);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: var(--shadow-sm);
}
.quiz-progress {
  flex: 1;
  min-width: 0;
}
.quiz-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 0 var(--sp-1) var(--sp-4);
}
.quiz-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
  margin: var(--sp-3) 0;
  color: var(--text-3);
  font-size: 14px;
}
.answer-area {
  margin-top: var(--sp-2);
}
.options-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding: 0 var(--sp-1);
}
.option-item {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: var(--r-md);
  cursor: pointer;
  transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
.option-item:hover:not(.option-item--disabled):not(.option-item--selected) {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
.option-item--selected {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.option-item--selected:hover,
.option-item--selected:active {
  border-color: var(--brand);
  background: var(--brand-soft);
}
.option-item--correct {
  border-color: var(--success) !important;
  background: rgba(0, 180, 42, 0.06) !important;
}
.option-item--wrong {
  border-color: var(--danger) !important;
  background: rgba(245, 63, 63, 0.06) !important;
}
.option-badge {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--surface-2);
  border: 1px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 13px;
  color: var(--text-2);
  flex-shrink: 0;
  transition: all 0.2s ease;
}
.option-item--selected .option-badge {
  background: var(--brand);
  border-color: var(--brand);
  color: #ffffff;
}
.option-item--correct .option-badge {
  background: var(--success);
  border-color: var(--success);
  color: #ffffff;
}
.option-item--wrong .option-badge {
  background: var(--danger);
  border-color: var(--danger);
  color: #ffffff;
}
.option-text {
  font-size: 14px;
  color: var(--text-2);
  line-height: 1.5;
  flex: 1;
}
.option-item--selected .option-text {
  color: var(--text);
  font-weight: 500;
}
.option-item--correct .option-text {
  color: var(--success);
}
.option-item--wrong .option-text {
  color: var(--danger);
}

.subjective-grade {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  margin-top: var(--sp-3);
}
.self-rate {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 13px;
  color: var(--text-2);
}
.ai-feedback {
  padding: var(--sp-3) var(--sp-4);
  margin-top: var(--sp-3);
}
.quiz-feedback-card {
  margin-top: var(--sp-3);
}
.feedback-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.feedback-text {
  font-weight: 600;
  color: var(--success);
}
.feedback-text--wrong {
  color: var(--danger) !important;
}
.feedback-text--neutral {
  color: var(--text);
}
.feedback-analysis {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 1px dashed var(--border-strong);
}
.feedback-analysis-title {
  font-size: 13px;
  color: var(--text-3);
  margin-bottom: 4px;
}

.quiz-actions {
  display: flex;
  gap: var(--sp-3);
  flex-shrink: 0;
  margin-top: 0;
  padding: var(--sp-3) var(--sp-1);
  background: var(--bg);
  border-top: 1px solid var(--border);
}
.quiz-action-btn {
  flex: 1;
  height: 42px;
  font-size: 14px;
  font-weight: 500;
  min-width: 0;
}
.quiz-action-btn--primary {
  background: var(--brand);
  border-color: var(--brand);
}
.quiz-action-btn--success {
  background: var(--success);
  border-color: var(--success);
}
.quiz-action-btn--card {
  flex: 0 0 44px;
  padding: 0;
}

.mobile-sheet-head {
  display: flex;
  align-items: baseline;
  justify-content: center;
  gap: var(--sp-2);
}
.mobile-sheet-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}
.mobile-sheet-meta {
  font-size: 13px;
  color: var(--text-3);
  font-weight: normal;
}

@media (max-width: 767px) {
  .quiz-shell {
    height: 100vh;
    min-height: 0;
  }
  @supports (height: 100dvh) {
    .quiz-shell {
      height: 100dvh;
    }
  }
  .quiz-topbar {
    padding: max(var(--sp-4), env(safe-area-inset-top, 0px)) var(--sp-4) 0;
  }
  .quiz-content {
    padding: 0 var(--sp-4) calc(var(--sp-4) + 68px + env(safe-area-inset-bottom, 0px));
  }
  .quiz-actions {
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    max-width: 760px;
    margin: 0 auto;
    z-index: 10;
    gap: var(--sp-2);
    padding: var(--sp-3) var(--sp-4) calc(var(--sp-3) + env(safe-area-inset-bottom, 0px));
    box-shadow: 0 -4px 16px rgba(0, 0, 0, 0.04);
  }
  .quiz-action-btn {
    height: 44px;
    font-size: 13px;
  }
  .quiz-action-btn--card {
    flex-basis: 44px;
  }
}
</style>
