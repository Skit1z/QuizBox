<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { db } from '@/db'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import {
  DIFFICULTY_LABELS,
  QUESTION_TYPE_LABELS,
  type Difficulty,
  type Question,
  type QuestionType,
} from '@/types'

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const questions = ref<Question[]>([])

const subjectId = ref((route.query.subjectId as string) || '')
const types = ref<QuestionType[]>([])
const difficulty = ref<Difficulty | ''>('')
const random = ref(true)
const onlyWrong = ref(false)

const allTypes: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']
const allDiffs: Difficulty[] = ['easy', 'medium', 'hard']

// 来自错题本的指定题目（#8：复习具体错题）
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
    // 直接用指定的错题 id
    const got = await db.questions.bulkGet(presetQuestionIds.value)
    qs = got.filter((q): q is Question => !!q)
  } else if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  } else if (onlyWrong.value) {
    const wrongs = await wrongBookRepo.listAll()
    const wrongQids = new Set(wrongs.map((w) => w.questionId))
    qs = (await questionsRepo.filter({
      subjectId: subjectId.value,
      types: types.value.length ? types.value : undefined,
      difficulty: difficulty.value || undefined,
    })).filter((q) => wrongQids.has(q.id))
  } else {
    qs = await questionsRepo.filter({
      subjectId: subjectId.value,
      types: types.value.length ? types.value : undefined,
      difficulty: difficulty.value || undefined,
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

    <div v-else style="padding: 16px">
      <div v-if="presetQuestionIds.length" class="preset-banner">
        <van-icon name="warning-o" /> 本次练习将针对 {{ presetQuestionIds.length }} 道指定错题
      </div>

      <van-cell-group inset title="练习设置">
        <van-field label="科目" is-link readonly :disabled="!!presetQuestionIds.length">
          <template #input>
            <select v-model="subjectId" :disabled="!!presetQuestionIds.length" style="border: none; flex: 1">
              <option value="">请选择</option>
              <option v-for="s in subjectsStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </template>
        </van-field>

        <van-cell title="题型">
          <div class="chips">
            <van-tag
              v-for="t in allTypes"
              :key="t"
              :type="types.includes(t) ? 'primary' : 'default'"
              class="chip"
              @click="toggleType(t)"
            >{{ QUESTION_TYPE_LABELS[t] }}</van-tag>
          </div>
        </van-cell>

        <van-cell title="难度">
          <div class="chips">
            <van-tag
              v-for="d in allDiffs"
              :key="d"
              :type="difficulty === d ? 'primary' : 'default'"
              class="chip"
              @click="difficulty = difficulty === d ? '' : d"
            >{{ DIFFICULTY_LABELS[d] }}</van-tag>
            <van-tag :type="!difficulty ? 'primary' : 'default'" class="chip" @click="difficulty = ''">不限</van-tag>
          </div>
        </van-cell>

        <van-cell title="仅错题">
          <template #right-icon>
            <van-switch v-model="onlyWrong" />
          </template>
        </van-cell>
        <van-cell title="随机顺序">
          <template #right-icon>
            <van-switch v-model="random" />
          </template>
        </van-cell>
      </van-cell-group>

      <div style="padding: 16px">
        <van-button type="primary" block @click="start">开始自测</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chip {
  cursor: pointer;
}
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
.preset-banner {
  background: var(--brand-soft);
  color: var(--brand);
  padding: var(--sp-3) var(--sp-4);
  border-radius: var(--r-md);
  font-size: 13px;
  margin-bottom: var(--sp-3);
}
</style>
