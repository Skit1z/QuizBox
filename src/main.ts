import { createApp } from 'vue'
import { createPinia } from 'pinia'
// Vant 组件由 unplugin-vue-components 按需自动注册（见 vite.config.ts）。
// 函数式 API（showToast / showConfirmDialog 等）需注册对应插件。
import {
  Toast,
  Dialog,
  Notify,
  ImagePreview,
} from 'vant'
import 'vant/lib/index.css'

import App from './App.vue'
import router from './router'
import './styles/global.css'

const app = createApp(App)
app.use(createPinia())
app.use(router)
// 仅注册函数式调用所需的插件（非全量组件）
app.use(Toast)
app.use(Dialog)
app.use(Notify)
app.use(ImagePreview)
app.mount('#app')
