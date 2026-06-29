/**
 * 基于正则规则的题目解析器（零 AI 消耗）。
 * 支持常见中文题库格式：题号 + 选项 + 答案/解析标记。
 */

import type { QuestionType } from '@/types'
import type { ParsedQuestion } from './importer'

// ===== 正则模式 =====

// 大题区段标题：一、单选题 / 二、多选题（共 xx 题）
const RE_SECTION_HEADER = /^[一二三四五六七八九十百]+[、.．]\s*(单选|多选|判断|填空|简答|论述|选择|不定项选择)/m
const SECTION_TYPE_MAP: Record<string, QuestionType> = {
  单选: 'single', 选择: 'single',
  多选: 'multiple', 不定项选择: 'multiple',
  判断: 'judge',
  填空: 'fill',
  简答: 'short',
  论述: 'essay',
}

// 章节分隔行（习题N / 书名号标题 等），会打断题目块避免跨章节合并
// 匹配：《供应链管理基础》习题1、习题三、供应链管理基础习题4 等
const RE_CHAPTER_BREAK = /^[\s　]*(?:《[^》]*》.*\d|《[^》]+》\s*$|习题[一二三四五六七八九十\d]+|^[^A-Za-z\d]{0,12}习题)/m

// 题号：1. / 1、/ 1) / (1) / 1．
const RE_QUESTION_NUM = /^[\s　]*[(\[（【]?(\d{1,4})[)\]）】]?[.、．)\s]/m

// 选项行开头：A. / A、/ A) / (A) / A．/ A（空格）
// 兼容行首 bullet 符号（已在 expandInlineOptions 阶段 stripBullet 去除，这里用 * 兜底）
const RE_OPTION_HEAD = /^[\s　•◦▪▪·●○■□*\-‑–—]*[(\[（]?([A-Ha-h])[)\]）]?[.、．)]\s*/

// 同一行内的后续选项标记：用于拆分 "A.xxx B.xxx" 或 "A.xxxB.xxxC.xxx"
// 在中文/字母 + 字母选项标点 边界处拆分
const RE_INLINE_OPT_SPLIT = /(?<=[\s。．])(?=[A-Ha-h][.、．)])|(?<=[A-Za-z\u4e00-\u9fff])(?=[A-Ha-h][.、．)])/

// 答案标记（冒号可选，兼容「正确答案C」「答案：C」）
const RE_ANSWER = /^[\s　•◦▪▪·●○■□*\-‑–—]*(?:【?答案】?|答案|Answer|answer|正确答案|答)\s*[:：]?\s*/i
// 解析标记
const RE_ANALYSIS = /^[\s　]*(?:【?解析】?|解析|详解|Explanation|explanation)\s*[:：]?\s*/i

// 判断题改错格式：「错：零和博弈改为合作共赢」→ 答案=F，解析=改错内容
const RE_JUDGE_CORRECTION = /^[\s　]*(对|错|正确|错误)\s*[：:]\s*(.*)/
// 判断题独立答案行：「对」「错」「正确」「错误」单独成行
const RE_JUDGE_STANDALONE = /^[\s　]*(对|错|正确|错误)[。．.\s　]*$/

// 题干中嵌入的答案：（ B ）、（ABC）、（ ABCD ）
const RE_STEM_ANSWER = /[（(]\s*([A-Ha-h]{1,8})\s*[）)]/
// 题干中嵌入的判断答案：（√）（×）（对）（错）
const RE_STEM_JUDGE = /[（(]\s*([√✓×✗对错TF])\s*[）)]/

// 判断题答案
const RE_JUDGE_TRUE = /^[（(]?\s*[√✓对正确TtYy]\s*[）)]?$/
const RE_JUDGE_FALSE = /^[（(]?\s*[×✗错误FfNn]\s*[）)]?$/

// 填空占位
const RE_BLANK = /_{2,}|（\s*）|\(\s*\)/

// 垃圾行：分隔线、纯符号
const RE_JUNK_LINE = /^[\s　]*[=\-_─━═~·•●■□▪▫◆◇]{3,}[\s　]*$/

// 常见中文标点（用于可读性判断）
const RE_CN_PUNCT = /[。，、；：！？""''（）《》【】\-—…·]/g

export interface HybridResult {
  questions: ParsedQuestion[]
  /** 低置信度题目对应的原始文本块，用于送 AI 二次解析 */
  lowConfidenceBlocks: string[]
  /** 低置信度题目在 questions 中的索引 */
  lowConfidenceIndices: number[]
}

const CONFIDENCE_THRESHOLD = 0.6

