import { chatJson } from './ai'
import type { QuestionType } from '@/types'
import { db } from '@/db'
import { sha256 } from '@/utils/hash'
import { detectType, normalizeAnswer, splitRawChunks } from './rule-parser'

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

const SINGLE_CALL_LIMIT = 6000
const MAX_BATCH_CHARS = 8000
const MAX_BATCH_BLOCKS = 15
const CACHE_VERSION = 'repair-v1'

const SYSTEM_PROMPT = `你是一个题库结构化解析助手。用户给你若干道题的原始文本（已是按题切分的块，每个块是一道题及其选项/答案/解析）。
请逐块解析为结构化题目。要求：
1. 识别每道题的题型：single(单选) multiple(多选) judge(判断) fill(填空) short(简答) essay(论述)
2. 单选/多选 answer 用字母（如 "A" 或 ["A","C"]）；判断 answer 用 "T" 或 "F"；填空 answer 用字符串数组（每个空一个）；简答/论述 answer 用参考答案文本
3. 保留题干中的 [IMG_n] 占位符原样
4. 去除乱码、页眉页脚、无效符号
5. 为每题给出 blockId（与输入对应）和 confidence (0-1)

严格以 JSON 输出：{"questions":[{"blockId":"block_0","type","stem","options","answer","analysis","imagePlaceholders","confidence"}]}
blockId 必须原样使用输入中的标注。`

type IndexedBlock = { idx: number; text: string }

function packByChars(
  items: IndexedBlock[],
  limit: number,
): Array<{ items: IndexedBlock[]; text: string }> {
  const batches: Array<{ items: IndexedBlock[]; text: string }> = []
  let batchItems: IndexedBlock[] = []
  let batchText = ''

  for (const item of items) {
    const entry = `--- blockId: block_${item.idx} ---\n${item.text}\n`
    const wouldExceed =
      batchItems.length >= MAX_BATCH_BLOCKS ||
      (batchText.length + entry.length > limit && batchText.length > 0)

    if (wouldExceed) {
      batches.push({ items: batchItems, text: batchText })
      batchItems = []
      batchText = ''
    }

    batchItems.push(item)
    batchText += entry
  }

  if (batchText) batches.push({ items: batchItems, text: batchText })
  return batches
}

function dedupeByStem(questions: ParsedQuestion[]): ParsedQuestion[] {
  const seen = new Set<string>()
  const result: ParsedQuestion[] = []

  for (const q of questions) {
    const key = q.stem.trim().replace(/\s+/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    result.push(q)
  }

  return result
}

export function sanitizeParsed(q: ParsedQuestion): ParsedQuestion | null {
  const stem = (q.stem || '').trim()
  if (!stem) return null

  const options = q.options?.map((option) => (option ?? '').toString().trim()).filter(Boolean) ?? []
  const rawAnswer = Array.isArray(q.answer) ? q.answer.join('') : (q.answer ?? '').toString()
  const shouldPreserveSubjective =
    (q.type === 'short' || q.type === 'essay') &&
    options.length === 0 &&
    !/[A-Ha-h]/.test(rawAnswer)
  const type = shouldPreserveSubjective ? q.type : detectType(stem, options, rawAnswer)
  const answer = normalizeAnswer(type, rawAnswer, options)

  return {
    ...q,
    type,
    stem,
    options: options.length ? options : undefined,
    answer,
    confidence: Math.max(0, Math.min(q.confidence ?? 0.8, 1)),
  }
}

async function callParseBatch(
  batchText: string,
  hint?: string,
  systemPrompt = SYSTEM_PROMPT,
): Promise<Map<number, ParsedQuestion>> {
  const prefix = hint ? `${hint}\n\n` : ''
  const res = await chatJson<{
    questions: Array<ParsedQuestion & { blockId?: string; blockIndex?: number }>
  }>(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: prefix + batchText },
    ],
    { temperature: 0.1 },
  )

  const parsed = new Map<number, ParsedQuestion>()
  for (const q of res.questions || []) {
    const { blockId, blockIndex, ...question } = q
    const idMatch = blockId?.match(/^block_(\d+)$/)
    const idx = idMatch ? Number(idMatch[1]) : blockIndex
    if (idx === undefined || idx < 0 || !question.stem) continue

    const sanitized = sanitizeParsed(question as ParsedQuestion)
    if (sanitized) parsed.set(idx, sanitized)
  }

  return parsed
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
  const chunks = splitRawChunks(text)
  const blocks = (chunks.length > 0 ? chunks : [text]).map((block, idx) => ({ idx, text: block }))
  if (blocks.length === 0) return []

  const batches =
    text.length <= SINGLE_CALL_LIMIT
      ? [{ items: blocks, text: packByChars(blocks, Number.POSITIVE_INFINITY)[0]?.text ?? '' }]
      : packByChars(blocks, MAX_BATCH_CHARS)

  const results = new Map<number, ParsedQuestion>()

  if (text.length <= SINGLE_CALL_LIMIT) {
    try {
      const parsed = await callParseBatch(batches[0].text, hint)
      for (const [idx, question] of parsed) results.set(idx, question)
    } catch (e) {
      console.warn('[importer] parse failed', e)
    }
    onProgress?.(1, 1)
  } else {
    const settled = await Promise.allSettled(
      batches.map((batch) => callParseBatch(batch.text, hint)),
    )
    settled.forEach((result, batchIdx) => {
      if (result.status === 'fulfilled') {
        for (const [idx, question] of result.value) results.set(idx, question)
      } else {
        console.warn('[importer] batch failed', result.reason)
      }
      onProgress?.(batchIdx + 1, batches.length)
    })
  }

  return dedupeByStem(blocks.map((_, i) => results.get(i)).filter((q): q is ParsedQuestion => !!q))
}

