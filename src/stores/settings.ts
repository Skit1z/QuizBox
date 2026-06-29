import { defineStore } from 'pinia'
import { db } from '@/db'
import { encryptSecret, decryptSecret, SecretDecryptError } from '@/utils/crypto'
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

export interface OcrSettings {
  /** PaddleOCR 云 API Token */
  token: string
}

const DEFAULT_OCR: OcrSettings = {
  token: '',
}

const DEFAULT_AI: AiSettings = {
  providerId: 'deepseek',
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: '',
  model: 'deepseek-v4-flash',
}

const DEFAULT_WEBDAV: WebdavSettings = {
  enabled: false,
  url: 'https://dav.jianguoyun.com/dav/',
  username: '',
  password: '',
  remotePath: '/QuizBox',
}

const META_KEY_AI = 'ai_settings'
const META_KEY_WEBDAV = 'webdav_settings'
const META_KEY_OCR = 'ocr_settings'
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
    ocr: { ...DEFAULT_OCR },
    theme: 'auto' as 'light' | 'dark' | 'auto',
    themeColor: DEFAULT_THEME_COLOR,
    secretErrors: [] as string[],
    loaded: false,
  }),
  actions: {
    async load() {
      if (this.loaded) return // 避免重复加载（含解密开销）
      const [aiMeta, wdMeta, ocrMeta, themeMeta, colorMeta] = await Promise.all([
        db.syncMeta.get(META_KEY_AI),
        db.syncMeta.get(META_KEY_WEBDAV),
        db.syncMeta.get(META_KEY_OCR),
        db.syncMeta.get(META_KEY_THEME),
        db.syncMeta.get(META_KEY_COLOR),
      ])
      if (aiMeta) {
        const raw = JSON.parse(aiMeta.value) as StoredAi
        const provider = raw.providerId ? findProvider(raw.providerId) : undefined
        const apiKey = await this.tryDecrypt(raw.apiKey, 'AI API Key')
        this.ai = {
          providerId: raw.providerId || 'custom',
          // 若是已知供应商，baseUrl 以预设为准（避免配置漂移）
          baseUrl: provider && !provider.custom ? provider.baseUrl : raw.baseUrl,
          apiKey,
          model: raw.model || provider?.model || '',
        }
      }
      if (wdMeta) {
        const raw = JSON.parse(wdMeta.value) as StoredWebdav
        const password = await this.tryDecrypt(raw.password, 'WebDAV 密码')
        this.webdav = {
          enabled: raw.enabled,
          // url 为空时回退默认值（坚果云），兼容旧版存了空字符串的用户
          url: raw.url || DEFAULT_WEBDAV.url,
          username: raw.username,
          password,
          remotePath: raw.remotePath || '/QuizBox',
        }
      }
      if (ocrMeta) {
        const raw = JSON.parse(ocrMeta.value) as { token: string }
        this.ocr = { token: await this.tryDecrypt(raw.token, 'OCR Token') }
      }
      if (themeMeta) this.theme = JSON.parse(themeMeta.value)
      if (colorMeta) this.themeColor = JSON.parse(colorMeta.value) as ThemeColor
      this.loaded = true
      this.applyAll()
    },

    async tryDecrypt(stored: string, label: string): Promise<string> {
      try {
        return await decryptSecret(stored)
      } catch (e) {
        if (e instanceof SecretDecryptError) {
          if (!this.secretErrors.includes(label)) this.secretErrors.push(label)
          return ''
        }
        throw e
      }
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
      this.secretErrors = this.secretErrors.filter((x) => x !== 'AI API Key')
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
      this.secretErrors = this.secretErrors.filter((x) => x !== 'WebDAV 密码')
      const { resetSyncClient } = await import('@/services/sync')
      resetSyncClient()
    },

    async saveOcr(settings: Partial<OcrSettings>) {
      this.ocr = { ...this.ocr, ...settings }
      const stored = {
        token: this.ocr.token ? await encryptSecret(this.ocr.token) : '',
      }
      await db.syncMeta.put({ key: META_KEY_OCR, value: JSON.stringify(stored) })
      this.secretErrors = this.secretErrors.filter((x) => x !== 'OCR Token')
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
