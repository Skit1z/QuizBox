<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showSuccessToast, showFailToast } from 'vant'
import {
  useSettingsStore,
  type AiSettings,
  type WebdavSettings,
  type BankSyncSettings,
} from '@/stores/settings'
import { useSyncStore } from '@/stores/sync'
import { useAdminStore } from '@/stores/admin'
import { AI_PROVIDERS, findProvider } from '@/services/ai-providers'
import { THEME_COLORS, type ThemeColor } from '@/themes/tokens'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'

const settings = useSettingsStore()
const syncStore = useSyncStore()
const adminStore = useAdminStore()
const router = useRouter()
const ai = ref<AiSettings>({ ...settings.ai })
const webdav = ref<WebdavSettings>({ ...settings.webdav })
// WebDAV 默认折叠，仅在已启用时默认展开
const webdavExpanded = ref(false)
const bank = ref<BankSyncSettings>({ ...settings.bankSync })
const bankTesting = ref(false)
const bankSyncing = ref(false)
const bankResult = ref<{ type: 'success' | 'error'; msg: string } | null>(null)
// 版本号由 vite define 在构建期从 package.json 注入
const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

const showHistory = ref(false)
const updateHistory = [
  {
    version: '1.6.2',
    date: '2026-06-29',
    logs: [
      '管理菜单改版：重构科目和题目编辑菜单为气泡弹出框（Popover），支持鉴权及外部自动关闭',
      '考试模式改版：整合设置到单卡片，支持“单选/多选/判断/简答”等多题型合并筛选出题',
      '主题系统升级：新增极光紫、珊瑚红、青瓷绿、樱花粉四套高品质主题，可选配色增至 7 种',
      '布局细节微调：缩小题库列表上下卡片间距，整体排版更加精致紧凑',
      '暗黑模式重塑：修复答题结果、测试连接等 plain 镂空按钮以及弹出气泡白底白字问题',
      '桌面端布局优化：优化 PC 做题页布局，答题卡展开不再强行挤压做题区域',
      '同步安全加固：解决多设备同步时可能意外导致本地管理员密码丢失的问题',
    ],
  },
  {
    version: '1.6.0',
    date: '2026-06-28',
    logs: [
      '同步架构升级：支持按科目分片进行 SHA-256 哈希增量云端同步，管理员密码哈希跨端共享',
      '功能完善：支持快捷对已导入的科目、题目进行二次编辑和删除',
      '安全鉴权：引入操作管理员拦截机制，增加管理员授权校验 Dialog 弹窗',
      '体验优化：默认启用云端题库同步，将本地练习与进度分离保存',
    ],
  },
  {
    version: '1.5.0',
    date: '2026-06-25',
    logs: [
      '同步优化：支持私有云端 Blob snapshot 分片备份与快速恢复',
      '细节打磨：适配移动端状态同步流程，解决弹出窗口自适应样式裁剪问题',
      '体验优化：精简主页模块，默认折叠并隐藏不常用的 WebDAV 高阶配置',
    ],
  },
  {
    version: '1.4.0',
    date: '2026-06-20',
    logs: [
      '基础核心构建：实现 Word/Excel 题库一键智能解析与导入',
      '核心功能：开发卡片练习、自测评估、随机抽题、错题本与自测记录等模块',
      'UI 适配：引入克制蓝灰、温和墨绿、活力橙等基础主题，支持系统级黑暗模式',
    ],
  },
]

// ===== 管理密码 =====
const adminLoginPwd = ref('')
const adminNewPwd = ref('')
const adminConfirmPwd = ref('')
const adminPulling = ref(false)
const forceSyncing = ref(false)

/** 从云端同步管理员密码（拉取 meta 分片后 applyRemoteHash 生效） */
async function pullAdminFromCloud() {
  if (adminPulling.value) return
  adminPulling.value = true
  try {
    const { syncBank } = await import('@/services/sync')
    const res = await syncBank()
    if (res.ok) {
      showSuccessToast(adminStore.hasPassword ? '已同步云端管理员密码' : '云端未设置管理员密码')
    } else {
      showFailToast(res.error || '同步失败')
    }
  } finally {
    adminPulling.value = false
  }
}

/** 未设密码时：设置初始密码 */
async function setAdminPassword() {
  const pwd = adminNewPwd.value.trim()
  const confirm = adminConfirmPwd.value.trim()
  if (!pwd) {
    showFailToast('请输入密码')
    return
  }
  if (pwd !== confirm) {
    showFailToast('两次输入不一致')
    return
  }
  await adminStore.setPassword(pwd)
  adminNewPwd.value = ''
  adminConfirmPwd.value = ''
  showSuccessToast('管理密码已设置')
}

