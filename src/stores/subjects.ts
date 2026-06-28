import { defineStore } from 'pinia'
import { db, uid, isDeleted } from '@/db'
import { autoSync } from '@/services/sync'
import type { Subject } from '@/types'

export const useSubjectsStore = defineStore('subjects', {
  state: () => ({
    list: [] as Subject[],
    loaded: false,
  }),
  actions: {
    async load() {
      // deletedAt=0 表示未删除，用 [deletedAt+order] 复合索引高效查询
      let arr: Subject[]
      try {
        arr = await db.subjects
          .where('[deletedAt+order]')
          .equals([0 as any, -Infinity as any])
          .toArray()
          .catch(async () => [])
        if (arr.length === 0) {
          // 该复合索引不便于按 deletedAt=0 全取，改用 filter
          const all = await db.subjects.toArray()
          arr = all.filter((s) => !isDeleted(s.deletedAt))
        }
      } catch {
        const all = await db.subjects.toArray()
        arr = all.filter((s) => !isDeleted(s.deletedAt))
      }
      this.list = arr.sort((a, b) => a.order - b.order)
      this.loaded = true
    },
    async reload() {
      await this.load()
    },
    async create(name: string, color?: string) {
      const subject: Subject = {
        id: uid('sub_'),
        name,
        order: this.list.length,
        color,
        updatedAt: Date.now(),
        deletedAt: 0,
        revision: 1,
      }
      await db.subjects.put(subject)
      this.list.push(subject)
      autoSync()
      return subject
    },
    async remove(id: string) {
      const now = Date.now()
      await db.subjects.update(id, { deletedAt: now, updatedAt: now })
      autoSync()
      await this.reload()
    },
    async rename(id: string, name: string) {
      await db.subjects.update(id, { name, updatedAt: Date.now() })
      autoSync()
      await this.reload()
    },
  },
})
