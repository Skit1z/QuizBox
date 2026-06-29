<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { showToast } from 'vant'
import QuestionCard from './QuestionCard.vue'
import RichText from './RichText.vue'
import { isObjective, QUESTION_TYPE_LABELS, type Question } from '@/types'
import { gradeObjective } from '@/services/grading'
import { attemptsRepo } from '@/db/attempts'
import { wrongBookRepo } from '@/db/wrongbook'
import { examSessionsRepo } from '@/db/examSessions'
import type { AttemptMode, ExamSession, ExamSubMode } from '@/types'

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
}>()

const emit = defineEmits<{
  finish: [result: {
    total: number
    correct: number
    answered: number
    durationMs: number
    session?: ExamSession
    detail: { questionId: string; correct: boolean | null; answered: boolean }[]
  }]
}>()

const router = useRouter()
const idx = ref(0)
const current = computed(() => props.questions[idx.value])
const total = computed(() => props.questions.length)

const answers = ref<Record<string, string | string[]>>({})
const submitted = ref<Record<string, boolean>>({})
const gradeMap = ref<Record<string, boolean>>({})

const selfRating = ref<Record<string, number>>({})
const aiResult = ref<Record<string, { score: number; feedback: string }>>({})
const aiLoading = ref<Record<string, boolean>>({})

const progress = computed(() => Math.round(((idx.value + 1) / total.value) * 100))

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

// ===== ExamSession 持久化（考试模式） =====
async function initSession() {
  if (props.mode !== 'exam') return
  if (props.initialSession) {
    session.value = props.initialSession
    answers.value = { ...props.initialSession.answers }
    startedAt.value = props.initialSession.startTime
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
        subMode: props.examSubMode || (props.classic ? 'classic' : 'wrong_redo'),
      },
      props.questions.map((q) => q.id),
    )
  } catch {
    // 持久化失败不阻塞做题
  }
}

// 答案变化时持久化（防抖式：每次改变都存，考试题量不大）
let persistTimer: ReturnType<typeof setTimeout> | null = null
function persistAnswers() {
  if (!session.value) return
  if (persistTimer) clearTimeout(persistTimer)
  persistTimer = setTimeout(() => {
    examSessionsRepo.updateAnswers(session.value!.id, { ...answers.value })
  }, 800)
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
  attemptsRepo.record({ questionId: qid, mode: props.mode, userAnswer: ans, isCorrect: correct })
  wrongBookRepo.recordAttempt({ questionId: qid, isCorrect: correct })
}

function next() {
  if (idx.value < total.value - 1) idx.value++
  else finishPractice()
}
function prev() {
  if (idx.value > 0) idx.value--
}

