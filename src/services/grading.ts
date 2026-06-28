import { isObjective, type Question, type QuestionType } from '@/types'

export type MatchStrategy = 'exact' | 'contains' | 'regex'

export interface GradeResult {
  isCorrect: boolean
  /** 主观题无法自动判分时为 null */
  auto: boolean
}

/**
 * 判分客观题。
 * - 单选/判断：用户答案与标准答案字符串比对
 * - 多选：集合比对（顺序无关）
 * - 填空：按 strategy 比对每个空
 */
export function gradeObjective(
  question: Question,
  userAnswer: string | string[],
  strategy: MatchStrategy = 'contains',
): GradeResult {
  const type = question.type
  const std = question.answer

  if (type === 'single' || type === 'judge') {
    const u = Array.isArray(userAnswer) ? userAnswer[0] : userAnswer
    return { isCorrect: normalize(u) === normalize(std as string), auto: true }
  }

  if (type === 'multiple') {
    const uSet = new Set(toArray(userAnswer).map(normalize))
    const sSet = new Set(toArray(std).map(normalize))
    if (uSet.size !== sSet.size) return { isCorrect: false, auto: true }
    for (const a of uSet) if (!sSet.has(a)) return { isCorrect: false, auto: true }
    return { isCorrect: true, auto: true }
  }

  if (type === 'fill') {
    const uArr = toArray(userAnswer)
    const sArr = toArray(std)
    if (uArr.length !== sArr.length) return { isCorrect: false, auto: true }
    const ok = uArr.every((u, i) => matchFill(u, sArr[i], strategy))
    return { isCorrect: ok, auto: true }
  }

  return { isCorrect: false, auto: false }
}

/** 是否需要自动判分 */
export function isAutoGradable(type: QuestionType): boolean {
  return isObjective(type)
}

function toArray(a: string | string[]): string[] {
  return Array.isArray(a) ? a : [a]
}

function normalize(s: string): string {
  return (s || '').trim().replace(/\s+/g, '').toUpperCase()
}

function matchFill(user: string, std: string, strategy: MatchStrategy): boolean {
  const u = (user || '').trim()
  const s = (std || '').trim()
  if (!u) return false
  if (strategy === 'exact') return u === s
  if (strategy === 'regex') {
    try {
      return new RegExp(s, 'i').test(u)
    } catch {
      return u === s
    }
  }
  // contains（默认）：忽略大小写，去除标点空白后，用户答案须与标准答案
  // 等价 或 用户答案完整包含标准答案（不允许标准答案反向短匹配用户答案）
  const norm = (x: string) =>
    x.toLowerCase().replace(/[\s，。、；：,.;:!！?？'""''()（）]/g, '')
  const nu = norm(u)
  const ns = norm(s)
  if (!ns) return false
  return nu === ns || nu.includes(ns)
}
