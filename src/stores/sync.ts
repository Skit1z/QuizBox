import { defineStore } from 'pinia'
import { sync, syncBank, syncOnStartup, autoSync } from '@/services/sync'
import { db } from '@/db'

function notifyDataChanged() {
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('quizbox:data-changed'))
  }
}

export const useSyncStore = defineStore('sync', {
  state: () => ({
    lastSyncAt: 0 as number,
    syncing: false,
    lastResult: null as { pulled: number; pushed: number; ok: boolean } | null,
  }),
  actions: {
    /** 写操作后调用，触发防抖自动同步 */
    notifyChange() {
      notifyDataChanged()
      autoSync()
    },
    async init() {
      const meta = await db.syncMeta.get('lastSyncAt')
      if (meta) this.lastSyncAt = Number(meta.value)
      await syncOnStartup()
      const m = await db.syncMeta.get('lastSyncAt')
      if (m) this.lastSyncAt = Number(m.value)
      notifyDataChanged()
    },
    async run() {
      this.syncing = true
      const res = await sync()
      this.lastResult = res
      if (res.ok) {
        const meta = await db.syncMeta.get('lastSyncAt')
        if (meta) this.lastSyncAt = Number(meta.value)
        notifyDataChanged()
      }
      this.syncing = false
      return res
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
