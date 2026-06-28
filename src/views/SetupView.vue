<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showSuccessToast, showFailToast } from 'vant'
import { useSettingsStore, type WebdavSettings } from '@/stores/settings'
import { useSyncStore } from '@/stores/sync'

const router = useRouter()
const settings = useSettingsStore()
const syncStore = useSyncStore()

const webdav = ref<WebdavSettings>({
  enabled: true,
  url: '',
  username: '',
  password: '',
  remotePath: '/QAsystem',
})

async function saveAndSync() {
  if (!webdav.value.url || !webdav.value.username) {
    showFailToast('请填写 WebDAV 地址和账号')
    return
  }
  await settings.saveWebdav(webdav.value)
  const res = await syncStore.run()
  if (res.ok) {
    showSuccessToast('配置成功，开始使用')
    router.replace({ name: 'home' })
  } else {
    showFailToast('连接失败，请检查地址和密码')
  }
}

onMounted(async () => {
  await settings.load()
  if (settings.webdav.url) webdav.value = { ...settings.webdav, enabled: true }
})
</script>

<template>
  <div class="setup">
    <div class="setup__hero">
      <div class="setup__logo">
        <van-icon name="cloud-o" size="36" color="#fff" />
      </div>
      <h1 class="setup__title">欢迎使用刷题系统</h1>
      <p class="setup__desc">首次使用请配置 WebDAV 云盘，<br />用于多端同步你的题库数据</p>
    </div>

    <div class="card setup__form">
      <div class="field-group">
        <div class="field">
          <label class="field__label">服务器地址</label>
          <input v-model="webdav.url" class="field__input" placeholder="https://dav.jianguoyun.com/dav/" />
        </div>
        <div class="field">
          <label class="field__label">账号</label>
          <input v-model="webdav.username" class="field__input" placeholder="坚果云账号邮箱" />
        </div>
        <div class="field">
          <label class="field__label">应用密码</label>
          <input v-model="webdav.password" class="field__input" type="password" placeholder="第三方应用专用密码" />
        </div>
        <div class="field">
          <label class="field__label">目录</label>
          <input v-model="webdav.remotePath" class="field__input" placeholder="/QAsystem" />
        </div>
      </div>

      <div class="tip">
        <van-icon name="info-o" />
        <span>支持坚果云、Nextcloud 等标准 WebDAV。坚果云请用「应用密码」而非登录密码。</span>
      </div>
    </div>

    <div class="setup__action">
      <van-button type="primary" block round :loading="syncStore.syncing" @click="saveAndSync">
        {{ syncStore.syncing ? '连接中…' : '连接并开始使用' }}
      </van-button>
    </div>
  </div>
</template>

<style scoped>
.setup {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  justify-content: center;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: var(--sp-6) var(--sp-4);
}
.setup__hero {
  text-align: center;
  margin-bottom: var(--sp-6);
}
.setup__logo {
  width: 72px;
  height: 72px;
  border-radius: var(--r-xl);
  background: linear-gradient(135deg, var(--brand), rgba(var(--brand-rgb), 0.7));
  margin: 0 auto var(--sp-4);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-brand);
}
.setup__title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
  margin: 0 0 var(--sp-2);
}
.setup__desc {
  font-size: 13px;
  color: var(--text-3);
  line-height: 1.6;
  margin: 0;
}
.setup__form {
  margin-bottom: var(--sp-5);
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
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}
.field__input {
  width: 100%;
  height: 44px;
  padding: 0 14px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  transition: border-color 0.15s;
}
.field__input:focus {
  border-color: var(--brand);
}
.tip {
  display: flex;
  gap: 6px;
  margin-top: var(--sp-4);
  padding: var(--sp-3);
  background: var(--brand-soft);
  border-radius: var(--r-md);
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}
</style>
