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
      // deletedAt=0 表示未删除，用单字段索引查询并按 order 排序
      let arr: Subject[]
      try {
        arr = await db.subjects
          .where('deletedAt')
          .equals(0 as any)
          .sortBy('order')
      } catch {
        // 兜底：旧数据 deletedAt 可能为 null
        const all = await db.subjects.toArray()
        arr = all.filter((s) => !isDeleted(s.deletedAt)).sort((a, b) => a.order - b.order)
      }
      this.list = arr
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
      // 级联软删：科目、其下题目、其下章节都要打 tombstone，
      // 否则删了科目后题目仍存活——countAll 不降、继续上云分片、
      // 孤儿清理也救不了（subject 在云端 meta 里是 tombstone 而非"缺失"）。
      await db.transaction('rw', db.subjects, db.questions, db.chapters, async () => {
        const tombstonePatch = { deletedAt: now, updatedAt: now }
        await db.subjects.update(id, tombstonePatch)
        const liveQuestions = await db.questions
          .where('subjectId')
          .equals(id)
          .toArray()
        const deadQs = liveQuestions
          .filter((q) => !isDeleted(q.deletedAt))
          .map((q) => ({ ...q, ...tombstonePatch, revision: (q.revision || 0) + 1 }))
        if (deadQs.length) await db.questions.bulkPut(deadQs)
        const liveChapters = await db.chapters.where('subjectId').equals(id).toArray()
        const deadChapters = liveChapters
          .filter((c) => !isDeleted(c.deletedAt))
          .map((c) => ({ ...c, ...tombstonePatch, revision: (c.revision || 0) + 1 }))
        if (deadChapters.length) await db.chapters.bulkPut(deadChapters)
      })
      autoSync()
      await this.reload()
    },
    async rename(id: string, name: string) {
      await db.subjects.update(id, { name, updatedAt: Date.now() })
      autoSync()
      await this.reload()
    },
    /** 更新科目：名称、颜色等 */
    async update(id: string, patch: Partial<Pick<Subject, 'name' | 'color'>>) {
      await db.subjects.update(id, { ...patch, updatedAt: Date.now() })
      autoSync()
      await this.reload()
    },
  },
})
