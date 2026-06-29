import { db, uid, isDeleted } from '@/db'
import { sm2Next, qualityFromResult } from '@/utils/sm2'
import type { WrongItem, WrongStatus } from '@/types'

export const wrongBookRepo = {
  /** 记录一次做题结果，错则加入/更新错题本，对则按 SM-2 更新 */
  async recordAttempt(opts: {
    questionId: string
    isCorrect: boolean
    selfRating?: number
    reason?: string
  }): Promise<WrongItem | undefined> {
    const existing = await db.wrongBook.where('questionId').equals(opts.questionId).first()
    const now = Date.now()

    if (!opts.isCorrect) {
      if (existing && !isDeleted(existing.deletedAt)) {
        const updated: Partial<WrongItem> = {
          status: 'pending',
          reason: opts.reason || existing.reason,
          lastReviewAt: now,
          nextReviewAt: now,
          interval: 0,
          reviewCount: 0,
          updatedAt: now,
          revision: (existing.revision || 0) + 1,
        }
        await db.wrongBook.update(existing.id, updated)
        return { ...existing, ...updated } as WrongItem
      }
      const item: WrongItem = {
        id: uid('w_'),
        questionId: opts.questionId,
        reason: opts.reason,
        status: 'pending',
        reviewCount: 0,
        lastReviewAt: now,
        nextReviewAt: now,
        easiness: 2.5,
        interval: 0,
        updatedAt: now,
        deletedAt: 0,
        revision: 1,
      }
      await db.wrongBook.put(item)
      return item
    }

    if (existing && !isDeleted(existing.deletedAt)) {
      const q = qualityFromResult(true, opts.selfRating)
      const next = sm2Next(existing, q)
      const mastered = next.interval >= 21
      const patch: Partial<WrongItem> = {
        easiness: next.easiness,
        interval: next.interval,
        reviewCount: next.reviewCount,
        lastReviewAt: now,
        nextReviewAt: next.nextReviewAt,
        status: (mastered ? 'mastered' : 'pending') as WrongStatus,
        updatedAt: now,
        revision: (existing.revision || 0) + 1,
      }
      await db.wrongBook.update(existing.id, patch)
      return { ...existing, ...patch } as WrongItem
    }
    return undefined
  },

  /** 到期需复习的错题：用 [status+nextReviewAt] 复合索引 */
  async listPending(): Promise<WrongItem[]> {
    const now = Date.now()
    try {
      // status='pending' 且 nextReviewAt <= now
      const arr = await db.wrongBook
        .where('[status+nextReviewAt]')
        .between(['pending', 0], ['pending', now], true, true)
        .toArray()
      return arr
        .filter((w) => !isDeleted(w.deletedAt))
        .sort((a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0))
    } catch {
      const all = await db.wrongBook.toArray()
      return all
        .filter((w) => !isDeleted(w.deletedAt) && w.status === 'pending')
        .filter((w) => !w.nextReviewAt || w.nextReviewAt <= now)
        .sort((a, b) => (a.nextReviewAt || 0) - (b.nextReviewAt || 0))
    }
  },

  /** 所有待复习错题（不论是否到期） */
  async listAll(): Promise<WrongItem[]> {
    try {
      const arr = await db.wrongBook.where('status').equals('pending').toArray()
      return arr.filter((w) => !isDeleted(w.deletedAt))
    } catch {
      const all = await db.wrongBook.toArray()
      return all.filter((w) => !isDeleted(w.deletedAt) && w.status === 'pending')
    }
  },

  /** 按题目 id 批量取错题记录 */
  async listByQuestionIds(ids: string[]): Promise<WrongItem[]> {
    if (ids.length === 0) return []
    const map = new Map<string, WrongItem>()
    await db.wrongBook
      .where('questionId')
      .anyOf(ids)
      .each((w) => {
        if (!isDeleted(w.deletedAt)) map.set(w.questionId, w)
      })
    return [...map.values()]
  },

  async setStatus(id: string, status: WrongStatus): Promise<void> {
    const existing = await db.wrongBook.get(id)
    await db.wrongBook.update(id, {
      status,
      updatedAt: Date.now(),
      revision: (existing?.revision || 0) + 1,
    })
  },

  /** 批量更新状态（单次事务，避免 N 次写入） */
  async setStatusBulk(ids: string[], status: WrongStatus): Promise<void> {
    const now = Date.now()
    const rows = await db.wrongBook.where('id').anyOf(ids).toArray()
    const revisionMap = new Map(rows.map((row) => [row.id, (row.revision || 0) + 1]))
    await db.wrongBook.bulkUpdate(
      ids.map((id) => ({
        key: id,
        changes: { status, updatedAt: now, revision: revisionMap.get(id) || 1 },
      })),
    )
  },

  /** 把所有待复习错题标记为已掌握（单次 modify） */
  async markAllMastered(): Promise<void> {
    const now = Date.now()
    await db.wrongBook
      .where('status')
      .equals('pending')
      .modify((row) => {
        row.status = 'mastered'
        row.updatedAt = now
        row.revision = (row.revision || 0) + 1
      })
  },
}
