import { db, uid, isDeleted } from '@/db'
import { sha256 } from '@/utils/hash'
import { autoSync } from '@/services/sync'
import type { Question, Difficulty, QuestionType } from '@/types'

export interface QuestionInput {
  subjectId: string
  chapterId?: string | null
  type: QuestionType
  stem: string
  options?: string[]
  answer: string | string[]
  analysis?: string
  attachments?: string[]
  difficulty?: Difficulty
  tags?: string[]
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
    difficulty?: Difficulty
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
      candidates = await db.questions
        .where('subjectId')
        .equals(opts.subjectId)
        .toArray()
      candidates = candidates.filter((q) => !isDeleted(q.deletedAt))
    }

    if (opts.chapterId) candidates = candidates.filter((q) => q.chapterId === opts.chapterId)
    if (opts.types?.length) candidates = candidates.filter((q) => opts.types!.includes(q.type))
    if (opts.difficulty) candidates = candidates.filter((q) => q.difficulty === opts.difficulty)
    return candidates
  },

  async get(id: string): Promise<Question | undefined> {
    const q = await db.questions.get(id)
    return q && !isDeleted(q.deletedAt) ? q : undefined
  },

  async create(input: QuestionInput): Promise<Question> {
    const now = Date.now()
    const sourceHash = await sha256(
      input.stem + '|' + JSON.stringify(input.answer ?? ''),
    )
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
      difficulty: input.difficulty || 'medium',
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

  async remove(id: string): Promise<void> {
    const now = Date.now()
    await db.questions.update(id, { deletedAt: now, updatedAt: now })
    autoSync()
  },

  /** 去重检测：同 sourceHash 视为重复 */
  async findDuplicate(subjectId: string, hash: string): Promise<Question | undefined> {
    const arr = await db.questions
      .where('sourceHash')
      .equals(hash)
      .toArray()
    return arr.find((q) => q.subjectId === subjectId && !isDeleted(q.deletedAt))
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

  /** 搜索题干（全表 like 过滤，题量大时仍优于前端手动） */
  async search(keyword: string): Promise<Question[]> {
    const kw = keyword.trim().toLowerCase()
    if (!kw) return []
    const all = await db.questions.toArray()
    return all
      .filter((q) => !isDeleted(q.deletedAt))
      .filter(
        (q) =>
          q.stem.toLowerCase().includes(kw) ||
          (q.analysis || '').toLowerCase().includes(kw) ||
          (q.options || []).some((o) => o.toLowerCase().includes(kw)),
      )
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 100)
  },
}
