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

// ===== 混合流水线：AI 修复低置信度题目 =====

const REPAIR_SYSTEM = `你是题库修复助手。用户给你若干段原始题目文本，规则解析器无法确定其结构。
请逐段解析，去除乱码/无效内容。如果某段不是有效题目则跳过。
输出 JSON：{"questions":[{"blockIndex":0,"type","stem","options","answer","analysis","confidence"}]}
blockIndex 对应输入的序号（从0开始）。type 值：single/multiple/judge/fill/short/essay。
单选/多选 answer 用字母；判断用"T"/"F"；填空用字符串数组。`

const MAX_BATCH_CHARS = 3000

export async function repairWithAI(
  blocks: string[],
): Promise<Map<number, ParsedQuestion>> {
  const repaired = new Map<number, ParsedQuestion>()
  if (blocks.length === 0) return repaired

  // 分批发送，每批不超过 MAX_BATCH_CHARS
  const batches: { startIdx: number; text: string }[] = []
  let batch = ''
  let batchStart = 0

  for (let i = 0; i < blocks.length; i++) {
    const entry = `--- 题目块 ${i} ---\n${blocks[i]}\n`
    if (batch.length + entry.length > MAX_BATCH_CHARS && batch) {
      batches.push({ startIdx: batchStart, text: batch })
      batch = ''
      batchStart = i
    }
    batch += entry
  }
  if (batch) batches.push({ startIdx: batchStart, text: batch })

  // 并行发送所有批次
  const results = await Promise.allSettled(
    batches.map(async (b) => {
      const res = await chatJson<{ questions: Array<ParsedQuestion & { blockIndex: number }> }>(
        [
          { role: 'system', content: REPAIR_SYSTEM },
          { role: 'user', content: b.text },
        ],
        { temperature: 0.1 },
      )
      return res.questions || []
    }),
  )

  for (const r of results) {
    if (r.status !== 'fulfilled') continue
    for (const q of r.value) {
      const { blockIndex, ...question } = q
      if (blockIndex !== undefined && question.stem) {
        question.confidence = Math.max(question.confidence ?? 0.8, 0.7)
        repaired.set(blockIndex, question)
      }
    }
  }

  return repaired
}
