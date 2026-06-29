<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant'
import { questionsRepo } from '@/db/questions'
import { useSubjectsStore } from '@/stores/subjects'
import QuestionCard from '@/components/QuestionCard.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { QUESTION_TYPE_LABELS, type Question, type QuestionType } from '@/types'

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const subjectId = route.params.subjectId as string
const focusId = (route.query.focus as string) || ''
const questions = ref<Question[]>([])
const loading = ref(true)
const subjectName = ref('')
const keyword = ref('')
const typeFilter = ref<QuestionType | ''>('')
const managing = ref(false)
const selectedIds = ref<string[]>([])
const showMove = ref(false)
const targetSubjectId = ref('')

const typeOptions = computed<SelectOption[]>(() => [
  { value: '', label: '全部题型' },
  ...Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => ({ value, label })),
])

const moveSubjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list
    .filter((s) => s.id !== subjectId)
    .map((s) => ({ value: s.id, label: s.name })),
)

const filteredQuestions = computed(() => {
  const kw = keyword.value.trim().toLowerCase()
  return questions.value.filter((q) => {
    if (typeFilter.value && q.type !== typeFilter.value) return false
    if (!kw) return true
    return (
      q.stem.toLowerCase().includes(kw) ||
      (q.analysis || '').toLowerCase().includes(kw) ||
      (q.options || []).some((o) => o.toLowerCase().includes(kw))
    )
  })
})

const selectedCount = computed(() => selectedIds.value.length)

async function load() {
  loading.value = true
  const [qs, sub] = await Promise.all([
    questionsRepo.listBySubject(subjectId),
    subjectsStore.load(),
  ])
  questions.value = qs
  subjectName.value = subjectsStore.list.find((s) => s.id === subjectId)?.name || ''
  selectedIds.value = selectedIds.value.filter((id) => qs.some((q) => q.id === id))
  loading.value = false
}

async function removeQuestion(id: string) {
  await showConfirmDialog({ title: '删除题目', message: '确定删除这道题？' })
  await questionsRepo.remove(id)
  showSuccessToast('已删除')
  await load()
}

function toggleManage() {
  managing.value = !managing.value
  if (!managing.value) selectedIds.value = []
}

function toggleSelect(id: string) {
  const i = selectedIds.value.indexOf(id)
  if (i >= 0) selectedIds.value.splice(i, 1)
  else selectedIds.value.push(id)
}

function selectVisible() {
  selectedIds.value = filteredQuestions.value.map((q) => q.id)
}

async function batchRemove() {
  if (!selectedCount.value) {
    showFailToast('请先选择题目')
    return
  }
  await showConfirmDialog({
    title: '删除题目',
    message: `确定删除选中的 ${selectedCount.value} 道题？`,
  })
  await questionsRepo.removeBulk(selectedIds.value)
  selectedIds.value = []
  showSuccessToast('已删除')
  await load()
}

function openMove() {
  if (!selectedCount.value) {
    showFailToast('请先选择题目')
    return
  }
  if (moveSubjectOptions.value.length === 0) {
    showFailToast('暂无可移动的目标科目')
    return
  }
  targetSubjectId.value = moveSubjectOptions.value[0]?.value || ''
  showMove.value = true
}

async function batchMove() {
  if (!targetSubjectId.value || !selectedCount.value) return
  await questionsRepo.moveToSubject(selectedIds.value, targetSubjectId.value)
  selectedIds.value = []
  showMove.value = false
  showSuccessToast('已移动')
  await load()
}

function practiceSelected() {
  if (!selectedCount.value) {
    showFailToast('请先选择题目')
    return
  }
  router.push({ name: 'practice', query: { questionIds: selectedIds.value.join(',') } })
}

