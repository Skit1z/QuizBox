import { chatJson } from './ai'
import type { QuestionType } from '@/types'
import { db } from '@/db'
import { sha256 } from '@/utils/hash'
import { detectType, normalizeAnswer } from './rule-parser'

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

const MAX_BATCH_CHARS = 8000
const MAX_BATCH_BLOCKS = 15
const CACHE_VERSION = 'repair-diff-v1'

export interface RepairItem {
  block: string
  candidate: ParsedQuestion
}

type RepairWorkItem = RepairItem & { idx: number; hash: string }

function compactText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** 去掉选项内容里残留的「A.」「B、」「(C)」等字母前缀（AI 返回的选项常带前缀，
 *  与 UI 渲染的字母叠加会出现「A A.xxx」重复）。规则路径已 strip，此处补 AI 路径。
 *  仅当字母后紧跟分隔符时才剥离，避免误伤「C2M」这类正文。 */
function stripOptionLetter(text: string): string {
  return text.replace(/^[\s　]*[(（[]?\s*[A-Ha-h]\s*[)）\].、．:：]\s*/, '').trim()
}

export function sanitizeParsed(q: ParsedQuestion): ParsedQuestion | null {
  const stem = (q.stem || '').trim()
  if (!stem) return null

  const options =
    q.options
      ?.map((option) => stripOptionLetter((option ?? '').toString().trim()))
      .filter(Boolean) ?? []
  // 填空题 AI 返回的是字符串数组（每空一项）。若直接 join('') 无分隔符拼接，
  // normalizeAnswer 的 fill 分支按分隔符 split 会把多空塌缩成一个空。
  // 这里用 '\n' 拼接（fill 分支会按 \n 还原），其余题型保持原样。
  const rawAnswer = Array.isArray(q.answer)
    ? q.type === 'fill'
      ? q.answer
          .map((a) => String(a).trim())
          .filter(Boolean)
          .join('\n')
      : q.answer.join('')
    : (q.answer ?? '').toString()
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

// ===== AI 判定：对规则解析不确定的块做差量修复 =====

const REPAIR_DIFF_SYSTEM = `你是题库校对助手。每个块给你「规则解析结果」和「原文」。请判定并最小化输出：
1. 若该块不是有效题目（标题/说明/目录/乱码）→ 输出 {"blockId","isValid":false}
2. 若是题目：
   - 总是给出 type（single/multiple/judge/fill/short/essay）与 answer
   - 单选 answer 用单字母；多选用多字母如 "AC"；判断用 "T"/"F"；填空用字符串数组（同一空的多个等价答案用 ； 连接成一个元素）
   - 仅当「规则解析」的题干或选项有明显错误/残缺时，才额外返回修正后的 stem / options
   - 题干选项正确时绝对不要重复输出它们
3. 不要输出 analysis 字段。
严格 JSON：{"results":[{"blockId":"block_0","isValid":true,"type":"single","answer":"A"}]}
blockId 必须原样使用输入标注，不要重新编号。`

interface RepairDiff {
  blockId?: string
  isValid?: boolean
  type?: QuestionType
  answer?: string | string[]
  stem?: string
  options?: string[]
}

function renderCandidate(q: ParsedQuestion): string {
  const options = q.options?.length
    ? q.options.map((option, idx) => `${String.fromCharCode(65 + idx)}.${option}`).join('|')
    : '(无)'
  const answer = Array.isArray(q.answer) ? q.answer.join('') : q.answer || '(空)'
  return `题型:${q.type} | 题干:${compactText(q.stem)} | 选项:${options} | 答案:${answer}`
}

function renderRepairItem(item: RepairWorkItem): string {
  return `[规则解析] ${renderCandidate(item.candidate)}\n[原文]\n${compactText(item.block)}`
}

function packRepairItems(
  items: RepairWorkItem[],
  limit: number,
): Array<{ items: RepairWorkItem[]; text: string }> {
  const batches: Array<{ items: RepairWorkItem[]; text: string }> = []
  let batchItems: RepairWorkItem[] = []
  let batchText = ''

  for (const item of items) {
    const entry = `--- blockId: block_${item.idx} ---\n${renderRepairItem(item)}\n`
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

function mergeRepair(candidate: ParsedQuestion, ai: RepairDiff): ParsedQuestion | null {
  if (ai.isValid === false) return null

  const merged: ParsedQuestion = {
    ...candidate,
    type: ai.type ?? candidate.type,
    stem: ai.stem ?? candidate.stem,
    options: ai.options ?? candidate.options,
    answer: ai.answer ?? candidate.answer,
    confidence: Math.max(candidate.confidence ?? 0.5, 0.7),
  }

  return sanitizeParsed(merged)
}

async function callRepairBatch(
  batchText: string,
  items: RepairWorkItem[],
): Promise<Map<number, ParsedQuestion>> {
  const res = await chatJson<{
    results?: RepairDiff[]
    questions?: RepairDiff[]
  }>(
    [
      { role: 'system', content: REPAIR_DIFF_SYSTEM },
      { role: 'user', content: batchText },
    ],
    { temperature: 0.1, maxTokens: 1500 },
  )

  const itemByIdx = new Map(items.map((item) => [item.idx, item]))
  const repaired = new Map<number, ParsedQuestion>()
  for (const diff of res.results ?? res.questions ?? []) {
    const idMatch = diff.blockId?.match(/^block_(\d+)$/)
    const idx = idMatch ? Number(idMatch[1]) : undefined
    if (idx === undefined) continue

    const item = itemByIdx.get(idx)
    if (!item) continue

    const merged = mergeRepair(item.candidate, diff)
    if (merged) repaired.set(idx, merged)
  }

  return repaired
}

/**
 * 对规则解析不确定的文本块做 AI 判定与结构化。
 * 分批发送，返回 块索引 → 解析后题目 的映射。
 * 未出现在返回映射中的块 = AI 判定为非题目。
 */
export async function repairWithAI(
  items: RepairItem[],
  onProgress?: (done: number, total: number) => void,
): Promise<Map<number, ParsedQuestion>> {
  const repaired = new Map<number, ParsedQuestion>()
  if (items.length === 0) return repaired

  const misses: RepairWorkItem[] = []
  await Promise.all(
    items.map(async (item, idx) => {
      const hash = await blockHash(item.block)
      const hit = await db.parseCache.get(hash)
      if (!hit) {
        misses.push({ ...item, idx, hash })
        return
      }

      try {
        const cached = sanitizeParsed(JSON.parse(hit.value) as ParsedQuestion)
        if (cached) repaired.set(idx, cached)
      } catch {
        misses.push({ ...item, idx, hash })
      }
    }),
  )

  const batches = packRepairItems(misses, MAX_BATCH_CHARS)
  if (batches.length === 0) {
    onProgress?.(1, 1)
    return repaired
  }

  // 串行发送（避免限流）
  let done = 0
  for (const b of batches) {
    try {
      const parsed = await callRepairBatch(b.text, b.items)
      const missByIdx = new Map(b.items.map((miss) => [miss.idx, miss]))
      for (const [idx, question] of parsed) {
        if (idx < 0 || idx >= items.length) continue
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

// ===== 按需：为单题生成答案 + 解析（用户在预览页手动触发） =====

const ANSWER_GEN_SYSTEM = `你是学科答题专家。根据题目（及选项）给出正确答案与简要解析。
- 单选：answer 为单个字母，如 "B"
- 多选：answer 为多个字母，如 "ACD"
- 判断：answer 为 "T"(对) 或 "F"(错)
- 填空：answer 为字符串数组，每空一项；同一空的多个等价答案用 ； 连接成一个元素
解析(analysis)控制在 80 字内，说明为什么。
严格输出 JSON：{"answer": ..., "analysis": "..."}`

export async function generateAnswer(q: {
  type: QuestionType
  stem: string
  options?: string[]
}): Promise<{ answer: string | string[]; analysis: string }> {
  const optText = q.options?.length
    ? '\n选项：\n' + q.options.map((o, i) => `${String.fromCharCode(65 + i)}. ${o}`).join('\n')
    : ''
  const res = await chatJson<{ answer: string | string[]; analysis?: string }>(
    [
      { role: 'system', content: ANSWER_GEN_SYSTEM },
      { role: 'user', content: `题型：${q.type}\n题目：${q.stem}${optText}` },
    ],
    { temperature: 0, maxTokens: 400 },
  )
  // 填空题多空数组同 sanitizeParsed：用 '\n' 拼接以保留各空边界
  const rawAnswer = Array.isArray(res.answer)
    ? q.type === 'fill'
      ? res.answer
          .map((a) => String(a).trim())
          .filter(Boolean)
          .join('\n')
      : res.answer.join('')
    : String(res.answer ?? '')
  const answer = normalizeAnswer(q.type, rawAnswer, q.options ?? [])
  return { answer, analysis: (res.analysis ?? '').trim() }
}
