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

const settings = useSettingsStore()
const syncStore = useSyncStore()
const ai = ref<AiSettings>({ ...settings.ai })
const webdav = ref<WebdavSettings>({ ...settings.webdav })

const currentProvider = computed(() => findProvider(ai.value.providerId) || AI_PROVIDERS[AI_PROVIDERS.length - 1])
const isCustom = computed(() => currentProvider.value.custom)

function onSelectProvider(id: string) {
  const p = findProvider(id)
  if (!p) return
  ai.value.providerId = id
  ai.value.baseUrl = p.baseUrl
  if (p.model && (isCustom.value || !ai.value.model || ai.value.model === currentProvider.value.model)) {
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

async function saveWebdav() {
  await settings.saveWebdav(webdav.value)
  showSuccessToast('同步设置已保存')
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

onMounted(async () => {
  await settings.load()
  ai.value = { ...settings.ai }
  webdav.value = { ...settings.webdav }
})
</script>

<template>
  <div class="page">
    <div class="page-head">
      <h1 class="page-title">设置</h1>
    </div>

    <!-- ===== AI 接口 ===== -->
    <div class="section-title">AI 接口</div>
    <div class="card">
      <div class="field-group">
        <div class="field">
          <label class="field__label">供应商</label>
          <select class="field__select" :value="ai.providerId" @change="onSelectProvider(($event.target as HTMLSelectElement).value)">
            <option v-for="p in AI_PROVIDERS" :key="p.id" :value="p.id">{{ p.label }}</option>
          </select>
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

        <!-- 模型：有预设则下拉，否则输入 -->
        <div class="field">
          <label class="field__label">模型</label>
          <select v-if="currentProvider.models?.length" v-model="ai.model" class="field__select">
            <option v-for="m in currentProvider.models" :key="m" :value="m">{{ m }}</option>
            <option value="">自定义…</option>
          </select>
          <input
            v-else
            v-model="ai.model"
            class="field__input"
            placeholder="模型名"
          />
          <input
            v-if="currentProvider.models?.length && !ai.model"
            v-model="ai.model"
            class="field__input"
            style="margin-top: 8px"
            placeholder="输入自定义模型名"
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

      <div style="margin-top: var(--sp-4)">
        <van-button type="primary" block round @click="saveAi">保存 AI 设置</van-button>
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
          <input v-model="webdav.remotePath" class="field__input" placeholder="/QAsystem" />
        </div>
      </div>
      <div style="margin-top: var(--sp-4); display: flex; gap: var(--sp-3)">
        <van-button block plain round @click="saveWebdav">保存</van-button>
        <van-button v-if="webdav.enabled" block plain round :loading="syncStore.syncing" @click="manualSync">
          {{ syncStore.syncing ? '同步中…' : '立即同步' }}
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

    <div class="about">刷题系统 v0.1.0 · 本地存储 · WebDAV 同步</div>
  </div>
</template>

<style scoped>
.card {
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5);
  box-shadow: var(--shadow-sm);
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