/** 已设密码但未登录：用密码登录 */
async function loginAdmin() {
  const pwd = adminLoginPwd.value.trim()
  if (!pwd) {
    showFailToast('请输入密码')
    return
  }
  const ok = await adminStore.verify(pwd)
  if (!ok) {
    showFailToast('密码错误')
    return
  }
  adminLoginPwd.value = ''
  showSuccessToast('已登入管理员')
}

/** 已登录管理员：修改密码 */
async function changeAdminPassword() {
  const pwd = adminNewPwd.value.trim()
  const confirm = adminConfirmPwd.value.trim()
  if (!pwd) {
    showFailToast('请输入新密码')
    return
  }
  if (pwd !== confirm) {
    showFailToast('两次输入不一致')
    return
  }
  await adminStore.setPassword(pwd)
  adminNewPwd.value = ''
  adminConfirmPwd.value = ''
  showSuccessToast('管理密码已更新')
}

async function requestForceSync() {
  if (forceSyncing.value) return
  if (!adminStore.canOperate()) {
    showFailToast('请先登入管理员')
    return
  }
  const saved = await saveBank()
  if (!saved) return
  forceSyncing.value = true
  try {
    const { requestBankForceSync } = await import('@/services/sync')
    await requestBankForceSync()
    showSuccessToast('已发布同步指令')
  } catch (e: any) {
    showFailToast(e?.message || '发布失败')
  } finally {
    forceSyncing.value = false
  }
}

const currentProvider = computed(
  () => findProvider(ai.value.providerId) || AI_PROVIDERS[AI_PROVIDERS.length - 1],
)
const isCustom = computed(() => currentProvider.value.custom)

const providerOptions = computed<SelectOption[]>(() =>
  AI_PROVIDERS.map((p) => ({ value: p.id, label: p.label })),
)
const modelOptions = computed<SelectOption[]>(() => {
  if (currentProvider.value.models?.length) {
    return currentProvider.value.models.map((m) => ({ value: m, label: m }))
  }
  return []
})

function onSelectProvider(id: string) {
  const p = findProvider(id)
  if (!p) return
  const wasCustom = isCustom.value
  ai.value.providerId = id
  ai.value.baseUrl = p.baseUrl
  if (p.model && (wasCustom || !ai.value.model || ai.value.model === currentProvider.value.model)) {
    ai.value.model = p.model
  }
}

async function saveAi() {
  if (!ai.value.apiKey.trim()) {
    showFailToast('请填写 API Key')
    return
  }
  if (isCustom.value && !ai.value.baseUrl.trim()) {
    showFailToast('自定义供应商需填写 Base URL')
    return
  }
  await settings.saveAi(ai.value)
  showSuccessToast('AI 设置已保存')
}

const testing = ref(false)
// 检测结果状态行：type=success|error|空，msg=展示文本
const testResult = ref<{ type: 'success' | 'error'; msg: string } | null>(null)
async function testModel() {
  if (testing.value) return
  if (!ai.value.apiKey.trim()) {
    testResult.value = { type: 'error', msg: '请先填写 API Key' }
    return
  }
  if (isCustom.value && !ai.value.baseUrl.trim()) {
    testResult.value = { type: 'error', msg: '请先填写 Base URL' }
    return
  }
  testing.value = true
  testResult.value = null
  try {
    const { testConnection } = await import('@/services/ai')
    await testConnection({
      baseUrl: ai.value.baseUrl,
      apiKey: ai.value.apiKey,
      model: ai.value.model,
    })
    testResult.value = { type: 'success', msg: '连接成功' }
  } catch {
    testResult.value = { type: 'error', msg: '连接失败' }
  } finally {
    testing.value = false
  }
}

async function saveWebdav() {
  await settings.saveWebdav(webdav.value)
  showSuccessToast('同步设置已保存')
}

