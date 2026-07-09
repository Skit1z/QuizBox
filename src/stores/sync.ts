import { defineStore } from 'pinia'
import { syncBank, syncOnStartup } from '@/services/sync'
import { db } from '@/db'

function notifyDataChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('quizbox:data-changed'))
  }
}

export const useSyncStore = defineStore('sync', {
  state: () => ({
    /** 上次云端题库同步完成的时间戳（WebDAV 同步已移除，只剩 bank 一条路径） */
    lastSyncAt: 0 as number,
    syncing: false,
  }),
  actions: {
    async init() {
      const meta = await db.syncMeta.get('lastBankSyncAt')
      if (meta) this.lastSyncAt = Number(meta.value)
      await syncOnStartup()
      const m = await db.syncMeta.get('lastBankSyncAt')
      if (m) this.lastSyncAt = Number(m.value)
      notifyDataChanged()
    },
    /** 触发一次云端题库增量同步（供首页下拉刷新调用） */
    async runBank() {
      this.syncing = true
      const res = await syncBank()
      if (res.ok) {
        const meta = await db.syncMeta.get('lastBankSyncAt')
        if (meta) this.lastSyncAt = Number(meta.value)
        notifyDataChanged()
      }
      this.syncing = false
      return res
    },
  },
})