export function parseWithRules(text: string): ParsedQuestion[] {
  return parseWithRulesHybrid(text).questions
}

export function parseWithRulesHybrid(text: string): HybridResult {
  const lines = text.split(/\r?\n/)
  const expanded = expandInlineOptions(lines)
  const blocks = splitIntoBlocks(expanded)

  const questions: ParsedQuestion[] = []
  const lowConfidenceBlocks: string[] = []
  const lowConfidenceIndices: number[] = []

  for (const block of blocks) {
    const q = parseBlock(block)
    if (!q) continue
    const idx = questions.length
    questions.push(q)
    if ((q.confidence ?? 1) < CONFIDENCE_THRESHOLD) {
      lowConfidenceBlocks.push(block.lines.join('\n').trim())
      lowConfidenceIndices.push(idx)
    }
  }

  return { questions, lowConfidenceBlocks, lowConfidenceIndices }
}

// ===== 预处理：拆分同一行内的多个选项 =====

/** 去除行首的 bullet/列表符号（• ◦ ▪ · 等） */
function stripBullet(line: string): string {
  return line.replace(/^[\s　]*[•◦▪▪·●○■□*\-‑–—]+\s*/, '')
}

function expandInlineOptions(lines: string[]): string[] {
  const result: string[] = []
  for (const line of lines) {
    // 先去除 bullet 符号
    const cleaned = stripBullet(line)
    let trimmed = cleaned.trim()

    // 若该行同时含多个选项 + 末尾答案（如 "A.xxxB.xxxC.xxxD.xxx正确答案B"），
    // 先把末尾答案剥离到独立行，再拆选项
    const ansTailMatch = trimmed.match(/(正确答案|答案|答)\s*[:：]?\s*[A-Ha-h]{1,4}\s*$/)
    let answerLine = ''
    if (ansTailMatch && RE_OPTION_HEAD.test(trimmed)) {
      answerLine = trimmed.slice(ansTailMatch.index!)
      trimmed = trimmed.slice(0, ansTailMatch.index!).trim()
    }

    // 如果行首匹配选项头且行内还有其他选项标记 → 拆分
    if (RE_OPTION_HEAD.test(trimmed)) {
      const parts = trimmed.split(RE_INLINE_OPT_SPLIT)
      if (parts.length >= 2) {
        result.push(...parts.map((p) => p.trim()).filter(Boolean))
        if (answerLine) result.push(answerLine)
        continue
      }
    }
    // 即使没有多个选项，也用去掉 bullet 的版本
    if (answerLine) {
      result.push(trimmed)
      result.push(answerLine)
    } else {
      result.push(cleaned)
    }
  }
  return result
}

// ===== 分块 =====

interface RawBlock {
  lines: string[]
  sectionType?: QuestionType
}

function splitIntoBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = []
  let currentSectionType: QuestionType | undefined
  let buf: string[] = []

  function flush() {
    const joined = buf.join('\n').trim()
    if (joined) {
      blocks.push({ lines: [...buf], sectionType: currentSectionType })
    }
    buf = []
  }

  for (const line of lines) {
    // 检测区段标题（一、单选题 等，带题型信息）
    const secMatch = line.match(RE_SECTION_HEADER)
    if (secMatch) {
      flush()
      const key = secMatch[1]
      currentSectionType = SECTION_TYPE_MAP[key]
      continue
    }

    // 检测章节分隔行（习题N / 书名号标题 / 汉字数字标题）
    // 这些行会打断当前块，避免跨章节题目合并污染
    if (buf.length > 0 && RE_CHAPTER_BREAK.test(line) && !RE_QUESTION_NUM.test(line)) {
      // 判断是否带题型信息（如「三、判断题」）
      const typeInLine = line.match(/(单选|多选|判断|填空|简答|论述|选择|不定项选择)/)
      if (typeInLine) {
        flush()
        currentSectionType = SECTION_TYPE_MAP[typeInLine[1]]
        continue
      }
      // 纯章节标题（如「习题三」「《...》习题2」）→ 打断但不重置类型
      flush()
      continue
    }

    // 检测新题号开头（仅当 buf 已有内容时才切分）
    if (buf.length > 0 && RE_QUESTION_NUM.test(line)) {
      flush()
    }

    buf.push(line)
  }
  flush()

  return blocks
}

// ===== 解析单个题目块 =====

