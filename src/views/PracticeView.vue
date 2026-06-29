<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import { QUESTION_TYPE_LABELS, type Question, type QuestionType } from '@/types'

defineOptions({ name: 'PracticeView' })

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const questions = ref<Question[]>([])

const subjectId = ref((route.query.subjectId as string) || '')
const types = ref<QuestionType[]>([])
const random = ref(true)
const onlyWrong = ref(false)

const allTypes: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)

// 来自错题本的指定题目
const presetQuestionIds = ref<string[]>(
  route.query.questionIds ? (route.query.questionIds as string).split(',').filter(Boolean) : [],
)

function toggleType(t: QuestionType) {
  const i = types.value.indexOf(t)
  if (i >= 0) types.value.splice(i, 1)
  else types.value.push(t)
}

async function start() {
  let qs: Question[]

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
  started.value = true
}

onMounted(async () => {
  await subjectsStore.load()
  if (!subjectId.value && subjectsStore.list.length === 1) {
    subjectId.value = subjectsStore.list[0].id
  }
})
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">自测模式</h1>
      </div>
    </div>

    <QuizRunner v-if="started" mode="practice" :questions="questions" @finish="started = false" />

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

      <div class="card">
        <!-- 题型多选 -->
        <div class="field">
          <label class="field__label"
            >题型{{ types.length ? `（已选 ${types.length}）` : '（全部）' }}</label
          >
          <div class="multi-chips">
            <button
              v-for="t in allTypes"
              :key="t"
              :class="['mchip', types.includes(t) && 'mchip--active']"
              @click="!presetQuestionIds.length && toggleType(t)"
              :disabled="!!presetQuestionIds.length"
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
