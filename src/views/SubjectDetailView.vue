<script setup lang="ts">
import { computed, ref, onMounted } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showConfirmDialog, showFailToast, showSuccessToast } from 'vant'
import { questionsRepo } from '@/db/questions'
import { useSubjectsStore } from '@/stores/subjects'
import { useAdminStore } from '@/stores/admin'
import QuestionCard from '@/components/QuestionCard.vue'
import ThemedSelect from '@/components/ThemedSelect.vue'
import AdminDialog from '@/components/AdminDialog.vue'
import ActionPopover from '@/components/ActionPopover.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import { DynamicScroller, DynamicScrollerItem } from 'vue-virtual-scroller'
import 'vue-virtual-scroller/dist/vue-virtual-scroller.css'
import { QUESTION_TYPE_LABELS, type Question, type QuestionType } from '@/types'

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()
const adminStore = useAdminStore()

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
const showAdminDialog = ref(false)
const pendingAction = ref<(() => void) | null>(null)

// 题目操作气泡菜单
const showPopoverMap = ref<Record<string, boolean>>({})

// ===== 编辑题目 =====
const showEdit = ref(false)
const editId = ref('')
const editType = ref<QuestionType>('single')
const editStem = ref('')
const editOptions = ref<string[]>([])
const editAnswer = ref('')
const editAnalysis = ref('')
const editSaving = ref(false)

const editTypeOptions = computed<SelectOption[]>(() =>
  Object.entries(QUESTION_TYPE_LABELS).map(([value, label]) => ({ value, label })),
)

/** 判断题、单选、多选使用字母选项作为答案；填空/简答/论述为自由文本 */
function isChoiceLike(t: QuestionType): boolean {
  return t === 'single' || t === 'multiple' || t === 'judge'
}

function openEdit(q: Question) {
  editId.value = q.id
  editType.value = q.type
  editStem.value = q.stem || ''
  editOptions.value = q.options ? [...q.options] : []
  const a = q.answer
  if (isChoiceLike(q.type)) {
    editAnswer.value = Array.isArray(a) ? a.join('') : String(a ?? '')
  } else {
    editAnswer.value = Array.isArray(a) ? a.join('\n') : String(a ?? '')
  }
  editAnalysis.value = q.analysis || ''
  showEdit.value = true
}

function onEditTypeChange(t: string) {
  editType.value = t as QuestionType
  // 切到判断题时重置默认选项与答案
  if (t === 'judge') {
    editOptions.value = ['正确', '错误']
    if (!['T', 'F'].includes(editAnswer.value)) editAnswer.value = 'T'
  } else if (!isChoiceLike(t as QuestionType)) {
    editAnswer.value = ''
  } else if (t === 'single' || t === 'multiple') {
    // 还原选项（若之前被清空，给 4 个空选项）
    if (editOptions.value.length === 0 || editOptions.value.length === 2) {
      editOptions.value = ['', '', '', '']
    }
    editAnswer.value = ''
  }
}

function addOption() {
  editOptions.value.push('')
}

function removeOption(i: number) {
  // 至少保留 2 个选项（单选/多选）
  if (editOptions.value.length <= 2) return
  editOptions.value.splice(i, 1)
}

async function saveEdit() {
  const stem = editStem.value.trim()
  if (!stem) {
    showFailToast('请输入题干')
    return
  }
  if (editSaving.value) return
  editSaving.value = true
  try {
    const type = editType.value
    let answer: string | string[]
    if (type === 'multiple') {
      // 多选答案：去重保留顺序，如 "AC" → ['A','C']
      answer = Array.from(new Set(editAnswer.value.toUpperCase().split('').filter((c) => /[A-Z]/.test(c))))
      if (!answer.length) {
        showFailToast('请填写答案（如 AC）')
        return
      }
    } else if (type === 'judge') {
      answer = editAnswer.value.toUpperCase().startsWith('F') ? 'F' : 'T'
    } else if (isChoiceLike(type)) {
      answer = editAnswer.value.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 1)
      if (!answer) {
        showFailToast('请填写答案字母')
        return
      }
    } else {
      // 填空：按行拆为多个空；简答/论述：单个字符串
      const lines = editAnswer.value.split('\n').map((s) => s.trim()).filter(Boolean)
      answer = type === 'fill' ? (lines.length > 1 ? lines : (lines[0] || '')) : editAnswer.value.trim()
      if (!answer || (Array.isArray(answer) && !answer.length)) {
        showFailToast('请填写答案')
        return
      }
    }
    const patch: Partial<{ type: QuestionType; stem: string; options?: string[]; answer: string | string[]; analysis: string }> = {
      type,
      stem,
      answer,
      analysis: editAnalysis.value.trim(),
    }
    if (type === 'single' || type === 'multiple') {
      patch.options = editOptions.value.map((o) => o.trim())
      if (patch.options.some((o) => !o)) {
        showFailToast('选项不能为空')
        return
      }
    }
    await questionsRepo.update(editId.value, patch)
    showEdit.value = false
    showSuccessToast('已保存')
    await load()
  } finally {
    editSaving.value = false
  }
}

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

