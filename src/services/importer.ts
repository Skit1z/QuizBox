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

const MAX_BATCH_CHARS = 4000
const MAX_BATCH_BLOCKS = 15

const SYSTEM_PROMPT = `你是一个题库结构化解析助手。用户给你若干道题的原始文本（已是按题切分的块，每个块是一道题及其选项/答案/解析）。
请逐块解析为结构化题目。要求：
1. 识别每道题的题型：single(单选) multiple(多选) judge(判断) fill(填空) short(简答) essay(论述)
2. 单选/多选 answer 用字母（如 "A" 或 ["A","C"]）；判断 answer 用 "T" 或 "F"；填空 answer 用字符串数组（每个空一个）；简答/论述 answer 用参考答案文本
3. 保留题干中的 [IMG_n] 占位符原样
4. 去除乱码、页眉页脚、无效符号
5. 为每题给出 blockId（与输入对应）和 confidence (0-1)

严格以 JSON 输出：{"questions":[{"blockId":"block_0","type","stem","options","answer","analysis","imagePlaceholders","confidence"}]}
blockId 必须原样使用输入中的标注。`

// ===== 纯 AI 模式：分批解析整篇文本 =====

const RE_NUM = /^[ \t]*[(（\[【]?\d{1,3}[)）\]】]?[.、．)\s]/

/**
 * 把整篇文本按题号切成块（用于纯 AI 模式分批）。
 */
function splitTextIntoBlocks(text: string): string[] {
  const lines = text.split('\n')
  const blocks: string[] = []
  let current: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) {
      if (current.length) current.push('')
      continue
    }
    if (RE_NUM.test(trimmed) && current.length) {
      blocks.push(current.join('\n').trim())
      current = [trimmed]
    } else {
      current.push(trimmed)
    }
  }
  if (current.length) blocks.push(current.join('\n').trim())
  return blocks.filter((b) => b.length >= 5)
}

/**
 * 纯 AI 解析整篇文档（分批发送，避免输出 token 上限导致丢题）。
 * 适用于 rule-parser 无法处理的复杂格式。
 */
export async function parseQuestionsWithAI(
  text: string,
  hint?: string,
  onProgress?: (done: number, total: number) => void,
): Promise<ParsedQuestion[]> {
  const blocks = splitTextIntoBlocks(text)
  if (blocks.length === 0) return []

  // 分批：按题数和字符数双重限制
  const batches: { indices: number[]; text: string }[] = []
  let batchText = ''
  let batchIndices: number[] = []

  for (let i = 0; i < blocks.length; i++) {
    const entry = `--- blockId: block_${i} ---\n${blocks[i]}\n`
    const wouldExceed =
      batchIndices.length >= MAX_BATCH_BLOCKS ||
      (batchText.length + entry.length > MAX_BATCH_CHARS && batchText)

    if (wouldExceed) {
      batches.push({ indices: batchIndices, text: batchText })
      batchText = ''
      batchIndices = []
    }
    batchText += entry
    batchIndices.push(i)
  }
  if (batchText) batches.push({ indices: batchIndices, text: batchText })

  const results = new Map<number, ParsedQuestion>()
  let done = 0
  for (const batch of batches) {
    const prefix = hint ? `${hint}\n\n` : ''
    try {
      const res = await chatJson<{
        questions: Array<ParsedQuestion & { blockId?: string }>
      }>(
        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: prefix + batch.text },
        ],
        { temperature: 0.1 },
      )
      for (const q of res.questions || []) {
        const m = q.blockId?.match(/^block_(\d+)$/)
        const idx = m ? Number(m[1]) : undefined
        if (idx !== undefined && idx >= 0 && idx < blocks.length && q.stem) {
          const { blockId, ...question } = q
          results.set(idx, question as ParsedQuestion)
        }
      }
    } catch (e) {
      console.warn('[importer] batch failed', e)
    }
    done++
    onProgress?.(done, batches.length)
  }

  return blocks
    .map((_, i) => results.get(i))
    .filter((q): q is ParsedQuestion => !!q)
}

// ===== AI 修复：rule-parser 低置信度题目的二次解析 =====

const REPAIR_SYSTEM = `你是题库修复助手。用户给你若干段原始题目文本，规则解析器无法确定其结构。
请逐段解析，去除乱码/无效内容。如果某段不是有效题目则跳过。
输出 JSON：{"questions":[{"blockId":"block_0","type","stem","options","answer","analysis","confidence"}]}
blockId 必须原样使用输入中标注的 blockId，不要重新编号。type 值：single/multiple/judge/fill/short/essay。
单选/多选 answer 用字母；判断用"T"/"F"；填空用字符串数组。`

/**
 * 对 rule-parser 识别为低置信度的文本块做 AI 二次修复。
 * 分批发送，返回 块索引 → 修复后题目 的映射。
 */
export async function repairWithAI(
  blocks: string[],
): Promise<Map<number, ParsedQuestion>> {
  const repaired = new Map<number, ParsedQuestion>()
  if (blocks.length === 0) return repaired

  // 分批
  const batches: { indices: number[]; text: string }[] = []
  let batch = ''
  let batchIndices: number[] = []

  for (let i = 0; i < blocks.length; i++) {
    const entry = `--- blockId: block_${i} ---\n${blocks[i]}\n`
    if (batch.length + entry.length > MAX_BATCH_CHARS && batch) {
      batches.push({ indices: batchIndices, text: batch })
      batch = ''
      batchIndices = []
    }
    batch += entry
    batchIndices.push(i)
  }
  if (batch) batches.push({ indices: batchIndices, text: batch })

  // 串行发送（避免限流）
  for (const b of batches) {
    try {
      const res = await chatJson<{
        questions: Array<ParsedQuestion & { blockId?: string; blockIndex?: number }>
      }>(
        [
          { role: 'system', content: REPAIR_SYSTEM },
          { role: 'user', content: b.text },
        ],
        { temperature: 0.1 },
      )
      for (const q of res.questions || []) {
        const { blockId, blockIndex, ...question } = q
        const idMatch = blockId?.match(/^block_(\d+)$/)
        let idx = idMatch ? Number(idMatch[1]) : undefined

        if (idx === undefined && blockIndex !== undefined) {
          idx = b.indices.includes(blockIndex)
            ? blockIndex
            : b.indices[blockIndex]
        }

        if (idx !== undefined && idx >= 0 && idx < blocks.length && question.stem) {
          question.confidence = Math.max(question.confidence ?? 0.8, 0.7)
          repaired.set(idx, question as ParsedQuestion)
        }
      }
    } catch (e) {
      console.warn('[importer] repair batch failed', e)
    }
  }

  return repaired
}