const wdTesting = ref(false)
const wdResult = ref<{ type: 'success' | 'error'; msg: string } | null>(null)
async function testWebdav() {
  if (wdTesting.value) return
  if (!webdav.value.url) {
    wdResult.value = { type: 'error', msg: '请先填写服务器地址' }
    return
  }
  wdTesting.value = true
  wdResult.value = null
  try {
    const { testWebdav: test } = await import('@/services/sync')
    await test({
      url: webdav.value.url,
      username: webdav.value.username,
      password: webdav.value.password,
    })
    wdResult.value = { type: 'success', msg: '连接成功' }
  } catch (e: any) {
    const msg = e?.message || '连接失败'
    if (/401|403|unauthorized|auth/i.test(msg)) {
      wdResult.value = { type: 'error', msg: '认证失败：账号或密码错误' }
    } else if (/404|not found/i.test(msg)) {
      wdResult.value = { type: 'error', msg: '地址不存在：请检查服务器地址' }
    } else if (/cors|fetch|network/i.test(msg)) {
      wdResult.value = { type: 'error', msg: '网络错误：地址不通或服务不支持跨域' }
    } else {
      wdResult.value = { type: 'error', msg: '连接失败' }
    }
  } finally {
    wdTesting.value = false
  }
}

async function manualSync() {
  if (!webdav.value.enabled || !webdav.value.url) {
    showFailToast('请先启用同步并填写地址')
    return
  }
  const res = await syncStore.run()
  if (res.ok) showSuccessToast(`同步成功：拉取 ${res.pulled}，推送 ${res.pushed}`)
  else showFailToast('同步失败，请检查 WebDAV 设置')
}

async function saveBank() {
  if (/^vercel_blob_rw_/i.test(bank.value.key.trim())) {
    bankResult.value = {
      type: 'error',
      msg: '这里不能填写 BLOB_READ_WRITE_TOKEN；它只应配置在 Vercel 环境变量中。',
    }
    showFailToast('共享密钥不能使用 Blob Token')
    return false
  }
  await settings.saveBankSync({
    enabled: bank.value.enabled,
    key: bank.value.key.trim(),
  })
  showSuccessToast('云端题库设置已保存')
  return true
}

async function testBank() {
  if (bankTesting.value) return
  if (/^vercel_blob_rw_/i.test(bank.value.key.trim())) {
    bankResult.value = {
      type: 'error',
      msg: '共享密钥不是 Blob Token。若未在 Vercel 配置 BANK_KEY，这里请留空。',
    }
    return
  }
  bankTesting.value = true
  bankResult.value = null
  try {
    const { testBankSync } = await import('@/services/sync')
    const meta = await testBankSync({ key: bank.value.key.trim() })
    const rows = meta.tableCounts
      ? Object.values(meta.tableCounts).reduce((sum, n) => sum + Number(n || 0), 0)
      : 0
    bankResult.value = {
      type: 'success',
      msg: meta.exists
        ? `接口连通，云端已有 ${rows} 条记录（${meta.size || 0} B）`
        : '接口连通，但云端还没有题库快照',
    }
  } catch (e: any) {
    bankResult.value = { type: 'error', msg: e?.message || '接口不可用' }
  } finally {
    bankTesting.value = false
  }
}

async function manualBankSync() {
  if (bankSyncing.value) return
  // 先确保已保存最新配置
  const saved = await saveBank()
  if (!saved) return
  bankSyncing.value = true
  try {
    const { syncBank } = await import('@/services/sync')
    const res = await syncBank()
    if (res.ok) {
      const pulledMsg = res.pulled > 0 ? `拉取 ${res.pulled} 条` : '本地已是最新'
      const pushedMsg = res.pushed > 0 ? `推送 ${res.shardsPushed} 分片` : '无变更推送'
      bankResult.value = {
        type: 'success',
        msg: `增量同步完成：${pulledMsg}，${pushedMsg}`,
      }
      showSuccessToast(`云端同步成功：${pulledMsg}`)
    } else {
      bankResult.value = { type: 'error', msg: res.error || '云端同步失败，请检查接口与密钥' }
      showFailToast(res.error || '云端同步失败')
    }
  } finally {
    bankSyncing.value = false
  }
}

const ocrToken = ref('')
const ocrTesting = ref(false)
const ocrResult = ref<{ type: 'success' | 'error'; msg: string } | null>(null)

