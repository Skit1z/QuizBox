import { db, uid } from '@/db'
import type { Attempt, AttemptMode } from '@/types'

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
    return a
  },

  async listByQuestion(questionId: string): Promise<Attempt[]> {
    const all = await db.attempts.where('questionId').equals(questionId).toArray()
    return all.sort((a, b) => b.createdAt - a.createdAt)
  },
}
