import Dexie, { type Table } from 'dexie'
import type {
  Subject,
  Chapter,
  Question,
  Attempt,
  WrongItem,
  ExamSession,
  Attachment,
  SyncMeta,
} from '@/types'

/**
 * deletedAt 约定：用 0 表示"未删除"，时间戳(>0)表示删除时间。
 * 这样 deletedAt 可作为合法索引值，避免 null 索引问题。
 */
export class QADatabase extends Dexie {
  subjects!: Table<Subject, string>
  chapters!: Table<Chapter, string>
  questions!: Table<Question, string>
  attempts!: Table<Attempt, string>
  wrongBook!: Table<WrongItem, string>
  examSessions!: Table<ExamSession, string>
  attachments!: Table<Attachment, string>
  syncMeta!: Table<SyncMeta, string>
  parseCache!: Table<{ hash: string; value: string; createdAt: number }, string>

  constructor() {
    super('QuizBoxDB')
    // version 1：原始（deletedAt 用 null）
    this.version(1).stores({
      subjects: 'id, order, updatedAt, deletedAt',
      chapters: 'id, subjectId, parentId, order, updatedAt, deletedAt',
      questions:
        'id, subjectId, chapterId, type, difficulty, sourceHash, updatedAt, deletedAt, [subjectId+chapterId], [subjectId+type], [subjectId+difficulty]',
      attempts: 'id, questionId, mode, createdAt, isCorrect',
      wrongBook: 'id, questionId, status, nextReviewAt, updatedAt, deletedAt',
      examSessions: 'id, status, startTime',
      attachments: 'hash, synced, size',
      syncMeta: 'key',
    })

    // version 2：新增利于查询的复合索引（[status+nextReviewAt] 用于错题到期查询）
    this.version(2).stores({
      wrongBook:
        'id, questionId, status, nextReviewAt, updatedAt, deletedAt, [status+nextReviewAt]',
      subjects: 'id, order, updatedAt, deletedAt, [deletedAt+order]',
      questions:
        'id, subjectId, chapterId, type, difficulty, sourceHash, updatedAt, deletedAt, [subjectId+chapterId], [subjectId+type], [subjectId+difficulty], [subjectId+deletedAt], [subjectId+chapterId+type]',
    })

    // version 3：AI 低置信块解析结果缓存
    this.version(3).stores({
      parseCache: 'hash, createdAt',
    })
  }
}

export const db = new QADatabase()

/** 生成唯一 ID：基于 crypto.randomUUID（高并发安全） */
export function uid(prefix = ''): string {
  const uuid =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Date.now().toString(36) + Math.random().toString(36).slice(2)
  return prefix + uuid.replace(/-/g, '')
}

/** deletedAt 是否表示未删除（兼容 0 / null / undefined） */
export function isDeleted(deletedAt: number | null | undefined): boolean {
  return !!deletedAt && deletedAt > 0
}
