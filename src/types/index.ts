// ===== 基础类型 =====

/** 题目类型 */
export type QuestionType =
  | 'single' // 单选
  | 'multiple' // 多选
  | 'judge' // 判断
  | 'fill' // 填空
  | 'short' // 简答
  | 'essay' // 论述

export const QUESTION_TYPE_LABELS: Record<QuestionType, string> = {
  single: '单选题',
  multiple: '多选题',
  judge: '判断题',
  fill: '填空题',
  short: '简答题',
  essay: '论述题',
}

/** 是否为客观题（系统可自动判分） */
export function isObjective(type: QuestionType): boolean {
  return type === 'single' || type === 'multiple' || type === 'judge' || type === 'fill'
}

/** 难度 */
export type Difficulty = 'easy' | 'medium' | 'hard'
export const DIFFICULTY_LABELS: Record<Difficulty, string> = {
  easy: '简单',
  medium: '中等',
  hard: '困难',
}

/** 同步用的软删除/时间戳基类 */
export interface SyncRecord {
  updatedAt: number
  deletedAt: number | null
  revision: number
}

// ===== 数据表 =====

export interface Subject extends SyncRecord {
  id: string
  name: string
  order: number
  color?: string
}

export interface Chapter extends SyncRecord {
  id: string
  subjectId: string
  parentId: string | null
  name: string
  order: number
}

export interface Question extends SyncRecord {
  id: string
  subjectId: string
  chapterId: string | null
  type: QuestionType
  /** 题干，富文本 JSON 或含 LaTeX 的字符串 */
  stem: string
  /** 选项（选择题用） */
  options?: string[]
  /** 标准答案；单选为字母索引，多选为字母数组，判断为 'T'|'F'，填空为字符串数组，主观题为参考答案 */
  answer: string | string[]
  /** 解析 */
  analysis?: string
  /** 附件图片哈希列表 */
  attachments?: string[]
  difficulty: Difficulty
  tags?: string[]
  /** 内容哈希，用于去重 */
  sourceHash?: string
}

export type ExamMode = 'practice' | 'exam'
export type AttemptMode = 'practice' | 'exam'

export interface Attempt {
  id: string
  questionId: string
  mode: AttemptMode
  userAnswer: string | string[]
  /** 客观题是否正确 */
  isCorrect?: boolean
  /** 主观题 AI 评分 0-100 */
  aiScore?: number
  /** 主观题 AI 评语 */
  aiFeedback?: string
  /** 主观题自评 0-100 */
  selfRating?: number
  createdAt: number
}

export type WrongStatus = 'pending' | 'mastered'

export interface WrongItem extends SyncRecord {
  id: string
  questionId: string
  reason?: string
  status: WrongStatus
  reviewCount: number
  lastReviewAt: number | null
  /** SM-2 算法：下次复习时间 */
  nextReviewAt: number | null
  /** SM-2 easiness 因子 */
  easiness: number
  /** SM-2 间隔（天） */
  interval: number
}

export type ExamStatus = 'in_progress' | 'finished' | 'abandoned'
export type ExamSubMode =
  | 'classic' // 传统限时
  | 'wrong_redo' // 错题重做
  | 'random' // 随机抽查
  | 'shuffle' // 乱序练习
  | 'weak' // 薄弱点加权

export interface ExamConfig {
  subjectId: string
  chapterIds?: string[]
  questionTypes?: QuestionType[]
  difficulty?: Difficulty
  count: number
  durationMin?: number
  subMode: ExamSubMode
}

export interface ExamSession {
  id: string
  config: ExamConfig
  questionIds: string[]
  startTime: number
  endTime: number | null
  answers: Record<string, string | string[]>
  score: number | null
  status: ExamStatus
}

export interface Attachment {
  hash: string
  blob: Blob
  size: number
  synced: boolean
}

export interface SyncMeta {
  key: string
  value: string
}