async function saveOcr() {
  await settings.saveOcr({ token: ocrToken.value.trim() })
  showSuccessToast('OCR 设置已保存')
}
async function testOcr() {
  if (ocrTesting.value) return
  const tk = ocrToken.value.trim()
  if (!tk) {
    ocrResult.value = { type: 'error', msg: '请先填写 Token' }
    return
  }
  ocrTesting.value = true
  ocrResult.value = null
  try {
    // 用 jobs 接口做一个空的 GET 请求验证 Token 有效性
    const res = await fetch('https://paddleocr.aistudio-app.com/api/v2/ocr/jobs', {
      headers: { Authorization: `bearer ${tk}` },
    })
    if (res.ok || res.status === 404) {
      ocrResult.value = { type: 'success', msg: 'Token 验证通过' }
    } else if (res.status === 401 || res.status === 403) {
      ocrResult.value = { type: 'error', msg: 'Token 无效或已过期' }
    } else {
      ocrResult.value = { type: 'error', msg: `服务返回 ${res.status}` }
    }
  } catch {
    ocrResult.value = { type: 'error', msg: '网络连接失败' }
  } finally {
    ocrTesting.value = false
  }
}

onMounted(async () => {
  await settings.load()
  await adminStore.load()
  ai.value = { ...settings.ai }
  webdav.value = { ...settings.webdav }
  webdavExpanded.value = settings.webdav.enabled
  bank.value = { ...settings.bankSync }
  ocrToken.value = settings.ocr.token
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
    </div>

    <div v-if="settings.secretErrors.length" class="test-result test-result--err secret-warning">
      <van-icon name="warning-o" />
      <span>{{ settings.secretErrors.join('、') }} 解密失败，请重新填写并保存。</span>
    </div>

    <!-- ===== AI 接口 ===== -->
    <div class="section-title">AI 接口</div>
    <div class="card">
      <div class="field-group">
        <div class="field">
          <label class="field__label">供应商</label>
          <ThemedSelect
            :model-value="ai.providerId"
            :options="providerOptions"
            placeholder="选择供应商"
            @change="onSelectProvider"
          />
        </div>

        <!-- 自定义才显示 Base URL -->
        <div v-if="isCustom" class="field">
          <label class="field__label">Base URL</label>
          <input v-model="ai.baseUrl" class="field__input" placeholder="https://your-api.com/v1" />
        </div>

        <div class="field">
          <label class="field__label">API Key</label>
          <input v-model="ai.apiKey" class="field__input" type="password" placeholder="sk-..." />
        </div>

        <!-- 模型：有预设则下拉（可清空转自定义输入），否则直接输入 -->
        <div class="field">
          <label class="field__label">模型</label>
          <ThemedSelect
            v-if="modelOptions.length"
            v-model="ai.model"
            :options="modelOptions"
            clearable
            clear-label="自定义…"
            placeholder="选择模型"
          />
          <input
            v-if="!modelOptions.length || !ai.model"
            v-model="ai.model"
            class="field__input"
            :style="modelOptions.length ? 'margin-top: 8px' : ''"
            placeholder="输入模型名"
          />
        </div>
      </div>

      <a
        v-if="currentProvider.keyHelp"
        :href="currentProvider.keyHelp"
        target="_blank"
        class="help-link"
      >
        <van-icon name="question-o" /> 如何获取 {{ currentProvider.label }} 的 API Key？
      </a>

      <div
        v-if="testResult"
        :class="[
          'test-result',
          testResult.type === 'success' ? 'test-result--ok' : 'test-result--err',
        ]"
      >
        <van-icon :name="testResult.type === 'success' ? 'success' : 'cross'" />
        <span>{{ testResult.msg }}</span>
      </div>

      <div class="btn-row">
        <van-button type="primary" round @click="saveAi">保存</van-button>
        <van-button plain type="primary" round :loading="testing" @click="testModel">
          {{ testing ? '检测中…' : '检测模型' }}
        </van-button>
      </div>
    </div>

    <!-- ===== 云端题库同步 ===== -->
    <div class="section-title">云端题库同步（跨设备）</div>
    <div class="card">
      <div class="field-group">
        <div class="field field--row">
          <label class="field__label">启用</label>
          <van-switch
            :model-value="bank.enabled"
            @update:model-value="(v: boolean) => (bank.enabled = v)"
          />
        </div>
        <div class="field">
          <label class="field__label">共享密钥（可选）</label>
          <input
            v-model="bank.key"
            class="field__input"
            type="password"
            placeholder="留空；或填写自定义 BANK_KEY"
          />
        </div>
      </div>
      <div
        v-if="bankResult"
        :class="[
          'test-result',
          bankResult.type === 'success' ? 'test-result--ok' : 'test-result--err',
        ]"
      >
        <van-icon :name="bankResult.type === 'success' ? 'success' : 'cross'" />
        <span>{{ bankResult.msg }}</span>
      </div>
      <div class="btn-row">
        <van-button type="primary" round @click="saveBank">保存</van-button>
        <van-button plain type="primary" round :loading="bankTesting" @click="testBank">
          {{ bankTesting ? '检测中…' : '检测接口' }}
        </van-button>
      </div>
      <div v-if="bank.enabled" style="margin-top: var(--sp-3)">
        <van-button block plain round :loading="bankSyncing" @click="manualBankSync">
          {{ bankSyncing ? '同步中…' : '立即同步' }}
        </van-button>
      </div>
    </div>

    <!-- ===== WebDAV 同步（默认折叠） ===== -->
    <button type="button" class="collapse-head" @click="webdavExpanded = !webdavExpanded">
      <span class="collapse-head__title">WebDAV 同步</span>
      <span v-if="webdav.enabled" class="collapse-head__badge">已启用</span>
      <van-icon
        :name="webdavExpanded ? 'arrow-up' : 'arrow-down'"
        size="14"
        color="var(--text-3)"
      />
    </button>
    <div v-show="webdavExpanded" class="card">
      <div class="field-group">
        <div class="field field--row">
          <label class="field__label">启用同步</label>
          <van-switch
            :model-value="webdav.enabled"
            @update:model-value="(v: boolean) => (webdav.enabled = v)"
          />
        </div>
        <div class="field">
          <label class="field__label">服务器地址</label>
          <input
            v-model="webdav.url"
            class="field__input"
            placeholder="https://dav.jianguoyun.com/dav/"
          />
        </div>
        <div class="field">
          <label class="field__label">账号</label>
          <input v-model="webdav.username" class="field__input" />
        </div>
        <div class="field">
          <label class="field__label">密码 / 应用密码</label>
          <input v-model="webdav.password" class="field__input" type="password" />
        </div>
        <div class="field">
          <label class="field__label">远端目录</label>
          <input v-model="webdav.remotePath" class="field__input" placeholder="/QuizBox" />
        </div>
      </div>
      <div
        v-if="wdResult"
        :class="[
          'test-result',
          wdResult.type === 'success' ? 'test-result--ok' : 'test-result--err',
        ]"
      >
        <van-icon :name="wdResult.type === 'success' ? 'success' : 'cross'" />
        <span>{{ wdResult.msg }}</span>
      </div>

      <div class="btn-row">
        <van-button type="primary" round @click="saveWebdav">保存</van-button>
        <van-button plain type="primary" round :loading="wdTesting" @click="testWebdav">
          {{ wdTesting ? '检测中…' : '检测连接' }}
        </van-button>
      </div>
      <div v-if="webdav.enabled" style="margin-top: var(--sp-3)">
        <van-button block plain round :loading="syncStore.syncing" @click="manualSync">
          {{ syncStore.syncing ? '同步中…' : '立即同步' }}
        </van-button>
      </div>
    </div>

    <!-- ===== OCR 服务 ===== -->
    <div class="section-title">OCR 服务（PDF 导入）</div>
    <div class="card">
      <div class="field-group">
        <div class="field">
          <label class="field__label">PaddleOCR Token</label>
          <input
            v-model="ocrToken"
            class="field__input"
            type="password"
            placeholder="飞桨 PaddleOCR API Token"
          />
          <p class="field__desc">在飞桨 PaddleOCR 平台获取 Token，用于 PDF 文档的文字与图片识别</p>
        </div>
      </div>
      <div
        v-if="ocrResult"
        :class="[
          'test-result',
          ocrResult.type === 'success' ? 'test-result--ok' : 'test-result--err',
        ]"
      >
        <van-icon :name="ocrResult.type === 'success' ? 'success' : 'cross'" />
        <span>{{ ocrResult.msg }}</span>
      </div>
      <div class="btn-row">
        <van-button type="primary" round @click="saveOcr">保存</van-button>
        <van-button plain type="primary" round :loading="ocrTesting" @click="testOcr">
          {{ ocrTesting ? '检测中…' : '检测连接' }}
        </van-button>
      </div>
    </div>

    <!-- ===== 管理权限 ===== -->
    <div class="section-title">管理权限</div>
    <div class="card">
      <div class="field-group">
        <div class="field field--row">
          <label class="field__label">状态</label>
          <span v-if="!adminStore.hasPassword" class="admin-status admin-status--off"
            >未设置密码（所有人可操作）</span
          >
          <span v-else-if="adminStore.isAdmin" class="admin-status admin-status--on">
            <van-icon name="shield-o" size="14" /> 管理员已登入
          </span>
          <span v-else class="admin-status admin-status--locked">
            <van-icon name="lock" size="14" /> 受保护模式
          </span>
        </div>

        <!-- 情况一：未设置密码 → 设置初始密码 -->
        <template v-if="!adminStore.hasPassword">
          <div class="field">
            <label class="field__label">设置管理密码</label>
            <input
              v-model="adminNewPwd"
              class="field__input"
              type="password"
              placeholder="输入密码"
            />
          </div>
          <div class="field">
            <label class="field__label">确认密码</label>
            <input
              v-model="adminConfirmPwd"
              class="field__input"
              type="password"
              placeholder="再次输入密码"
            />
          </div>
        </template>

        <!-- 情况二：已设置密码但未登录 → 单一输入框登录 -->
        <template v-else-if="!adminStore.isAdmin">
          <div class="field">
            <label class="field__label">管理员密码</label>
            <input
              v-model="adminLoginPwd"
              class="field__input"
              type="password"
              placeholder="输入管理密码以登入"
              @keyup.enter="loginAdmin"
            />
          </div>
        </template>

        <!-- 情况三：已登录 → 修改密码 -->
        <template v-else>
          <div class="field">
            <label class="field__label">新密码</label>
            <input
              v-model="adminNewPwd"
              class="field__input"
              type="password"
              placeholder="输入新密码"
            />
          </div>
          <div class="field">
            <label class="field__label">确认密码</label>
            <input
              v-model="adminConfirmPwd"
              class="field__input"
              type="password"
              placeholder="再次输入新密码"
            />
          </div>
        </template>
      </div>
      <p class="field__tip">
        管理员密码跨设备共享（随云端题库同步）。设置/修改后下次同步生效。刷新页面需重新验证。
      </p>

      <div v-if="adminStore.isAdmin" class="admin-tools">
        <div class="admin-tools__title">题库管理</div>
        <div class="btn-row">
          <van-button plain round icon="bookmark-o" @click="router.push({ name: 'library' })">
            管理科目
          </van-button>
          <van-button plain round icon="upgrade" @click="router.push({ name: 'import' })">
            导入题库
          </van-button>
        </div>
        <van-button
          block
          plain
          round
          icon="replay"
          :loading="forceSyncing"
          :disabled="!bank.enabled"
          @click="requestForceSync"
        >
          {{ forceSyncing ? '发布中…' : '要求其他设备同步' }}
        </van-button>
        <p class="field__tip">其它设备会在启动、首页下拉同步或手动云端同步时拉取最新题库。</p>
      </div>

      <!-- 从云端同步：仅在本机尚未设置密码时可用（用于新设备继承共享管理员密码） -->
      <div v-if="!adminStore.hasPassword" style="margin-bottom: var(--sp-3)">
        <van-button block plain round :loading="adminPulling" @click="pullAdminFromCloud">
          {{ adminPulling ? '同步中…' : '使用云端管理员密码' }}
        </van-button>
        <p class="field__tip" style="margin-top: 6px">
          若其他设备已设置管理员密码，点此拉取并继承同一密码（首次配置新设备时使用）。
        </p>
      </div>

      <!-- 情况一：设置密码 -->
      <div v-if="!adminStore.hasPassword" class="btn-row">
        <van-button type="primary" round @click="setAdminPassword">设置密码</van-button>
      </div>
      <!-- 情况二：登录 -->
      <div v-else-if="!adminStore.isAdmin" class="btn-row">
        <van-button type="primary" round @click="loginAdmin">登入</van-button>
      </div>
      <!-- 情况三：修改密码 + 退出 -->
      <div v-else>
        <div class="btn-row">
          <van-button type="primary" round @click="changeAdminPassword">修改密码</van-button>
        </div>
        <div style="margin-top: var(--sp-3)">
          <van-button block plain round @click="adminStore.logout()">退出管理员</van-button>
        </div>
      </div>
    </div>

    <!-- ===== 外观 ===== -->
    <div class="section-title">外观</div>
    <div class="card">
      <div class="field">
        <label class="field__label">主题模式</label>
        <div class="seg">
          <button
            v-for="t in [
              { v: 'auto', l: '跟随系统' },
              { v: 'light', l: '亮色' },
              { v: 'dark', l: '暗色' },
            ]"
            :key="t.v"
            :class="['seg__btn', settings.theme === t.v && 'seg__btn--active']"
            @click="settings.setTheme(t.v as any)"
          >
            {{ t.l }}
          </button>
        </div>
      </div>
      <div class="field">
        <label class="field__label">主题色</label>
        <div class="color-row">
          <button
            v-for="(def, key) in THEME_COLORS"
            :key="key"
            :class="['color-dot', settings.themeColor === key && 'color-dot--active']"
            :style="{ background: def.vars['--brand'] }"
            :title="def.label"
            @click="settings.setThemeColor(key as ThemeColor)"
          ></button>
        </div>
      </div>
    </div>

    <div class="section-title">关于</div>
    <div class="card about-card">
      <div class="about-brand">
        <img class="about-brand__logo" src="/favicon.svg" alt="QuizBox" />
        <div>
          <div class="about-brand__name">题盒 QuizBox</div>
          <div class="about-brand__sub">本地优先的题库与练习工具</div>
        </div>
      </div>
      <div class="about-row">
        <span class="about-row__label">版本号</span>
        <span class="about-row__value">v{{ version }}</span>
      </div>
      <div class="about-row">
        <span class="about-row__label">开源协议</span>
        <span class="about-row__value">MIT License</span>
      </div>
      <div class="about-row about-row--clickable" @click="showHistory = true">
        <span class="about-row__label">更新历史</span>
        <van-icon name="arrow" size="14" color="var(--text-3)" />
      </div>
      <a
        class="github-btn"
        href="https://github.com/Skit1z/QuizBox"
        target="_blank"
        rel="noopener noreferrer"
      >
        <svg class="github-btn__icon" viewBox="0 0 24 24" aria-hidden="true">
          <path
            fill="currentColor"
            d="M12 2C6.48 2 2 6.58 2 12.26c0 4.54 2.87 8.39 6.84 9.75.5.1.68-.22.68-.5v-1.75c-2.78.62-3.37-1.37-3.37-1.37-.45-1.18-1.11-1.5-1.11-1.5-.91-.64.07-.63.07-.63 1 .07 1.53 1.06 1.53 1.06.9 1.57 2.34 1.12 2.91.85.09-.67.35-1.12.63-1.38-2.22-.26-4.56-1.14-4.56-5.06 0-1.12.39-2.03 1.03-2.75-.1-.26-.45-1.31.1-2.71 0 0 .84-.28 2.75 1.05A9.3 9.3 0 0 1 12 6.98c.85 0 1.7.12 2.5.34 1.9-1.33 2.74-1.05 2.74-1.05.55 1.4.2 2.45.1 2.71.64.72 1.03 1.63 1.03 2.75 0 3.93-2.34 4.8-4.57 5.06.36.32.68.94.68 1.9v2.82c0 .28.18.6.69.5A10.13 10.13 0 0 0 22 12.26C22 6.58 17.52 2 12 2Z"
          />
        </svg>
        Skit1z/QuizBox
      </a>
    </div>

    <!-- 更新历史弹窗 -->
    <van-popup
      v-model:show="showHistory"
      position="right"
      style="width: 100%; height: 100%; background: var(--bg)"
    >
      <div class="page history-page">
        <div class="page-head page-head--row">
          <div class="page-head__left" @click="showHistory = false">
            <van-icon name="arrow-left" size="20" />
            <h1 class="page-title page-title--sm">更新历史</h1>
          </div>
        </div>
        <div class="history-content">
          <div v-for="h in updateHistory" :key="h.version" class="history-item card">
            <div class="history-item__header">
              <span class="history-item__version">v{{ h.version }}</span>
              <span class="history-item__date">{{ h.date }}</span>
            </div>
            <ul class="history-item__logs">
              <li v-for="(log, idx) in h.logs" :key="idx" class="history-item__log">
                {{ log }}
              </li>
            </ul>
          </div>
        </div>
      </div>
    </van-popup>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5);
  box-shadow: var(--shadow-sm);
}
.collapse-head {
  width: 100%;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  border: none;
  background: transparent;
  padding: 0;
  margin: var(--sp-5) 0 var(--sp-3);
  cursor: pointer;
}
.collapse-head__title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-2);
}
.collapse-head__badge {
  font-size: 11px;
  font-weight: 500;
  color: var(--success);
  background: rgba(0, 180, 42, 0.1);
  padding: 1px 8px;
  border-radius: var(--r-full);
}
.collapse-head :deep(.van-icon) {
  margin-left: auto;
}
.btn-row {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
.btn-row :deep(.van-button) {
  flex: 1;
}
.test-result {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--sp-3);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--r-sm);
  font-size: 13px;
  line-height: 1.5;
}
.test-result--ok {
  color: var(--success);
  background: rgba(0, 180, 42, 0.08);
}
.test-result--err {
  color: var(--danger);
  background: rgba(245, 63, 63, 0.08);
}
.secret-warning {
  margin-bottom: var(--sp-4);
}
.field-group {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field--row {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
}
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}
.field__desc {
  font-size: 12px;
  color: var(--text-3);
  margin: 0;
  line-height: 1.5;
}
.field__input,
.field__select {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}
.field__input:focus,
.field__select:focus {
  border-color: var(--brand);
}
.field__select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2386909c' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 32px;
}
.help-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--sp-3);
  font-size: 12px;
  color: var(--brand);
  text-decoration: none;
}
.seg {
  display: flex;
  gap: 6px;
  background: var(--surface-2);
  border-radius: var(--r-md);
  padding: 3px;
}
.seg__btn {
  flex: 1;
  height: 36px;
  border: none;
  background: transparent;
  color: var(--text-2);
  font-size: 13px;
  border-radius: var(--r-sm);
  cursor: pointer;
  transition: all 0.15s;
}
.seg__btn--active {
  background: var(--surface);
  color: var(--brand);
  font-weight: 600;
  box-shadow: var(--shadow-sm);
}
.color-row {
  display: flex;
  gap: var(--sp-3);
  align-items: center;
}
.color-dot {
  width: 36px;
  height: 36px;
  border-radius: var(--r-full);
  border: 3px solid transparent;
  cursor: pointer;
  transition: all 0.15s;
  position: relative;
}
.color-dot--active {
  border-color: var(--surface);
  box-shadow: 0 0 0 2px currentColor;
}
.about-card {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.about-brand {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  padding-bottom: var(--sp-3);
  border-bottom: 1px solid var(--border);
}
.about-brand__logo {
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  box-shadow: var(--shadow-brand);
  flex-shrink: 0;
}
.about-brand__name {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.about-brand__sub {
  margin-top: 2px;
  font-size: 12px;
  color: var(--text-3);
}
.about-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
  font-size: 14px;
}
.about-row__label {
  color: var(--text-3);
}
.about-row__value {
  color: var(--text);
  font-weight: 600;
}
.github-btn {
  height: 42px;
  border-radius: var(--r-md);
  border: 1px solid var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  text-decoration: none;
  font-size: 14px;
  font-weight: 600;
}
.github-btn__icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.admin-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  font-weight: 500;
  padding: 2px 10px;
  border-radius: var(--r-sm);
}
.admin-status--off {
  color: var(--text-3);
}
.admin-status--on {
  color: var(--success);
  background: rgba(0, 180, 42, 0.08);
}
.admin-status--locked {
  color: var(--danger);
  background: rgba(245, 63, 63, 0.08);
}
.admin-tools {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  padding-top: var(--sp-4);
  margin-top: var(--sp-4);
  border-top: 1px solid var(--border);
}
.admin-tools__title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
}
.field__tip {
  font-size: 12px;
  color: var(--text-3);
  margin: var(--sp-3) 0 0;
  line-height: 1.5;
}
.about-row--clickable {
  cursor: pointer;
  transition: opacity 0.15s;
}
.about-row--clickable:active {
  opacity: 0.7;
}

/* ===== 更新历史 ===== */
.history-page {
  padding: var(--sp-4) var(--sp-5) var(--sp-8);
  min-height: 100vh;
  box-sizing: border-box;
}
.history-content {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  margin-top: var(--sp-4);
  max-width: var(--content-max);
  margin-left: auto;
  margin-right: auto;
}
.history-item {
  padding: var(--sp-4) var(--sp-5);
}
.history-item__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.history-item__version {
  font-size: 16px;
  font-weight: 700;
  color: var(--brand);
}
.history-item__date {
  font-size: 12px;
  color: var(--text-3);
}
.history-item__logs {
  padding-left: 18px;
  margin: 0;
  list-style-type: disc;
}
.history-item__log {
  font-size: 13.5px;
  color: var(--text-2);
  line-height: 1.6;
  margin-bottom: 6px;
}
.history-item__log:last-child {
  margin-bottom: 0;
}
</style>
