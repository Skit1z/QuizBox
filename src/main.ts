import { createApp } from 'vue'
import { createPinia } from 'pinia'
import { registerSW } from 'virtual:pwa-register'
// Vant 组件由 unplugin-vue-components 按需自动注册（见 vite.config.ts）。
// 函数式 API（showToast / showConfirmDialog 等）需注册对应插件。
import { Toast, Dialog, Notify, ImagePreview } from 'vant'
import 'vant/lib/index.css'

import App from './App.vue'
import router from './router'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
app.use(Toast)
app.use(Dialog)
app.use(Notify)
app.use(ImagePreview)
app.mount('#app')

// 自动更新策略（registerType: 'autoUpdate'）：
// 新版本部署后，autoUpdate 会在「检测到新 SW」时静默激活并刷新所有标签页。
// 但默认只在页面加载时检测一次——PWA/标签页常驻时会拖很久才换新版。
// 因此这里主动轮询 + 切回前台时立即复查，把检测延迟压到 60s 内。
const UPDATE_CHECK_INTERVAL = 60 * 1000
registerSW({
  immediate: true,
  onRegisteredSW(_swUrl, registration) {
    if (!registration) return
    setInterval(() => {
      void registration.update()
    }, UPDATE_CHECK_INTERVAL)
    // 从后台切回前台（移动端常见）时立即查一次，避免久挂后还是旧版
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') void registration.update()
    })
  },
})
