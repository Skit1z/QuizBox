import { defineStore } from 'pinia'
import { db } from '@/db'
import { encryptSecret, decryptSecret } from '@/utils/crypto'
import { findProvider } from '@/services/ai-providers'
import { DEFAULT_THEME_COLOR, type ThemeColor } from '@/themes/tokens'

export interface AiSettings {
  /** 供应商 id（见 ai-providers.ts），'custom' 为手动 */
  providerId: string
  baseUrl: string
  apiKey: string
  model: string
}

export interface WebdavSettings {
  enabled: boolean
  url: string
  username: string
  password: string
  /** 远端目录路径 */
  remotePath: string
}

const DEFAULT_AI: AiSettings = {
  providerId: 'glm',
  baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4-flash',
}

const DEFAULT_WEBDAV: WebdavSettings = {
  enabled: false,
  url: '',
  username: '',
  password: '',
  remotePath: '/QuizBox',
}

const META_KEY_AI = 'ai_settings'
const META_KEY_WEBDAV = 'webdav_settings'
const META_KEY_THEME = 'theme'
const META_KEY_COLOR = 'theme_color'

interface StoredAi {
  providerId?: string
  baseUrl: string
  apiKey: string // 加密
  model: string
}
interface StoredWebdav {
  enabled: boolean
  url: string
  username: string
  password: string // 加密
  remotePath: string
}

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    ai: { ...DEFAULT_AI },
    webdav: { ...DEFAULT_WEBDAV },
    theme: 'auto' as 'light' | 'dark' | 'auto',
    themeColor: DEFAULT_THEME_COLOR,
    loaded: false,
  }),
  actions: {
    async load() {
      const [aiMeta, wdMeta, themeMeta, colorMeta] = await Promise.all([
        db.syncMeta.get(META_KEY_AI),
        db.syncMeta.get(META_KEY_WEBDAV),
        db.syncMeta.get(META_KEY_THEME),
        db.syncMeta.get(META_KEY_COLOR),
      ])
      if (aiMeta) {
        const raw = JSON.parse(aiMeta.value) as StoredAi
        const provider = raw.providerId ? findProvider(raw.providerId) : undefined
        this.ai = {
          providerId: raw.providerId || 'custom',
          // 若是已知供应商，baseUrl 以预设为准（避免配置漂移）
          baseUrl: provider && !provider.custom ? provider.baseUrl : raw.baseUrl,
          apiKey: await decryptSecret(raw.apiKey),
          model: raw.model || provider?.model || '',
        }
      }
      if (wdMeta) {
        const raw = JSON.parse(wdMeta.value) as StoredWebdav
        this.webdav = {
          enabled: raw.enabled,
          url: raw.url,
          username: raw.username,
          password: await decryptSecret(raw.password),
          remotePath: raw.remotePath || '/QuizBox',
        }
      }
      if (themeMeta) this.theme = JSON.parse(themeMeta.value)
      if (colorMeta) this.themeColor = JSON.parse(colorMeta.value) as ThemeColor
      this.loaded = true
      this.applyAll()
    },

    /** 选择供应商：自动填入 baseUrl 与默认 model */
    selectProvider(providerId: string) {
      this.ai.providerId = providerId
      const p = findProvider(providerId)
      if (p) {
        this.ai.baseUrl = p.baseUrl
        if (p.model) this.ai.model = p.model
      }
    },

    async saveAi(settings: Partial<AiSettings>) {
      this.ai = { ...this.ai, ...settings }
      const stored: StoredAi = {
        providerId: this.ai.providerId,
        baseUrl: this.ai.baseUrl,
        apiKey: this.ai.apiKey ? await encryptSecret(this.ai.apiKey) : '',
        model: this.ai.model,
      }
      await db.syncMeta.put({ key: META_KEY_AI, value: JSON.stringify(stored) })
    },

    async saveWebdav(settings: Partial<WebdavSettings>) {
      this.webdav = { ...this.webdav, ...settings }
      const stored: StoredWebdav = {
        enabled: this.webdav.enabled,
        url: this.webdav.url,
        username: this.webdav.username,
        password: this.webdav.password ? await encryptSecret(this.webdav.password) : '',
        remotePath: this.webdav.remotePath,
      }
      await db.syncMeta.put({ key: META_KEY_WEBDAV, value: JSON.stringify(stored) })
      const { resetSyncClient } = await import('@/services/sync')
      resetSyncClient()
    },

    async setTheme(theme: 'light' | 'dark' | 'auto') {
      this.theme = theme
      await db.syncMeta.put({ key: META_KEY_THEME, value: JSON.stringify(theme) })
      this.applyTheme()
    },
    async setThemeColor(color: ThemeColor) {
      this.themeColor = color
      await db.syncMeta.put({ key: META_KEY_COLOR, value: JSON.stringify(color) })
      this.applyThemeColor()
    },
    applyAll() {
      this.applyTheme()
      this.applyThemeColor()
    },
    applyTheme() {
      const root = document.documentElement
      root.classList.remove('dark', 'light')
      if (this.theme === 'dark') root.classList.add('dark')
      else if (this.theme === 'light') root.classList.add('light')
    },
    applyThemeColor() {
      document.documentElement.setAttribute('data-theme-color', this.themeColor)
    },
  },
})
