<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import AdminDialog from '@/components/AdminDialog.vue'
import { useDocsStore } from '@/stores/docs'
import { useAdminStore } from '@/stores/admin'
import { hasWriteAuth } from '@/services/docs-api'
import { fmtSize } from '@/utils/format'

defineOptions({ name: 'DocsView' })

const MAX_SIZE = 4 * 1024 * 1024

const router = useRouter()
const store = useDocsStore()
const adminStore = useAdminStore()

const uploading = ref(false)
const uploadPhase = ref('')
const refreshing = ref(false)

// 管理员鉴权(复用 SubjectDetailView.vue 的 guardedAction 模式)
const showAdminDialog = ref(false)
const pendingAction = ref<(() => void) | null>(null)

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

async function onFileRead(fileItem: any) {
  const file: File = fileItem.file || fileItem
  if (file.size > MAX_SIZE) {
    showFailToast('文件超过 4MB 限制')
    return
  }
  if (!hasWriteAuth()) {
    showFailToast('请先在设置页配置云题库密钥')
    return
  }
  uploading.value = true
  uploadPhase.value = '解析中…'
  try {
    await store.upload(file, (phase, detail) => {
      uploadPhase.value = phase === 'parsing' ? '解析中…' : detail || '上传图片…'
    })
    showSuccessToast('上传成功')
  } catch (e: any) {
    showFailToast(e?.message || '上传失败')
  } finally {
    uploading.value = false
    uploadPhase.value = ''
  }
}

function openDoc(id: string) {
  router.push({ name: 'doc-reader', params: { id } })
}

function removeDoc(id: string) {
  guardedAction(async () => {
    try {
      await store.remove(id)
      showSuccessToast('已删除')
    } catch (e: any) {
      showFailToast(e?.message || '删除失败')
    }
  })
}

async function onRefresh() {
  refreshing.value = true
  try {
    await store.loadList()
  } catch {
    showFailToast('刷新失败')
  } finally {
    refreshing.value = false
  }
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(async () => {
  await adminStore.load()
  await store.loadList().catch(() => {
    // 静默失败,空态由列表展示
  })
})
</script>

<template>
  <div class="docs-page">
    <div class="page-head">
      <h1 class="page-title">资料</h1>
      <p class="page-sub">上传 Word / Markdown 文档,随时阅读</p>
    </div>

    <!-- 上传区 -->
    <div class="upload-area">
      <van-uploader
        :after-read="onFileRead"
        :max-size="MAX_SIZE"
        accept=".docx,.md"
        :max-count="1"
        :disabled="uploading"
        @oversize="() => showFailToast('文件超过 4MB 限制')"
      >
        <van-button icon="plus" type="primary" round :loading="uploading" :loading-text="uploadPhase">
          上传文档
        </van-button>
      </van-uploader>
      <p v-if="!hasWriteAuth()" class="upload-hint">
        上传需配置密钥,请前往
        <router-link to="/settings">设置页</router-link>
      </p>
    </div>

    <!-- 文档列表 -->
    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <van-loading v-if="store.loading && !store.list.length" class="list-loading" type="spinner" />
      <van-empty
        v-else-if="!store.list.length"
        description="还没有资料,点击上方上传你的第一份文档"
      />
      <div v-else class="doc-list">
        <van-swipe-cell v-for="doc in store.list" :key="doc.id">
          <van-cell class="doc-cell" :title="doc.name" @click="openDoc(doc.id)">
            <template #label>
              <span class="doc-meta">
                <van-icon :name="doc.ext === 'md' ? 'description-o' : 'description'" />
                {{ fmtSize(doc.htmlSize) }}
                <span v-if="doc.imageCount">· {{ doc.imageCount }} 图</span>
                · {{ fmtDate(doc.uploadedAt) }}
              </span>
            </template>
            <template #right-icon>
              <van-icon name="arrow" class="doc-arrow" />
            </template>
          </van-cell>
          <template #right>
            <van-button square type="danger" text="删除" class="del-btn" @click="removeDoc(doc.id)" />
          </template>
        </van-swipe-cell>
      </div>
    </van-pull-refresh>

    <!-- 管理员验证弹窗 -->
    <AdminDialog v-model:show="showAdminDialog" @verified="onAdminVerified" />
  </div>
</template>

<style scoped>
.docs-page {
  padding: var(--sp-3);
}
.page-head {
  padding: var(--sp-4) var(--sp-2) var(--sp-3);
}
.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
}
.page-sub {
  margin-top: var(--sp-1);
  font-size: 13px;
  color: var(--text-2);
}
.upload-area {
  padding: var(--sp-3) var(--sp-2);
}
.upload-hint {
  margin-top: var(--sp-2);
  font-size: 12px;
  color: var(--text-3);
}
.upload-hint a {
  color: var(--brand);
}
.list-loading {
  display: flex;
  justify-content: center;
  padding: var(--sp-8);
}
.doc-list {
  margin-top: var(--sp-2);
}
.doc-cell {
  align-items: center;
}
.doc-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.doc-arrow {
  color: var(--text-3);
}
.del-btn {
  height: 100%;
}
</style>