/** 尝试执行受保护操作，未验证则弹出密码弹窗 */
function guardedAction(action: () => void) {
  if (adminStore.canOperate()) {
    action()
  } else {
    pendingAction.value = action
    showAdminDialog.value = true
  }
}

function onAdminVerified() {
  if (pendingAction.value) {
    pendingAction.value()
    pendingAction.value = null
  }
}

onMounted(async () => {
  await adminStore.load()
  await load()
})
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
        <button class="icon-btn" @click="guardedAction(toggleManage)">
          <van-icon :name="managing ? 'cross' : 'records-o'" size="18" />
        </button>
        <button class="fab" @click="guardedAction(() => router.push({ name: 'import', query: { subjectId } }))">
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
          <van-button size="small" plain round @click="guardedAction(openMove)">移动</van-button>
          <van-button size="small" type="danger" plain round @click="guardedAction(batchRemove)">删除</van-button>
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
      <div
        v-for="(q, i) in filteredQuestions"
        :key="q.id"
        class="scroller-item-wrap"
      >
        <van-swipe-cell
          class="swipe-card"
          :class="{ 'swipe-card--selected': managing && selectedIds.includes(q.id) }"
          @click="managing ? toggleSelect(q.id) : null"
        >
          <QuestionCard :question="q" :index="i" :show-answer="true" :highlight="focusId === q.id">
            <template #action>
              <ActionPopover
                v-model:show="showPopoverMap[q.id]"
                :actions="[
                  { text: '编辑题目', icon: 'edit', callback: () => openEdit(q) },
                  { text: '删除题目', icon: 'delete-o', className: 'popover-danger-action', callback: () => removeQuestion(q.id) },
                ]"
                :disabled="!adminStore.canOperate()"
                @click-disabled="guardedAction(() => { showPopoverMap[q.id] = true })"
              >
                <button class="q-action-btn" @click.stop>
                  <van-icon name="ellipsis" size="16" />
                </button>
              </ActionPopover>
            </template>
          </QuestionCard>
          <template #right>
            <van-button square type="primary" text="编辑" style="height: 100%" @click.stop="guardedAction(() => openEdit(q))" />
            <van-button square type="danger" text="删除" style="height: 100%" @click.stop="guardedAction(() => removeQuestion(q.id))" />
          </template>
        </van-swipe-cell>
      </div>
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
          <div class="scroller-item-wrap">
            <van-swipe-cell
              class="swipe-card"
              :class="{ 'swipe-card--selected': managing && selectedIds.includes(item.id) }"
              @click="managing ? toggleSelect(item.id) : null"
            >
              <QuestionCard :question="item" :index="index" :show-answer="true" :highlight="focusId === item.id">
                <template #action>
                  <ActionPopover
                    v-model:show="showPopoverMap[item.id]"
                    :actions="[
                      { text: '编辑题目', icon: 'edit', callback: () => openEdit(item) },
                      { text: '删除题目', icon: 'delete-o', className: 'popover-danger-action', callback: () => removeQuestion(item.id) },
                    ]"
                    :disabled="!adminStore.canOperate()"
                    @click-disabled="guardedAction(() => { showPopoverMap[item.id] = true })"
                  >
                    <button class="q-action-btn" @click.stop>
                      <van-icon name="ellipsis" size="16" />
                    </button>
                  </ActionPopover>
                </template>
              </QuestionCard>
              <template #right>
                <van-button square type="primary" text="编辑" style="height: 100%" @click.stop="guardedAction(() => openEdit(item))" />
                <van-button square type="danger" text="删除" style="height: 100%" @click.stop="guardedAction(() => removeQuestion(item.id))" />
              </template>
            </van-swipe-cell>
          </div>
        </DynamicScrollerItem>
      </template>
    </DynamicScroller>

    <van-dialog v-model:show="showMove" title="移动到科目" show-cancel-button @confirm="batchMove">
      <div class="dialog-body">
        <ThemedSelect v-model="targetSubjectId" :options="moveSubjectOptions" placeholder="选择目标科目" />
      </div>
    </van-dialog>

    <!-- 编辑题目 -->
    <van-dialog
      v-model:show="showEdit"
      title="编辑题目"
      show-cancel-button
      :confirm-button-text="editSaving ? '保存中…' : '保存'"
      :before-close="
        (action: string) => {
          if (action === 'confirm') {
            void saveEdit()
            return false
          }
          return true
        }
      "
    >
      <div class="edit-q">
        <div class="edit-q__field">
          <label class="edit-q__label">题型</label>
          <ThemedSelect
            :model-value="editType"
            :options="editTypeOptions"
            placeholder="选择题型"
            @change="onEditTypeChange"
          />
        </div>
        <div class="edit-q__field">
          <label class="edit-q__label">题干</label>
          <textarea
            v-model="editStem"
            class="edit-q__textarea"
            rows="3"
            placeholder="题干内容（支持纯文本）"
          ></textarea>
        </div>
        <!-- 选项（单选/多选） -->
        <template v-if="editType === 'single' || editType === 'multiple'">
          <div class="edit-q__field">
            <label class="edit-q__label">选项</label>
            <div
              v-for="(opt, i) in editOptions"
              :key="i"
              class="edit-q__option"
            >
              <span class="edit-q__option-key">{{ String.fromCharCode(65 + i) }}</span>
              <input v-model="editOptions[i]" class="edit-q__input" :placeholder="`选项 ${String.fromCharCode(65 + i)}`" />
              <button
                v-if="editOptions.length > 2"
                type="button"
                class="edit-q__option-del"
                @click="removeOption(i)"
              >
                <van-icon name="cross" size="14" />
              </button>
            </div>
            <van-button size="small" plain round @click="addOption">添加选项</van-button>
          </div>
        </template>
        <div class="edit-q__field">
          <label class="edit-q__label">
            答案
            <span class="edit-q__hint">
              {{
                editType === 'multiple' ? '（如 AC，多选填字母）' :
                editType === 'judge' ? '（T 正确 / F 错误）' :
                editType === 'fill' ? '（多个空用换行分隔）' : ''
              }}
            </span>
          </label>
          <textarea
            v-model="editAnswer"
            class="edit-q__textarea"
            :rows="editType === 'fill' || editType === 'short' || editType === 'essay' ? 3 : 1"
            :placeholder="editType === 'single' ? '答案字母，如 A' : editType === 'multiple' ? '答案字母，如 ACD' : '答案'"
          ></textarea>
        </div>
        <div class="edit-q__field">
          <label class="edit-q__label">解析</label>
          <textarea
            v-model="editAnalysis"
            class="edit-q__textarea"
            rows="2"
            placeholder="解析（可选）"
          ></textarea>
        </div>
      </div>
    </van-dialog>

    <AdminDialog
      v-model:show="showAdminDialog"
      @verified="onAdminVerified"
    />

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
.q-action-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: transparent;
  color: var(--text-3);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  border-radius: var(--r-sm);
  transition: background 0.15s;
}
.q-action-btn:hover {
  background: var(--surface-2);
  color: var(--text);
}
.edit-q {
  padding: var(--sp-4) var(--sp-5);
  max-height: 60vh;
  overflow-y: auto;
}
.edit-q__field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: var(--sp-3);
}
.edit-q__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}
.edit-q__hint {
  font-size: 11px;
  color: var(--text-3);
  font-weight: 400;
  margin-left: 4px;
}
.edit-q__textarea,
.edit-q__input {
  width: 100%;
  padding: 8px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.15s;
  font-family: inherit;
}
.edit-q__textarea {
  resize: vertical;
  line-height: 1.5;
}
.edit-q__textarea:focus,
.edit-q__input:focus {
  border-color: var(--brand);
}
.edit-q__option {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.edit-q__option-key {
  width: 22px;
  height: 22px;
  border-radius: var(--r-full);
  background: var(--brand-soft);
  color: var(--brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 11px;
  font-weight: 700;
  flex-shrink: 0;
}
.edit-q__option-del {
  width: 24px;
  height: 24px;
  border: none;
  background: var(--surface-2);
  color: var(--text-3);
  border-radius: var(--r-full);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
</style>
