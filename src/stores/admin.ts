import { defineStore } from 'pinia'
import { db } from '@/db'
import { sha256 } from '@/utils/hash'

const META_KEY_ADMIN = 'admin_password_hash'

export const useAdminStore = defineStore('admin', {
  state: () => ({
    /** 是否已通过密码验证（内存态，刷新即清零） */
    isAdmin: false,
    /** 是否已设置管理密码 */
    hasPassword: false,
    /** 本地密码哈希（加载后缓存在内存中） */
    _hash: '',
    /** 最近一次同步从云端拉到的密码哈希（用于判断是否需要推送） */
    _remoteHash: '',
    _loaded: false,
  }),
  actions: {
    /** 从 IndexedDB 加载管理密码状态（本地缓存，可能被云端覆盖） */
    async load() {
      if (this._loaded) return
      const meta = await db.syncMeta.get(META_KEY_ADMIN)
      if (meta) {
        this._hash = meta.value
        this.hasPassword = !!meta.value
      }
      this._loaded = true
    },

    /**
     * 用云端 meta 分片的密码哈希覆盖本地状态。
     * 用于题库同步后让各设备共享同一管理员密码。
     *
     * 权威源规则（避免设密码后被空云端值清空）：
     * - 云端有密码哈希 → 以云端为准（同步本地缓存），本地登录态失效需重新验证
     * - 云端无密码哈希 → 仅当本地也无密码时同步空态；
     *   本地已设密码时不覆盖（本地密码等待下次推送上云，而非被清空）
     */
    applyRemoteHash(hash: string | undefined) {
      const remoteHash = hash || ''
      this._remoteHash = remoteHash
      // 云端无密码：不覆盖本地（避免设密码后被空值清空）
      if (!remoteHash) return
      // 云端有密码且与本地不同 → 以云端为准
      if (remoteHash !== this._hash) {
        this._hash = remoteHash
        this.hasPassword = true
        // 远端密码变化 → 当前登录态失效，需重新验证
        this.isAdmin = false
        void db.syncMeta.put({ key: META_KEY_ADMIN, value: remoteHash })
      }
    },

    /** 返回当前密码哈希，供题库同步写入 meta 分片 */
    getHash(): string {
      return this._hash
    },

    /** 设置/修改管理密码（同时写入本地缓存，并立即推送到云端） */
    async setPassword(password: string) {
      const hash = await sha256(password)
      await db.syncMeta.put({ key: META_KEY_ADMIN, value: hash })
      this._hash = hash
      this.hasPassword = true
      this.isAdmin = true // 设置密码后自动获得管理员身份
      // 密码必须立即推上云端，否则其它设备「使用云端密码」拉不到
      // （autoSync 有 120s 防抖，且设密码流程未调用 autoSync，不能依赖）
      const { syncBank } = await import('@/services/sync')
      void syncBank()
    },

    /** 验证密码，正确则激活管理员会话 */
    async verify(password: string): Promise<boolean> {
      const hash = await sha256(password)
      if (hash === this._hash) {
        this.isAdmin = true
        return true
      }
      return false
    },

    /** 退出管理员模式 */
    logout() {
      this.isAdmin = false
    },

    /**
     * 检查是否可执行受保护操作。
     * - 未设置密码 → 直接放行（true）
     * - 已设置密码且已验证 → 放行（true）
     * - 已设置密码但未验证 → 返回 false（调用方需弹出验证弹窗）
     */
    canOperate(): boolean {
      if (!this.hasPassword) return true
      return this.isAdmin
    },
  },
})