onMounted(load)
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <div>
          <h1 class="page-title page-title--sm">{{ subjectName || '题目列表' }}</h1>
          <p class="page-sub">{{ questions.length }} 道题</p>
        </div>
      </div>
      <div class="head-actions">
        <button class="icon-btn" @click="toggleManage">
          <van-icon :name="managing ? 'cross' : 'records-o'" size="18" />
        </button>
        <button class="fab" @click="router.push({ name: 'import', query: { subjectId } })">
          <van-icon name="add-o" size="18" />
        </button>
      </div>
    </div>

    <div v-if="questions.length" class="manage-panel">
      <van-search v-model="keyword" placeholder="搜索题干、选项、解析" shape="round" />
      <ThemedSelect v-model="typeFilter" :options="typeOptions" placeholder="全部题型" />
      <div v-if="managing" class="batch-bar">
        <span>已选 {{ selectedCount }} / {{ filteredQuestions.length }}</span>
        <div class="batch-bar__actions">
          <van-button size="small" plain round @click="selectVisible">全选当前</van-button>
          <van-button size="small" type="primary" plain round @click="practiceSelected">自测</van-button>
          <van-button size="small" plain round @click="openMove">移动</van-button>
          <van-button size="small" type="danger" plain round @click="batchRemove">删除</van-button>
        </div>
      </div>
    </div>

    <div v-if="loading" style="padding: var(--sp-8); text-align: center">
      <van-loading size="24" />
    </div>

    <div v-else-if="questions.length === 0" class="empty">
      <van-icon name="notes-o" size="40" color="var(--text-3)" />
      <p class="empty__title">还没有题目</p>
      <p class="empty__desc">点击右上角导入 Word 题库</p>
    </div>

    <div v-else-if="filteredQuestions.length === 0" class="empty">
      <van-icon name="search" size="40" color="var(--text-3)" />
      <p class="empty__title">没有匹配题目</p>
      <p class="empty__desc">换一个关键词或题型再试</p>
    </div>

    <!-- 题量大时用虚拟滚动；少量时直接渲染 -->
    <div v-else-if="filteredQuestions.length <= 30">
      <van-swipe-cell v-for="(q, i) in filteredQuestions" :key="q.id" class="swipe-card">
        <div class="question-row">
          <van-checkbox
            v-if="managing"
            :model-value="selectedIds.includes(q.id)"
            @update:model-value="() => toggleSelect(q.id)"
          />
          <QuestionCard :question="q" :index="i" :show-answer="true" :highlight="focusId === q.id" />
        </div>
        <template #right>
          <van-button square type="danger" text="删除" style="height: 100%" @click="removeQuestion(q.id)" />
        </template>
      </van-swipe-cell>
    </div>

    <DynamicScroller
      v-else
      :items="filteredQuestions"
      :min-item-size="160"
      key-field="id"
      style="height: calc(100vh - 130px)"
    >
      <template #default="{ item, index, active }">
        <DynamicScrollerItem :item="item" :active="active" :data-index="index">
          <van-swipe-cell class="swipe-card">
            <div class="question-row">
              <van-checkbox
                v-if="managing"
                :model-value="selectedIds.includes(item.id)"
                @update:model-value="() => toggleSelect(item.id)"
              />
              <QuestionCard :question="item" :index="index" :show-answer="true" :highlight="focusId === item.id" />
            </div>
            <template #right>
              <van-button square type="danger" text="删除" style="height: 100%" @click="removeQuestion(item.id)" />
            </template>
          </van-swipe-cell>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>

    <van-dialog v-model:show="showMove" title="移动到科目" show-cancel-button @confirm="batchMove">
      <div class="dialog-body">
        <ThemedSelect v-model="targetSubjectId" :options="moveSubjectOptions" placeholder="选择目标科目" />
      </div>
    </van-dialog>
  </div>
</template>

<style scoped>
.page-head--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
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
.fab {
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  border: none;
  background: var(--brand);
  color: #fff;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  box-shadow: var(--shadow-brand);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.icon-btn {
  width: 40px;
  height: 40px;
  border-radius: var(--r-full);
  border: 1px solid var(--border-strong);
  background: var(--surface);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.manage-panel {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-bottom: var(--sp-4);
}
.manage-panel :deep(.van-search) {
  padding: 0;
  background: transparent;
}
.batch-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--border);
  border-radius: var(--r-md);
  background: var(--surface);
  color: var(--text-2);
  font-size: 13px;
}
.batch-bar__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--sp-2);
}
.question-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: start;
  gap: var(--sp-3);
}
.question-row > :only-child {
  grid-column: 1 / -1;
}
.question-row :deep(.question-card) {
  min-width: 0;
}
.dialog-body {
  padding: var(--sp-4);
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: var(--sp-8) var(--sp-4);
  text-align: center;
  gap: var(--sp-2);
}
.empty__title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
  margin: var(--sp-3) 0 0;
}
.empty__desc {
  font-size: 13px;
  color: var(--text-3);
  margin: 0;
}
</style>
