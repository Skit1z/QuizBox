<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { showSuccessToast, showFailToast } from 'vant'
import {
  useSettingsStore,
  type AiSettings,
  type WebdavSettings,
} from '@/stores/settings'
import { useSyncStore } from '@/stores/sync'
import { AI_PROVIDERS, findProvider } from '@/services/ai-providers'
import { THEME_COLORS, type ThemeColor } from '@/themes/tokens'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'

const settings = useSettingsStore()
const syncStore = useSyncStore()
const ai = ref<AiSettings>({ ...settings.ai })
const webdav = ref<WebdavSettings>({ ...settings.webdav })
// 版本号由 vite define 在构建期从 package.json 注入
const version = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : ''

const currentProvider = computed(() => findProvider(ai.value.providerId) || AI_PROVIDERS[AI_PROVIDERS.length - 1])
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
  } catch (e: any) {
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
  ai.value = { ...settings.ai }
  webdav.value = { ...settings.webdav }
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
          <input
            v-model="ai.baseUrl"
            class="field__input"
            placeholder="https://your-api.com/v1"
          />
        </div>

        <div class="field">
          <label class="field__label">API Key</label>
          <input
            v-model="ai.apiKey"
            class="field__input"
            type="password"
            placeholder="sk-..."
          />
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

      <div v-if="testResult" :class="['test-result', testResult.type === 'success' ? 'test-result--ok' : 'test-result--err']">
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

    <!-- ===== WebDAV 同步 ===== -->
    <div class="section-title">WebDAV 同步</div>
    <div class="card">
      <div class="field-group">
        <div class="field field--row">
          <label class="field__label">启用同步</label>
          <van-switch :model-value="webdav.enabled" @update:model-value="(v:boolean) => (webdav.enabled = v)" />
        </div>
        <div class="field">
          <label class="field__label">服务器地址</label>
          <input v-model="webdav.url" class="field__input" placeholder="https://dav.jianguoyun.com/dav/" />
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
      <div v-if="wdResult" :class="['test-result', wdResult.type === 'success' ? 'test-result--ok' : 'test-result--err']">
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
          <input v-model="ocrToken" class="field__input" type="password" placeholder="飞桨 PaddleOCR API Token" />
          <p class="field__desc">在飞桨 PaddleOCR 平台获取 Token，用于 PDF 文档的文字与图片识别</p>
        </div>
      </div>
      <div v-if="ocrResult" :class="['test-result', ocrResult.type === 'success' ? 'test-result--ok' : 'test-result--err']">
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

    <!-- ===== 外观 ===== -->
    <div class="section-title">外观</div>
    <div class="card">
      <div class="field">
        <label class="field__label">主题模式</label>
        <div class="seg">
          <button
            v-for="t in [{v:'auto',l:'跟随系统'},{v:'light',l:'亮色'},{v:'dark',l:'暗色'}]"
            :key="t.v"
            :class="['seg__btn', settings.theme === t.v && 'seg__btn--active']"
            @click="settings.setTheme(t.v as any)"
          >{{ t.l }}</button>
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

    <div class="about">题盒 QuizBox v{{ version }}</div>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5);
  box-shadow: var(--shadow-sm);
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
.about {
  text-align: center;
  font-size: 12px;
  color: var(--text-3);
  margin-top: var(--sp-6);
  padding-bottom: var(--sp-4);
}
</style>