function parseBlock(block: RawBlock): ParsedQuestion | null {
  const { lines, sectionType } = block
  const text = lines.join('\n').trim()
  if (!text || text.length < 4) return null

  // 过滤垃圾块：纯分隔线、书名号标题、过短无题号内容
  if (isJunkBlock(text)) return null

  let stem = ''
  const options: string[] = []
  let answerRaw = ''
  let analysis = ''
  const imagePlaceholders: string[] = []

  type Phase = 'stem' | 'option' | 'answer' | 'analysis'
  let phase: Phase = 'stem'

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue

    // 跳过垃圾行（分隔线、乱码）
    if (RE_JUNK_LINE.test(trimmed)) continue
    if (isGarbledLine(trimmed)) continue

    // 答案标记
    if (RE_ANSWER.test(trimmed)) {
      answerRaw = trimmed.replace(RE_ANSWER, '').trim()
      phase = 'answer'
      continue
    }
    // 解析标记
    if (RE_ANALYSIS.test(trimmed)) {
      analysis = trimmed.replace(RE_ANALYSIS, '').trim()
      phase = 'analysis'
      continue
    }

    // 判断题改错行：「错：xxx」「对」
    if (phase === 'stem' || phase === 'option') {
      const corrMatch = trimmed.match(RE_JUDGE_CORRECTION)
      if (corrMatch) {
        const verdict = corrMatch[1]
        answerRaw = verdict
        const correction = corrMatch[2].trim()
        if (correction) analysis = correction
        phase = 'analysis'
        continue
      }
      const standaloneMatch = trimmed.match(RE_JUDGE_STANDALONE)
      if (standaloneMatch) {
        answerRaw = standaloneMatch[1]
        phase = 'answer'
        continue
      }
    }

    if (phase === 'answer') {
      answerRaw += '\n' + trimmed
      continue
    }
    if (phase === 'analysis') {
      analysis += '\n' + trimmed
      continue
    }

    // 选项行
    const optMatch = trimmed.match(RE_OPTION_HEAD)
    if (optMatch) {
      const content = trimmed.replace(RE_OPTION_HEAD, '').trim()
      options.push(content)
      phase = 'option'
      continue
    }

    // 题干（含题号去除）
    if (phase === 'stem') {
      const cleaned = trimmed.replace(RE_QUESTION_NUM, '').trim()
      stem += (stem ? '\n' : '') + cleaned
    } else if (phase === 'option') {
      // 选项续行
      if (options.length > 0) {
        options[options.length - 1] += ' ' + trimmed
      }
    }
  }

  stem = stem.trim()
  answerRaw = answerRaw.trim()
  analysis = analysis.trim()

  if (!stem) return null

  // 从题干括号中提取嵌入的答案（如果没有显式答案标记）
  if (!answerRaw) {
    const stemAnswer = extractStemAnswer(stem)
    if (stemAnswer) {
      answerRaw = stemAnswer.answer
      stem = stemAnswer.cleanStem
    }
  }

  // 提取图片占位符
  const imgMatches = text.match(/\[IMG_\d+\]/g)
  if (imgMatches) imagePlaceholders.push(...imgMatches)

  // 推断题型
  const type = detectType(stem, options, answerRaw, sectionType)
  const answer = normalizeAnswer(type, answerRaw, options)

  return {
    type,
    stem,
    options: options.length > 0 ? options : undefined,
    answer,
    analysis: analysis || undefined,
    imagePlaceholders: imagePlaceholders.length > 0 ? imagePlaceholders : undefined,
    confidence: computeConfidence(type, stem, options, answerRaw),
  }
}

// ===== 辅助函数 =====

/** 判断单行是否为乱码（二进制提取噪声） */
function isGarbledLine(line: string): boolean {
  const t = line.trim()
  if (t.length < 30) return false

  // 日文假名、罕见符号密集出现 → 大概率是 .doc 二进制噪声
  const exoticChars = t.match(/[゠-ヿ぀-ゟ＀-￯∷○◆◇■□●◎△▲▽▼※†‡§¶]/g)
  if (exoticChars && exoticChars.length / t.length > 0.05) return true

  // 长行（>80字）且几乎无中文标点 → 可能是乱码
  if (t.length > 80) {
    const punctCount = (t.match(RE_CN_PUNCT) || []).length
    if (punctCount / t.length < 0.005) return true
  }

  return false
}