async function finishPractice(auto = false) {
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
          attemptsRepo.record({
            questionId: q.id,
            mode: props.mode,
            userAnswer: ans,
          })
        }
      }
    }
  }

  let correct = 0
  const detail = props.questions.map((q) => {
    const c = gradeMap.value[q.id]
    if (c) correct++
    return {
      questionId: q.id,
      correct: isObjective(q.type) ? (submitted.value[q.id] ? c : null) : null,
      answered: !!submitted.value[q.id] || answers.value[q.id] != null,
    }
  })

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
    session.value = null
  }

  emit('finish', {
    total: total.value,
    correct,
    answered: Object.keys(submitted.value).length,
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
  attemptsRepo.record({
    questionId: current.value.id,
    mode: props.mode,
    userAnswer: answers.value[current.value.id] || '',
    selfRating: rating,
  })
}

onMounted(async () => {
  if (!total.value) return
  await initSession()
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
  // 清理未完成的持久化定时器，避免卸载后写库
  if (persistTimer) {
    clearTimeout(persistTimer)
    persistTimer = null
  }
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

  <div v-else>
    <van-progress :percentage="progress" color="var(--brand)" track-color="var(--border)" :show-pivot="true" />

    <div class="quiz-header">
      <span>{{ idx + 1 }} / {{ total }}</span>
      <van-tag plain>{{ QUESTION_TYPE_LABELS[current.type] }}</van-tag>
      <van-tag v-if="props.classic && remainingSec > 0" :type="remainingSec < 60 ? 'danger' : 'primary'">
        ⏱ {{ fmtTime(remainingSec) }}
      </van-tag>
    </div>

    <QuestionCard
      :question="current"
      :show-answer="!props.classic && submitted[current.id]"
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
              'option-item--correct': !props.classic && submitted[current.id] && isCorrectOption(String.fromCharCode(65 + i)),
              'option-item--wrong': !props.classic && submitted[current.id] && isWrongOption(String.fromCharCode(65 + i))
            }"
            @click="(!props.classic && submitted[current.id]) ? null : setUserAnswerSingle(String.fromCharCode(65 + i))"
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
              'option-item--correct': !props.classic && submitted[current.id] && isCorrectOption(String.fromCharCode(65 + i)),
              'option-item--wrong': !props.classic && submitted[current.id] && isWrongOption(String.fromCharCode(65 + i))
            }"
            @click="(!props.classic && submitted[current.id]) ? null : toggleMulti(String.fromCharCode(65 + i))"
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
              'option-item--correct': !props.classic && submitted[current.id] && isCorrectOption('T'),
              'option-item--wrong': !props.classic && submitted[current.id] && isWrongOption('T')
            }"
            @click="(!props.classic && submitted[current.id]) ? null : setUserAnswerSingle('T')"
          >
            <div class="option-badge">
              <van-icon name="success" v-if="isSelected('T')" />
              <span v-else>T</span>
            </div>
            <div class="option-text">正确</div>
          </div>
          <div
            class="option-item"
            :class="{
              'option-item--selected': isSelected('F'),
              'option-item--disabled': !props.classic && submitted[current.id],
              'option-item--correct': !props.classic && submitted[current.id] && isCorrectOption('F'),
              'option-item--wrong': !props.classic && submitted[current.id] && isWrongOption('F')
            }"
            @click="(!props.classic && submitted[current.id]) ? null : setUserAnswerSingle('F')"
          >
            <div class="option-badge">
              <van-icon name="cross" v-if="isSelected('F')" />
              <span v-else>F</span>
            </div>
            <div class="option-text">错误</div>
          </div>
        </div>
      </template>

      <!-- 填空 -->
      <template v-else-if="current.type === 'fill'">
        <van-cell-group inset>
          <van-field
            v-for="(_, i) in (Array.isArray(current.answer) ? current.answer : [current.answer])"
            :key="i"
            :label="`空${i + 1}`"
            placeholder="请输入"
            :model-value="((answers[current.id] as string[]) || [])[i]"
            @update:model-value="(v:string) => setFill(i, v)"
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
            :model-value="(answers[current.id] as string)"
            @update:model-value="(v:string) => setSubjective(v)"
          />
        </van-cell-group>

        <div v-if="!props.classic" class="subjective-grade card">
          <van-button size="small" plain type="primary" :loading="aiLoading[current.id]" @click="callAi">
            AI 评分
          </van-button>
          <div class="self-rate">
            <span>自评：</span>
            <van-stepper :min="0" :max="100" :step="10" @change="(v:any) => submitSelf(Number(v))" />
          </div>
        </div>
        <div v-if="aiResult[current.id]" class="ai-feedback card">
          <van-tag type="primary">AI {{ aiResult[current.id].score }} 分</van-tag>
          <RichText :text="aiResult[current.id].feedback" />
        </div>
      </template>

      <div v-if="!props.classic && !submitted[current.id] && current.type !== 'single' && current.type !== 'judge'" style="padding: 12px">
        <van-button block type="primary" round @click="submit">确认答案</van-button>
      </div>
      <div v-if="!props.classic && submitted[current.id]" class="feedback-tag">
        <van-tag :type="gradeMap[current.id] ? 'success' : 'danger'" size="large" round>
          {{ gradeMap[current.id] ? '回答正确' : '回答错误' }}
        </van-tag>
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
      <van-button round plain @click="router.back()" class="quiz-action-btn quiz-action-btn--exit">
        <van-icon name="close" /> 退出
      </van-button>
    </div>
  </div>
</template>

<style scoped>
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
  gap: var(--sp-2);
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
.option-item:hover:not(.option-item--disabled) {
  border-color: var(--border-strong);
  background: var(--surface-2);
}
.option-item--selected {
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
.feedback-tag {
  text-align: center;
  padding: var(--sp-3);
}

.quiz-actions {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-5);
  padding: var(--sp-3) var(--sp-1);
}
.quiz-action-btn {
  flex: 1;
  height: 42px;
  font-size: 14px;
  font-weight: 500;
}
.quiz-action-btn--primary {
  background: var(--brand);
  border-color: var(--brand);
}
.quiz-action-btn--success {
  background: var(--success);
  border-color: var(--success);
}
</style>
