import { db, uid, isDeleted } from '@/db'
import { sha256 } from '@/utils/hash'
import { autoSync } from '@/services/sync'
import type { Question, QuestionType } from '@/types'

export interface QuestionInput {
  subjectId: string
  chapterId?: string | null
  type: QuestionType
  stem: string
  options?: string[]
  answer: string | string[]
  analysis?: string
  attachments?: string[]
  tags?: string[]
  sourceHash?: string
}

export const questionsRepo = {
  /** 按科目查询未删除题目 */
  async listBySubject(subjectId: string): Promise<Question[]> {
    const arr = await db.questions
      .where('[subjectId+deletedAt]')
      .equals([subjectId, 0 as any])
      .toArray()
      .catch(async () => {
        // 兜底：旧数据 deletedAt 可能为 null
        const all = await db.questions.where('subjectId').equals(subjectId).toArray()
        return all.filter((q) => !isDeleted(q.deletedAt))
      })
    return arr.sort((a, b) => b.updatedAt - a.updatedAt)
  },

  /**
   * 按条件筛选。优先用复合索引缩小范围，剩余条件在内存过滤。
   */
  async filter(opts: {
    subjectId: string
    chapterId?: string
    types?: QuestionType[]
  }): Promise<Question[]> {
    // 选最窄的索引
    let candidates: Question[]
    if (opts.chapterId && (!opts.types || opts.types.length === 1)) {
      candidates = await db.questions
        .where('[subjectId+chapterId]')
        .equals([opts.subjectId, opts.chapterId])
        .toArray()
      candidates = candidates.filter((q) => !isDeleted(q.deletedAt))
    } else {
      candidates = await db.questions.where('subjectId').equals(opts.subjectId).toArray()
      candidates = candidates.filter((q) => !isDeleted(q.deletedAt))
    }

    if (opts.chapterId) candidates = candidates.filter((q) => q.chapterId === opts.chapterId)
    if (opts.types?.length) candidates = candidates.filter((q) => opts.types!.includes(q.type))
    return candidates
  },

  async get(id: string): Promise<Question | undefined> {
    const q = await db.questions.get(id)
    return q && !isDeleted(q.deletedAt) ? q : undefined
  },

  /** 按 id 批量查询未删除题目 */
  async findByIds(ids: string[]): Promise<Question[]> {
    if (ids.length === 0) return []
    const rows = await db.questions.where('id').anyOf(ids).toArray()
    return rows.filter((q) => !isDeleted(q.deletedAt))
  },

  async create(input: QuestionInput): Promise<Question> {
    const now = Date.now()
    const sourceHash =
      input.sourceHash || (await sha256(input.stem + '|' + JSON.stringify(input.answer ?? '')))
    const q: Question = {
      id: uid('q_'),
      subjectId: input.subjectId,
      chapterId: input.chapterId ?? null,
      type: input.type,
      stem: input.stem,
      options: input.options,
      answer: input.answer,
      analysis: input.analysis,
      attachments: input.attachments,
      tags: input.tags,
      sourceHash,
      updatedAt: now,
      deletedAt: 0, // 0 = 未删除
      revision: 1,
    }
    await db.questions.put(q)
    autoSync()
    return q
  },

  async createBulk(inputs: QuestionInput[]): Promise<Question[]> {
    if (inputs.length === 0) return []
    const now = Date.now()
    const rows: Question[] = await Promise.all(
      inputs.map(async (input) => ({
        id: uid('q_'),
        subjectId: input.subjectId,
        chapterId: input.chapterId ?? null,
        type: input.type,
        stem: input.stem,
        options: input.options,
        answer: input.answer,
        analysis: input.analysis,
        attachments: input.attachments,
        tags: input.tags,
        sourceHash:
          input.sourceHash || (await sha256(input.stem + '|' + JSON.stringify(input.answer ?? ''))),
        updatedAt: now,
        deletedAt: 0,
        revision: 1,
      })),
    )
    await db.questions.bulkPut(rows)
    autoSync()
    return rows
  },

  async update(id: string, patch: Partial<QuestionInput>): Promise<void> {
    const existing = await db.questions.get(id)
    if (!existing) return
    const now = Date.now()
    await db.questions.update(id, {
      ...patch,
      updatedAt: now,
      revision: (existing.revision || 0) + 1,
    })
    autoSync()
  },

  async moveToSubject(ids: string[], subjectId: string): Promise<void> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return
    const now = Date.now()
    await db.transaction('rw', db.questions, async () => {
      for (const id of uniqueIds) {
        const existing = await db.questions.get(id)
        if (!existing || isDeleted(existing.deletedAt)) continue
        await db.questions.update(id, {
          subjectId,
          updatedAt: now,
          revision: (existing.revision || 0) + 1,
        })
      }
    })
    autoSync()
  },

  async remove(id: string): Promise<void> {
    const now = Date.now()
    await db.questions.update(id, { deletedAt: now, updatedAt: now })
    autoSync()
  },

  async removeBulk(ids: string[]): Promise<void> {
    const uniqueIds = [...new Set(ids.filter(Boolean))]
    if (!uniqueIds.length) return
    const now = Date.now()
    await db.transaction('rw', db.questions, async () => {
      await db.questions.bulkUpdate(
        uniqueIds.map((id) => ({
          key: id,
          changes: { deletedAt: now, updatedAt: now },
        })),
      )
    })
    autoSync()
  },

  /** 去重检测：同 sourceHash 视为重复 */
  async findDuplicate(subjectId: string, hash: string): Promise<Question | undefined> {
    const arr = await db.questions.where('sourceHash').equals(hash).toArray()
    return arr.find((q) => q.subjectId === subjectId && !isDeleted(q.deletedAt))
  },

  async findDuplicateHashes(subjectId: string, hashes: string[]): Promise<Set<string>> {
    const uniqueHashes = [...new Set(hashes.filter(Boolean))]
    if (uniqueHashes.length === 0) return new Set()
    const rows = await db.questions.where('sourceHash').anyOf(uniqueHashes).toArray()
    return new Set(
      rows
        .filter((q) => q.subjectId === subjectId && q.sourceHash && !isDeleted(q.deletedAt))
        .map((q) => q.sourceHash!),
    )
  },

  /** 高效计数：用索引 count 而非拉全表 */
  async countBySubject(subjectId: string): Promise<number> {
    try {
      return await db.questions
        .where('[subjectId+deletedAt]')
        .equals([subjectId, 0 as any])
        .count()
    } catch {
      const all = await db.questions.where('subjectId').equals(subjectId).toArray()
      return all.filter((q) => !isDeleted(q.deletedAt)).length
    }
  },

  /** 全库未删除题目总数（单次索引 count，避免 N+1） */
  async countAll(): Promise<number> {
    try {
      return await db.questions
        .where('deletedAt')
        .equals(0 as any)
        .count()
    } catch {
      const all = await db.questions.toArray()
      return all.filter((q) => !isDeleted(q.deletedAt)).length
    }
  },

  /**
   * 搜索题干（按 stem/选项/解析 模糊匹配）。
   * 用 updatedAt 索引降序遍历，命中即收，最多 100 条，避免全量实例化。
   */
  async search(keyword: string): Promise<Question[]> {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return []
    const results: Question[] = []
    await db.questions
      .orderBy('updatedAt')
      .reverse()
      .until(() => results.length >= 100)
      .each((q) => {
        if (isDeleted(q.deletedAt)) return
        if (
          q.stem.toLowerCase().includes(kw) ||
          (q.analysis || '').toLowerCase().includes(kw) ||
          (q.options || []).some((o) => o.toLowerCase().includes(kw))
        ) {
          results.push(q)
        }
      })
    return results
  },
}
