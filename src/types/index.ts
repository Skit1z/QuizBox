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

/** 同步用的软删除/时间戳基类 */
export interface SyncRecord {
  updatedAt: number
  /** 0 表示未删除，时间戳(>0)表示软删除时间；兼容读取旧 null 数据由 isDeleted 处理 */
  deletedAt: number
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
  | 'practice' // 自测
  | 'classic' // 传统限时
  | 'wrong_redo' // 错题重做
  | 'random' // 随机抽查
  | 'shuffle' // 乱序练习
  | 'weak' // 薄弱点加权

export interface ExamConfig {
  subjectId: string
  chapterIds?: string[]
  questionTypes?: QuestionType[]
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

// ===== 云端题库分片同步（v2：按科目分片 + 哈希增量） =====

/** Meta 分片：subjects + chapters 的元数据 */
export interface MetaShard {
  subjects: Record<string, Subject>
  chapters: Record<string, Chapter>
  /** 管理员密码哈希（SHA-256），跨设备共享；空字符串表示未设置 */
  adminPwdHash?: string
}

/** 单个题目分片（按科目分组，超出 250KB 自动拆分） */
export interface QuestionShard {
  subjectId: string
  /** 分片序号（0 为主分片，1+ 为溢出） */
  index: number
  /** id → Question */
  questions: Record<string, Question>
}

/** Manifest 中每个分片的索引条目 */
export interface ShardEntry {
  /** Blob 路径，如 "quizbox/shard_sub_abc123_0.json" */
  path: string
  /** 对应科目 ID */
  subjectId: string
  /** 分片序号 */
  index: number
  /** 内容的 SHA-256 哈希 */
  hash: string
  /** 字节数 */
  size: number
  /** 包含的题目数量 */
  count: number
  /** 分片内最新 updatedAt */
  updatedAt: number
}

/** 云端题库索引文件 */
export interface BankManifest {
  /** 格式版本（v2 = 分片增量） */
  version: 2
  /** 生成时间戳 */
  updatedAt: number
  /** subjects + chapters 的元数据分片 */
  meta: {
    /** "quizbox/meta.json" */
    path: string
    /** 内容的 SHA-256 */
    hash: string
    /** 字节数 */
    size: number
  }
  /** 题目分片列表 */
  shards: ShardEntry[]
}
