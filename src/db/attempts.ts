import Dexie from 'dexie'
import { db, uid } from '@/db'
import type { Attempt, AttemptMode } from '@/types'

/** 每题最多保留的答题记录数（超过则删最旧的，控制表无限增长） */
const MAX_ATTEMPTS_PER_QUESTION = 50

export const attemptsRepo = {
  async record(input: {
    questionId: string
    mode: AttemptMode
    userAnswer: string | string[]
    isCorrect?: boolean
    aiScore?: number
    aiFeedback?: string
    selfRating?: number
  }): Promise<Attempt> {
    const a: Attempt = {
      id: uid('att_'),
      questionId: input.questionId,
      mode: input.mode,
      userAnswer: input.userAnswer,
      isCorrect: input.isCorrect,
      aiScore: input.aiScore,
      aiFeedback: input.aiFeedback,
      selfRating: input.selfRating,
      createdAt: Date.now(),
    }
    await db.attempts.put(a)
    // 写入后裁剪：每题保留最近 N 条，删最旧的（不阻塞答题流程）
    void pruneAttempts(input.questionId)
    return a
  },

  async getAttemptedQuestionIds(questionIds: string[]): Promise<Set<string>> {
    if (questionIds.length === 0) return new Set()
    // 只取 questionId 索引键，不加载整行（避免反序列化 aiFeedback 等长文本）
    const keys = await db.attempts.where('questionId').anyOf(questionIds).keys()
    return new Set(keys as string[])
  },
}

/** 裁剪指定题目的答题记录，保留最近 MAX_ATTEMPTS_PER_QUESTION 条 */
async function pruneAttempts(questionId: string): Promise<void> {
  try {
    const count = await db.attempts.where('questionId').equals(questionId).count()
    if (count <= MAX_ATTEMPTS_PER_QUESTION) return
    // 复合索引先按时间升序排列，超出上限时只删除最旧记录。
    const excess = count - MAX_ATTEMPTS_PER_QUESTION
    await db.attempts
      .where('[questionId+createdAt]')
      .between([questionId, Dexie.minKey], [questionId, Dexie.maxKey])
      .limit(excess)
      .delete()
  } catch {
    // 裁剪失败不影响答题
  }
}
