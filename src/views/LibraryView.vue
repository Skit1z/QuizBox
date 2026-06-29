<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
defineOptions({ name: 'LibraryView' })
import { showConfirmDialog, showSuccessToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { useAdminStore } from '@/stores/admin'
import { questionsRepo } from '@/db/questions'
import AdminDialog from '@/components/AdminDialog.vue'

const router = useRouter()
const subjectsStore = useSubjectsStore()
const adminStore = useAdminStore()
const newName = ref('')
const showAdd = ref(false)
const showAdminDialog = ref(false)
const pendingAction = ref<(() => void) | null>(null)

// ===== 编辑科目 =====
const SUBJECT_COLORS = [
  '#4f6bed', '#2d6a4f', '#ff6b35', '#9333ea', '#db2777',
  '#0891b2', '#ca8a04', '#dc2626', '#475569', '#16a34a',
]
const showEdit = ref(false)
const editId = ref('')
const editName = ref('')
const editColor = ref('')

function openEdit(id: string, name: string, color?: string) {
  editId.value = id
  editName.value = name
  editColor.value = color || SUBJECT_COLORS[0]
  showEdit.value = true
}

async function saveEdit() {
  const name = editName.value.trim()
  if (!name) return
  await subjectsStore.update(editId.value, { name, color: editColor.value })
  showEdit.value = false
  showSuccessToast('已保存')
}

const counts = ref<Record<string, number>>({})

async function loadCounts() {
  // 用索引 count 逐科目高效统计，避免拉全表
  const map: Record<string, number> = {}
  await Promise.all(
    subjectsStore.list.map(async (s) => {
      map[s.id] = await questionsRepo.countBySubject(s.id)
    }),
  )
  counts.value = map
}

async function refresh() {
  await subjectsStore.load()
  await loadCounts()
}

async function addSubject() {
  const name = newName.value.trim()
  if (!name) return
  await subjectsStore.create(name)
  newName.value = ''
  showAdd.value = false
  await loadCounts()
  showSuccessToast('已添加')
}

async function removeSubject(id: string, name: string) {
  await showConfirmDialog({
    title: '删除科目',
    message: `确定删除「${name}」及其所有题目？此操作可被同步撤销。`,
  })
  await subjectsStore.remove(id)
  await loadCounts()
  showSuccessToast('已删除')
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
  await refresh()
})
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div>
        <h1 class="page-title">题库</h1>
        <p class="page-sub">{{ subjectsStore.list.length }} 个科目</p>
      </div>
      <button class="fab" @click="guardedAction(() => (showAdd = true))">
        <van-icon name="plus" size="18" />
      </button>
    </div>

    <div v-if="subjectsStore.list.length === 0" class="empty">
      <van-icon name="bookmark-o" size="40" color="var(--text-3)" />
      <p class="empty__title">还没有科目</p>
      <p class="empty__desc">导入 Word 题库或手动新建</p>
      <van-button type="primary" size="small" round @click="router.push({ name: 'import' })">
        导入题库
      </van-button>
    </div>

    <div v-else class="subject-list">
      <div v-for="s in subjectsStore.list" :key="s.id" class="scroller-item-wrap">
        <van-swipe-cell class="swipe-card">
          <div
            class="subject-card card--clickable"
            @click="router.push({ name: 'subject-detail', params: { subjectId: s.id } })"
          >
            <div class="subject-card__icon" :style="{ background: s.color || 'var(--brand)' }">
              {{ s.name.slice(0, 1) }}
            </div>
            <div class="subject-card__body">
              <div class="subject-card__name">{{ s.name }}</div>
              <div class="subject-card__count">{{ counts[s.id] || 0 }} 道题</div>
            </div>
            <van-icon name="arrow" size="14" color="var(--text-3)" />
          </div>
          <template #right>
            <van-button square type="primary" text="编辑" style="height: 100%" @click="guardedAction(() => openEdit(s.id, s.name, s.color))" />
            <van-button square type="danger" text="删除" style="height: 100%" @click="guardedAction(() => removeSubject(s.id, s.name))" />
          </template>
        </van-swipe-cell>
      </div>
    </div>

    <van-dialog
      v-model:show="showAdd"
      title="新建科目"
      show-cancel-button
      @confirm="addSubject"
    >
      <van-field v-model="newName" placeholder="科目名称（如：高数）" style="margin: 12px" />
    </van-dialog>

    <van-dialog
      v-model:show="showEdit"
      title="编辑科目"
      show-cancel-button
      @confirm="saveEdit"
    >
      <div class="edit-body">
        <van-field v-model="editName" placeholder="科目名称" />
        <div class="edit-colors">
          <button
            v-for="c in SUBJECT_COLORS"
            :key="c"
            type="button"
            class="color-pick"
            :class="{ 'color-pick--active': editColor === c }"
            :style="{ background: c }"
            @click="editColor = c"
          ></button>
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
  margin: 0 0 var(--sp-4);
}
.subject-list {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.subject-card {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
}
.subject-card__icon {
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  color: #fff;
  font-weight: 700;
  font-size: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.subject-card__body {
  flex: 1;
}
.subject-card__name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.subject-card__count {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.edit-body {
  padding: var(--sp-4) var(--sp-5);
}
.edit-colors {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
.color-pick {
  width: 32px;
  height: 32px;
  border-radius: var(--r-full);
  border: 3px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
}
.color-pick--active {
  border-color: var(--surface);
  box-shadow: 0 0 0 2px currentColor;
}
</style>
