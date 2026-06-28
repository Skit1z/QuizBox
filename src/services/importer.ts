import { chatJson } from './ai'
import type { QuestionType } from '@/types'

/** AI 解析返回的单道题（中间结构） */
export interface ParsedQuestion {
  type: QuestionType
  stem: string
  options?: string[]
  answer: string | string[]
  analysis?: string
  /** 文本中引用的图片占位索引 [IMG_n]，转成 hash 由调用方处理 */
  imagePlaceholders?: string[]
  /** AI 置信度，用于标红低置信项 */
  confidence?: number
}

const SYSTEM_PROMPT = `你是一个题库结构化解析助手。用户会给你一段从 Word 文档提取的题目文本（图片位置用 [IMG_n] 表示）。
请把它解析为结构化的题目数组。要求：
1. 识别每道题的题型：single(单选) multiple(多选) judge(判断) fill(填空) short(简答) essay(论述)
2. 单选/多选 answer 用字母（如 "A" 或 ["A","C"]）；判断 answer 用 "T" 或 "F"；填空 answer 用字符串数组（每个空一个）；简答/论述 answer 用参考答案文本
3. 保留题干中的 [IMG_n] 占位符原样
4. 如果文本不是题目或无法识别，跳过它
5. 为每题给出 confidence (0-1)，表示解析把握度

严格以 JSON 输出，格式：{"questions":[{"type","stem","options","answer","analysis","imagePlaceholders","confidence"}]}`

export async function parseQuestionsWithAI(
  text: string,
  hint?: string,
): Promise<ParsedQuestion[]> {
  const userContent = hint
    ? `${hint}\n\n===题目文本===\n${text}`
    : `===题目文本===\n${text}`

  const result = await chatJson<{ questions: ParsedQuestion[] }>(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userContent },
    ],
    { temperature: 0.1 },
  )
  return result.questions || []
}
