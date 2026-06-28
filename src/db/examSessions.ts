import { db, uid } from '@/db'
import type { ExamSession, ExamConfig, ExamStatus } from '@/types'

export const examSessionsRepo = {
  async create(config: ExamConfig, questionIds: string[]): Promise<ExamSession> {
    const s: ExamSession = {
      id: uid('exam_'),
      config,
      questionIds,
      startTime: Date.now(),
      endTime: null,
      answers: {},
      score: null,
      status: 'in_progress',
    }
    await db.examSessions.put(s)
    return s
  },

  async updateAnswers(id: string, answers: Record<string, string | string[]>): Promise<void> {
    await db.examSessions.update(id, { answers })
  },

  async finish(
    id: string,
    opts: { answers: Record<string, string | string[]>; score: number; status?: ExamStatus },
  ): Promise<void> {
    await db.examSessions.update(id, {
      answers: opts.answers,
      score: opts.score,
      endTime: Date.now(),
      status: opts.status || 'finished',
    })
  },

  async abandon(id: string): Promise<void> {
    await db.examSessions.update(id, { status: 'abandoned', endTime: Date.now() })
  },

  async get(id: string): Promise<ExamSession | undefined> {
    return db.examSessions.get(id)
  },

  /** 最近一场进行中的考试（用于恢复） */
  async findInProgress(): Promise<ExamSession | undefined> {
    const arr = await db.examSessions.where('status').equals('in_progress').toArray()
    return arr.sort((a, b) => b.startTime - a.startTime)[0]
  },

  async listRecent(limit = 20): Promise<ExamSession[]> {
    const arr = await db.examSessions.where('status').equals('finished').toArray()
    return arr.sort((a, b) => (b.endTime || 0) - (a.endTime || 0)).slice(0, limit)
  },
}
