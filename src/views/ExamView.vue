<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { shuffle } from '@/utils/shuffle'
import QuizRunner from '@/components/QuizRunner.vue'
import ExamResult from '@/components/ExamResult.vue'
import type { ExamSubMode } from '@/types'
import type { Question } from '@/types'

const router = useRouter()
const subjectsStore = useSubjectsStore()

const started = ref(false)
const finished = ref(false)
const questions = ref<Question[]>([])
const result = ref<any>(null)

const subjectId = ref('')
const subMode = ref<ExamSubMode>('classic')
const count = ref(20)
const durationMin = ref(30)

const subModes: { value: ExamSubMode; label: string; desc: string }[] = [
  { value: 'classic', label: '传统限时', desc: '设定题量时长，做完交卷出分' },
  { value: 'wrong_redo', label: '错题重做', desc: '只做错题本里的题' },
  { value: 'random', label: '随机抽查', desc: '从题库随机抽题' },
  { value: 'shuffle', label: '乱序练习', desc: '题目顺序打乱' },
  { value: 'weak', label: '薄弱点加权', desc: '优先抽出错率高的题' },
]

const classicModes: ExamSubMode[] = ['classic', 'random', 'shuffle', 'weak']

async function start() {
  if (!subjectId.value) {
    showFailToast('请选择科目')
    return
  }
  const base = await questionsRepo.filter({ subjectId: subjectId.value })
  let qs: Question[] = []

  switch (subMode.value) {
    case 'wrong_redo':
    case 'weak': {
      const wrongs = await wrongBookRepo.listAll()
      const wMap = new Map(wrongs.map((w) => [w.questionId, w.reviewCount || 1]))
      if (subMode.value === 'wrong_redo') {
        qs = base.filter((q) => wMap.has(q.id))
        qs = shuffle(qs)
      } else {
        // weak：错题优先排序，带随机扰动
        qs = base
          .map((q) => ({ q, w: wMap.get(q.id) || 0, r: Math.random() }))
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
      @finish="onFinish"
    />

    <div v-else style="padding: 16px">
      <van-cell-group inset title="科目">
        <van-field label="科目" is-link readonly>
          <template #input>
            <select v-model="subjectId" style="border: none; flex: 1">
              <option value="">请选择</option>
              <option v-for="s in subjectsStore.list" :key="s.id" :value="s.id">{{ s.name }}</option>
            </select>
          </template>
        </van-field>
      </van-cell-group>

      <van-cell-group inset title="考试模式" style="margin-top: 12px">
        <van-radio-group v-model="subMode">
          <van-cell
            v-for="m in subModes"
            :key="m.value"
            clickable
            @click="subMode = m.value"
          >
            <template #title>
              <van-radio :name="m.value">
                <strong>{{ m.label }}</strong>
                <div style="font-size: 12px; color: #969799">{{ m.desc }}</div>
              </van-radio>
            </template>
          </van-cell>
        </van-radio-group>
      </van-cell-group>

      <van-cell-group inset title="题量与时长" style="margin-top: 12px">
        <van-cell title="题量">
          <van-stepper v-model="count" :min="1" :max="100" />
        </van-cell>
        <van-field label="时长(分钟)" type="digit">
          <template #input>
            <input v-model="durationMin" type="number" class="inline-input" />
          </template>
        </van-field>
      </van-cell-group>

      <div style="padding: 16px">
        <van-button type="primary" block @click="start">开始考试</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.inline-input {
  border: none;
  flex: 1;
  background: transparent;
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
</style>