/** 判断是否为垃圾块（标题、分隔线、乱码、非题目内容） */
function isJunkBlock(text: string): boolean {
  const t = text.trim()
  // 纯分隔线/符号
  if (/^[=\-_─━═~·•●■□▪▫◆◇\s　]+$/.test(t)) return true
  // 过短且无题号
  if (t.length < 6 && !RE_QUESTION_NUM.test(t)) return true
  // 纯数字/标点
  if (/^[\d.、．\s　:：()（）]+$/.test(t)) return true

  // 多行块：逐行剥离垃圾行、乱码行、标题行，看剩余是否有实质内容
  const contentLines = t.split(/\r?\n/).filter((line) => {
    const l = line.trim()
    if (!l) return false
    if (RE_JUNK_LINE.test(l)) return false
    if (isGarbledLine(l)) return false
    if (/^《[^》]+》/.test(l)) return false
    if (l.length <= 4 && !/[一-鿿]{2,}/.test(l)) return false
    return true
  })
  if (contentLines.length === 0) return true

  // 无题号 + 无选项 + 含书名号标题 → 文档标题块
  if (!RE_QUESTION_NUM.test(t) && /《[^》]+》/.test(t) && !RE_OPTION_HEAD.test(t)) return true

  return false
}

/** 从题干括号中提取嵌入的答案 */
function extractStemAnswer(stem: string): { cleanStem: string; answer: string } | null {
  // 先检查选择题答案：（ABC）、（ B ）
  const choiceMatch = stem.match(RE_STEM_ANSWER)
  if (choiceMatch) {
    return {
      cleanStem: stem.replace(choiceMatch[0], '（  ）'),
      answer: choiceMatch[1].trim().toUpperCase(),
    }
  }
  // 再检查判断题答案：（√）、（×）、（对）、（错）
  const judgeMatch = stem.match(RE_STEM_JUDGE)
  if (judgeMatch) {
    return {
      cleanStem: stem.replace(judgeMatch[0], '（  ）'),
      answer: judgeMatch[1].trim(),
    }
  }
  return null
}

function detectType(
  stem: string,
  options: string[],
  answer: string,
  sectionType?: QuestionType,
): QuestionType {
  // 硬证据优先：有选项 → 一定是选择题（覆盖 sectionType）
  if (options.length >= 1) {
    const letters = answer.match(/[A-Ha-h]/g)
    if (letters && letters.length > 1) return 'multiple'
    return 'single'
  }

  // 硬证据：答案含多个字母 → 多选（即使无选项）
  if (answer) {
    const letters = answer.match(/[A-Ha-h]/g)
    if (letters && letters.length > 1) return 'multiple'
    if (letters && letters.length === 1) return 'single'
  }

  // 无硬证据时才使用区段标题提示
  if (sectionType) return sectionType

  // 判断题特征
  if (RE_JUDGE_TRUE.test(answer) || RE_JUDGE_FALSE.test(answer)) return 'judge'
  if (/[√✓×✗]/.test(answer)) return 'judge'
  if (/^(对|错|正确|错误)$/.test(answer.trim())) return 'judge'

  // 填空特征
  if (RE_BLANK.test(stem)) return 'fill'

  // 简短答案 → 简答，长答案 → 论述
  if (answer.length > 200 || stem.length > 200) return 'essay'
  return 'short'
}

function normalizeAnswer(
  type: QuestionType,
  raw: string,
  options: string[],
): string | string[] {
  if (!raw) return type === 'fill' ? [] : ''

  switch (type) {
    case 'single': {
      const m = raw.match(/[A-Ha-h]/)
      return m ? m[0].toUpperCase() : raw
    }
    case 'multiple': {
      const letters = raw.match(/[A-Ha-h]/g)
      return letters ? [...new Set(letters.map((l) => l.toUpperCase()))].sort() : [raw]
    }
    case 'judge': {
      if (/^(对|正确)$/.test(raw.trim()) || /[√✓]/.test(raw) || /^[TtYy]$/.test(raw.trim())) return 'T'
      if (/^(错|错误)$/.test(raw.trim()) || /[×✗]/.test(raw) || /^[FfNn]$/.test(raw.trim())) return 'F'
      return raw
    }
    case 'fill': {
      const parts = raw.split(/[;；,，\n]/).map((s) => s.trim()).filter(Boolean)
      return parts.length > 0 ? parts : [raw]
    }
    default:
      return raw
  }
}

function computeConfidence(
  type: QuestionType,
  stem: string,
  options: string[],
  answer: string,
): number {
  let score = 0.5

  if (stem.length > 5) score += 0.2
  if (answer) score += 0.2
  if ((type === 'single' || type === 'multiple') && options.length >= 3) score += 0.1

  // 选项内容含乱码 → 降低置信度
  const garbledOpts = options.filter((o) => isGarbledLine(o)).length
  if (garbledOpts > 0) score -= 0.3

  // 题干过短或过长且无标点 → 可疑
  if (stem.length > 200 && (stem.match(RE_CN_PUNCT) || []).length < 2) score -= 0.2

  return Math.max(0, Math.min(score, 1))
}
