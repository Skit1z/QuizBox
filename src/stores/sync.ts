import { defineStore } from 'pinia'
import { sync, syncOnStartup, autoSync } from '@/services/sync'
import { db } from '@/db'

export const useSyncStore = defineStore('sync', {
  state: () => ({
    lastSyncAt: 0 as number,
    syncing: false,
    lastResult: null as { pulled: number; pushed: number; ok: boolean } | null,
  }),
  actions: {
    /** 写操作后调用，触发防抖自动同步 */
    notifyChange() {
      autoSync()
    },
    async init() {
      const meta = await db.syncMeta.get('lastSyncAt')
      if (meta) this.lastSyncAt = Number(meta.value)
      await syncOnStartup()
      const m = await db.syncMeta.get('lastSyncAt')
      if (m) this.lastSyncAt = Number(m.value)
    },
    async run() {
      this.syncing = true
      const res = await sync()
      this.lastResult = res
      if (res.ok) {
        const meta = await db.syncMeta.get('lastSyncAt')
        if (meta) this.lastSyncAt = Number(meta.value)
      }
      this.syncing = false
      return res
    },
  },
})