// ===== AI 判定：对规则解析不确定的块做结构化判定 =====

const JUDGE_SYSTEM = `你是题库解析助手。用户给你若干段从 Word 文档提取的原始文本块，规则解析器无法确定其中一些的结构。
请逐块判定：该块是否是一道有效题目？如果是，解析其结构；如果不是（如标题、说明、目录），跳过。

解析要求：
1. 识别题型：single(单选) multiple(多选) judge(判断) fill(填空) short(简答) essay(论述)
2. 单选/多选 answer 用字母（如 "A" 或 ["A","C"]）；判断用 "T"/"F"；填空用字符串数组
3. 去除乱码、题号前缀、bullet 符号、页眉页脚
4. 选项要完整提取（每个选项单独一项）

输出 JSON：{"questions":[{"blockId":"block_0","type","stem","options","answer","analysis","confidence"}]}
- blockId 必须原样使用输入中标注的，不要重新编号
- 不是题目的块不要输出（自然跳过）
- confidence 表示你对此块解析的把握 (0-1)`

/**
 * 对规则解析不确定的文本块做 AI 判定与结构化。
 * 分批发送，返回 块索引 → 解析后题目 的映射。
 * 未出现在返回映射中的块 = AI 判定为非题目。
 */
export async function repairWithAI(
  blocks: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, ParsedQuestion>> {
  const repaired = new Map<number, ParsedQuestion>()
  if (blocks.length === 0) return repaired

  const misses: Array<IndexedBlock & { hash: string }> = []
  await Promise.all(
    blocks.map(async (text, idx) => {
      const hash = await blockHash(text)
      const hit = await db.parseCache.get(hash)
      if (!hit) {
        misses.push({ idx, text, hash })
        return
      }

      try {
        const cached = sanitizeParsed(JSON.parse(hit.value) as ParsedQuestion)
        if (cached) repaired.set(idx, cached)
      } catch {
        misses.push({ idx, text, hash })
      }
    }),
  )

  const batches = packByChars(misses, MAX_BATCH_CHARS)
  if (batches.length === 0) {
    onProgress?.(1, 1)
    return repaired
  }

  // 串行发送（避免限流）
  let done = 0
  for (const b of batches) {
    try {
      const parsed = await callParseBatch(b.text, undefined, JUDGE_SYSTEM)
      const missByIdx = new Map(misses.map((miss) => [miss.idx, miss]))
      for (const [idx, question] of parsed) {
        if (idx < 0 || idx >= blocks.length) continue
        const miss = missByIdx.get(idx)
        if (!miss) continue

        question.confidence = Math.max(question.confidence ?? 0.8, 0.7)
        repaired.set(idx, question)
        await db.parseCache.put({
          hash: miss.hash,
          value: JSON.stringify(question),
          createdAt: Date.now(),
        })
      }
    } catch (e) {
      console.warn('[importer] judge batch failed', e)
    }
    done++
    onProgress?.(done, batches.length)
  }

  return repaired
}

async function blockHash(text: string): Promise<string> {
  return sha256(`${CACHE_VERSION}\0${text}`)
}
