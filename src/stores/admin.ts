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
    /** 密码哈希（加载后缓存在内存中） */
    _hash: '',
    _loaded: false,
  }),
  actions: {
    /** 从 IndexedDB 加载管理密码状态 */
    async load() {
      if (this._loaded) return
      const meta = await db.syncMeta.get(META_KEY_ADMIN)
      if (meta) {
        this._hash = meta.value
        this.hasPassword = !!meta.value
      }
      this._loaded = true
    },

    /** 设置/修改管理密码 */
    async setPassword(password: string) {
      const hash = await sha256(password)
      await db.syncMeta.put({ key: META_KEY_ADMIN, value: hash })
      this._hash = hash
      this.hasPassword = true
      this.isAdmin = true // 设置密码后自动获得管理员身份
    },

    /** 清除管理密码（恢复为无需权限） */
    async clearPassword() {
      await db.syncMeta.delete(META_KEY_ADMIN)
      this._hash = ''
      this.hasPassword = false
      this.isAdmin = false
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
