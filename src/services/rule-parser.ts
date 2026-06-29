/**
 * 基于正则规则的题目解析器（零 AI 消耗）。
 * 支持常见中文题库格式：题号 + 选项 + 答案/解析标记。
 */

import type { QuestionType } from '@/types'
import type { ParsedQuestion } from './importer'

// ===== 正则模式 =====

// 大题区段标题：一、单选题 / 二、多选题（共 xx 题）
const RE_SECTION_HEADER =
  /^[一二三四五六七八九十百]+[、.．]\s*(单选|多选|判断|填空|简答|论述|选择|不定项选择)/m
const SECTION_TYPE_MAP: Record<string, QuestionType> = {
  单选: 'single',
  选择: 'single',
  多选: 'multiple',
  不定项选择: 'multiple',
  判断: 'judge',
  填空: 'fill',
  简答: 'short',
  论述: 'essay',
}

// 章节分隔行（习题N / 书名号标题 等），会打断题目块避免跨章节合并
// 匹配：《供应链管理基础》习题1、习题三、供应链管理基础习题4 等
const RE_CHAPTER_BREAK =
  /^[\s　]*(?:《[^》]*》.*\d|《[^》]+》\s*$|习题[一二三四五六七八九十\d]+|^[^A-Za-z\d]{0,12}习题)/m

// 题号：1. / 1、/ 1) / (1) / 1．
// 注：改为 let，parseWithRulesHybrid 可按 AI 推断的格式 profile 临时覆盖（解析后还原）
let RE_QUESTION_NUM = /^[\s　]*[(\[（【]?(\d{1,4})[)\]）】]?[.、．)\s]/m

// 选项行开头：A. / A、/ A) / (A) / A．/ A（空格）
// 兼容行首 bullet 符号（已在 expandInlineOptions 阶段 stripBullet 去除，这里用 * 兜底）
// 注：改为 let，可被 profile 临时覆盖（解析后还原）
let RE_OPTION_HEAD = /^[\s　•◦▪▪·●○■□*\-‑–—]*[(\[（]?([A-Ha-h])[)\]）]?[.、．)]\s*/

// 同一行内的后续选项标记：用于拆分 "A.xxx B.xxx" 或 "A.xxxB.xxxC.xxx"
// 在中文/字母 + 字母选项标点 边界处拆分
const RE_INLINE_OPT_SPLIT =
  /(?<=[\s。．])(?=[A-Ha-h][.、．)])|(?<=[A-Za-z\u4e00-\u9fff])(?=[A-Ha-h][.、．)])/

// 答案标记（冒号可选，兼容「正确答案C」「答案：C」）
const RE_ANSWER =
  /^[\s　•◦▪▪·●○■□*\-‑–—]*(?:【?答案】?|答案|Answer|answer|正确答案|答)\s*[:：]?\s*/i
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
const CONFIDENCE_THRESHOLD = 0.6

const RE_ANSWER_KEY_ITEM =
  /^[\s　]*[(（]?(\d{1,3})[)）]?\s*[.、:：)]\s*(?:答案[:：]?\s*)?([A-Ha-h]+|[√✓×✗]|对|错|正确|错误|[TF])\b/
const RE_ANSWER_KEY_TITLE = /(?:参考答案|答案)\s*[:：]?/
const RE_MATERIAL_INTRO =
  /(阅读(?:下列)?材料|案例分析|根据(?:以下|下列|下面)(?:材料|资料|案例|图表)|材料[一二三四：:]|^[（(][一二三四五][）)])/
const RE_SUB_QUESTION = /^[\s　]*[(（]?(?:\d{1,2}|[①②③④⑤⑥⑦⑧⑨⑩])[)）.、]/

export interface HybridResult {
  questions: ParsedQuestion[]
  /** 需送 AI 判定的原始文本块（低结构完整度，规则不确定） */
  lowConfidenceBlocks: string[]
  /** 需送 AI 判定的块在 questions 中的索引 */
  lowConfidenceIndices: number[]
}

/**
 * 评估一个块的结构完整度：规则能否可靠解析？
 * - high: 有清晰题号+选项+答案，规则完全hold住
 * - medium: 部分缺失（如判断题无答案、选择题选项不全）
 * - low: 无题号或无法识别结构 → 必须送 AI
 */
function assessCompleteness(block: RawBlock, q: ParsedQuestion | null): 'high' | 'medium' | 'low' {
  const text = block.lines.join('\n').trim()

  // parseBlock 直接返回 null → 不可解析，但块本身可能有内容 → 送 AI 判定
  if (!q) {
    // 纯垃圾块（分隔线、空标题）不送 AI
    if (isJunkBlock(text)) return 'high' // 标记 high 表示不需要处理
    return 'low'
  }

  // 选择题：需要题号 + 选项(≥2) + 答案
  if (q.type === 'single' || q.type === 'multiple') {
    if (q.options && q.options.length >= 2 && hasAnswer(q.answer)) return 'high'
    if (q.stem.length > 10) return 'medium'
    return 'low'
  }

  // 判断题：需要题干 + 答案
  if (q.type === 'judge') {
    if (hasAnswer(q.answer) && q.stem.length > 10) return 'high'
    return 'medium'
  }

  // 填空/简答/论述：需要题干
  if (q.stem.length > 15) return hasAnswer(q.answer) ? 'high' : 'medium'
  return 'low'
}

export function parseWithRules(text: string): ParsedQuestion[] {
  return parseWithRulesHybrid(text).questions
}

/**
 * 可注入的格式参数（"方言"）。当默认规则搞不定某种排版时，由 AI 推断一次后注入，
 * 复用同一套解析"语法"（内联拆分/答案剥离/判断改错…）。无效正则会安全回退默认。
 */
export interface RuleProfile {
  /** 题目开头正则，须第 1 个捕获组捕获题号数字 */
  questionStart?: string
  /** 选项开头正则（可含正文捕获，会被裁成仅匹配前缀） */
  optionStart?: string
}

export function parseWithRulesHybrid(text: string, profile?: RuleProfile): HybridResult {
  // 保存默认方言，按 profile 临时覆盖；解析为纯同步，无并发风险，finally 还原
  const savedQuestion = RE_QUESTION_NUM
  const savedOption = RE_OPTION_HEAD
  if (profile?.questionStart) {
    const re = safeRegExp(profile.questionStart, 'm')
    if (re && hasCaptureGroup(re)) RE_QUESTION_NUM = re
  }
  if (profile?.optionStart) {
    const re = safeRegExp(stripTrailingContentCapture(profile.optionStart), '')
    if (re) RE_OPTION_HEAD = re
  }
  try {
    return parseHybridInternal(text)
  } finally {
    RE_QUESTION_NUM = savedQuestion
    RE_OPTION_HEAD = savedOption
  }
}

function safeRegExp(src: string, flags: string): RegExp | null {
  try {
    return new RegExp(src, flags)
  } catch {
    return null
  }
}

/** 正则是否含普通捕获组（题号正则必须能捕获题号） */
function hasCaptureGroup(re: RegExp): boolean {
  return /\((?!\?)/.test(re.source)
}

/** 裁掉选项正则末尾用于捕获正文的 (.*)/(.*)$，使其只匹配选项前缀，
 *  以兼容 parseBlock 用 .replace(RE_OPTION_HEAD,'') 剥前缀的语义 */
function stripTrailingContentCapture(src: string): string {
  return src.replace(/\(\.\*\??\)\$?\s*$/, '').replace(/\s+$/, '')
}

function parseHybridInternal(text: string): HybridResult {
  const lines = text.split(/\r?\n/).flatMap(splitMergedSectionUnits)
  const expanded = expandInlineOptions(lines)
  const blocks = splitIntoBlocks(expanded)
  const { answerMap, keyIdx } = extractAnswerKey(blocks)

  const entries: ParsedEntry[] = []

  for (let blockIdx = 0; blockIdx < blocks.length; blockIdx++) {
    if (keyIdx.has(blockIdx)) continue

    const block = blocks[blockIdx]
    const blockText = block.lines.join('\n').trim()
    const parsed = parseBlock(block)
    const completeness = assessCompleteness(block, parsed?.q ?? null)

    if (completeness === 'high' && !parsed) continue

    if (parsed) {
      entries.push({
        block,
        blockText,
        q: parsed.q,
        seq: parsed.seq,
      })
    } else {
      entries.push({
        block,
        blockText,
        q: {
          type: 'short',
          stem: blockText.slice(0, 200),
          answer: '',
          confidence: 0.1,
        },
      })
    }
  }

  for (const entry of entries) {
    if (hasAnswer(entry.q.answer) || entry.seq === undefined) continue
    const rawAnswer = answerMap.get(entry.seq)
    if (!rawAnswer) continue

    const options = entry.q.options ?? []
    const type = detectType(entry.q.stem, options, rawAnswer, entry.block.sectionType)
    entry.q.type = type
    entry.q.answer = normalizeAnswer(type, rawAnswer, options)
    entry.q.confidence = computeConfidence(type, entry.q.stem, options, rawAnswer)
  }

  for (const entry of entries) {
    const options = entry.q.options ?? []
    const rawAnswer = Array.isArray(entry.q.answer) ? entry.q.answer.join('') : entry.q.answer
    entry.q.confidence = computeConfidence(entry.q.type, entry.q.stem, options, rawAnswer)
  }

  const groupedEntries = groupMaterialQuestions(entries)
  const questions = groupedEntries.map((entry) => entry.q)
  const lowConfidenceBlocks: string[] = []
  const lowConfidenceIndices: number[] = []

  groupedEntries.forEach((entry, idx) => {
    if ((entry.q.confidence ?? 0) >= CONFIDENCE_THRESHOLD) return
    // 选项齐全但答案缺失：AI 也无法凭空生成答案，送 AI 纯属浪费 token。
    // 这类题保留低置信标记（UI 标「把握低」），交由用户手动补/按需 AI 生成答案。
    if (isCleanChoiceMissingAnswer(entry.q)) return
    lowConfidenceBlocks.push(entry.blockText)
    lowConfidenceIndices.push(idx)
  })

  return { questions, lowConfidenceBlocks, lowConfidenceIndices }
}

/** 选项齐全(≥2)但答案为空的选择题——结构完整，只缺答案 */
function isCleanChoiceMissingAnswer(q: ParsedQuestion): boolean {
  return (
    (q.type === 'single' || q.type === 'multiple') &&
    (q.options?.length ?? 0) >= 2 &&
    !hasAnswer(q.answer)
  )
}

// ===== 预处理：拆回被合并进同一段落的逻辑单元 =====

// convertToHtml 常把「上一题末尾 + 大题标题 + 下一题开头」挤进同一段落（一行）。
// 在大题标题前插换行；在「X题（…题，…分）」计数标题后插换行，把它们拆回独立行。
const RE_SECTION_TYPE = '(?:单选题|多选题|判断题|填空题|简答题|论述题|选择题|不定项选择题)'
const RE_INLINE_SECTION_HEAD = new RegExp(
  `(?<=.)(?=[一二三四五六七八九十]+[、.．]\\s*${RE_SECTION_TYPE})`,
  'g',
)
const RE_INLINE_SECTION_TAIL = new RegExp(`(${RE_SECTION_TYPE}\\s*[（(][^）)]*[）)])(?=\\S)`, 'g')

/** 把一行里被合并的「大题标题 / 下一题」拆成多行 */
function splitMergedSectionUnits(line: string): string[] {
  return line
    .replace(RE_INLINE_SECTION_HEAD, '\n')
    .replace(RE_INLINE_SECTION_TAIL, '$1\n')
    .split('\n')
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

interface ParsedBlock {
  q: ParsedQuestion
  seq?: number
}

interface ParsedEntry {
  block: RawBlock
  blockText: string
  q: ParsedQuestion
  seq?: number
}

export function splitRawChunks(text: string): string[] {
  const lines = text.split(/\r?\n/).flatMap(splitMergedSectionUnits)
  const expanded = expandInlineOptions(lines)
  const blocks = splitIntoBlocks(expanded)
  return blocks.map((b) => b.lines.join('\n').trim()).filter(Boolean)
}

function splitIntoBlocks(lines: string[]): RawBlock[] {
  const blocks: RawBlock[] = []
  let currentSectionType: QuestionType | undefined
  let buf: string[] = []
  // 上一条非空行是否为「判断答案/改错」终止行（用于切分无题号的连续判断改错题）
  let prevJudgeTerminator = false

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
      prevJudgeTerminator = false
      continue
    }

    // 检测章节分隔行（习题N / 书名号标题 / 汉字数字标题）
    if (buf.length > 0 && RE_CHAPTER_BREAK.test(line) && !RE_QUESTION_NUM.test(line)) {
      const typeInLine = line.match(/(单选|多选|判断|填空|简答|论述|选择|不定项选择)/)
      if (typeInLine) {
        flush()
        currentSectionType = SECTION_TYPE_MAP[typeInLine[1]]
        prevJudgeTerminator = false
        continue
      }
      flush()
      prevJudgeTerminator = false
      continue
    }

    // 检测新题号开头（仅当 buf 已有内容时才切分）
    if (buf.length > 0 && RE_QUESTION_NUM.test(line)) {
      flush()
    }
    // 无题号的判断改错题：上一行是答案/改错行，本行又是一句完整新陈述 → 切成新题
    // （兼容原文档漏写题号的连续判断改错题，避免后一题被吞进前一题的解析）
    else if (buf.length > 0 && prevJudgeTerminator && looksLikeNewStatement(line)) {
      flush()
    }

    buf.push(line)
    if (line.trim()) prevJudgeTerminator = isJudgeTerminatorLine(line)
  }
  flush()

  return blocks
}

/** 是否为「判断题答案/改错」终止行：错：xxx / 对 / 答案：正确 等 */
function isJudgeTerminatorLine(line: string): boolean {
  const t = line.trim()
  return (
    RE_JUDGE_CORRECTION.test(t) ||
    RE_JUDGE_STANDALONE.test(t) ||
    /^(?:答案|正确答案)\s*[:：]\s*(?:正确|错误|对|错|[√✓×✗TF])\s*$/.test(t)
  )
}

/** 是否为一句独立的完整陈述（判断题题干特征），且不是答案/选项/题号/解析行 */
function looksLikeNewStatement(line: string): boolean {
  const t = line.trim()
  if (t.length < 10) return false
  if (RE_QUESTION_NUM.test(t) || RE_OPTION_HEAD.test(t)) return false
  if (RE_ANSWER.test(t) || RE_ANALYSIS.test(t)) return false
  if (/^(对|错|正确|错误)\s*[：:]/.test(t) || /^(对|错|正确|错误)\s*$/.test(t)) return false
  // 完整陈述句以中文句号/问号/感叹号收尾
  return /[。．.！？]$/.test(t)
}

// ===== 解析单个题目块 =====

function parseBlock(block: RawBlock): ParsedBlock | null {
  const { lines, sectionType } = block
  const text = lines.join('\n').trim()
  if (!text || text.length < 4) return null

  // 过滤垃圾块：纯分隔线、书名号标题、过短无题号内容
  if (isJunkBlock(text)) return null

  const seqMatch = text.match(RE_QUESTION_NUM)
  const seq = seqMatch ? Number(seqMatch[1]) : undefined
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

  // 整题挤一行时（convertToHtml 常见），答案以「正确答案A」粘在题干/末选项尾部。
  // 必须在拆内联选项之前剥离，否则会被并进最后一个选项。
  if (!answerRaw) {
    const trailing = extractTrailingInlineAnswer(stem)
    if (trailing) {
      answerRaw = trailing.answer
      stem = trailing.stem
    }
  }

  if (options.length === 0) {
    const inlineOptions = extractInlineOptionsFromStem(stem)
    if (inlineOptions) {
      stem = inlineOptions.stem
      options.push(...inlineOptions.options)
    }
  }

  // 提取图片占位符
  const imgMatches = text.match(/\[IMG_\d+\]/g)
  if (imgMatches) imagePlaceholders.push(...imgMatches)

  // 推断题型
  const type = detectType(stem, options, answerRaw, sectionType)
  const answer = normalizeAnswer(type, answerRaw, options)

  return {
    seq,
    q: {
      type,
      stem,
      options: options.length > 0 ? options : undefined,
      answer,
      analysis: analysis || undefined,
      imagePlaceholders: imagePlaceholders.length > 0 ? imagePlaceholders : undefined,
      confidence: computeConfidence(type, stem, options, answerRaw),
    },
  }
}

// ===== 辅助函数 =====

function hasAnswer(answer: ParsedQuestion['answer']): boolean {
  if (Array.isArray(answer)) return answer.length > 0
  return !!answer
}

function extractAnswerKey(blocks: RawBlock[]): {
  answerMap: Map<number, string>
  keyIdx: Set<number>
} {
  const answerMap = new Map<number, string>()
  const keyIdx = new Set<number>()

  blocks.forEach((block, idx) => {
    const text = block.lines.join('\n').trim()
    if (!looksLikeAnswerKey(text)) return

    keyIdx.add(idx)
    for (const match of text.matchAll(
      /(\d{1,3})\s*[.、):：]\s*(?:答案[:：]?\s*)?([A-Ha-h]+|[√✓×✗]|对|错|正确|错误|[TF])/g,
    )) {
      answerMap.set(Number(match[1]), match[2])
    }

    for (const match of text.matchAll(/(\d{1,3})\s*[-~—]\s*(\d{1,3})\s*[:：]?\s*([A-Ha-h]+)/g)) {
      const start = Number(match[1])
      const end = Number(match[2])
      const letters = match[3].toUpperCase()
      if (end - start + 1 !== letters.length) continue
      for (let n = start; n <= end; n++) answerMap.set(n, letters[n - start])
    }
  })

  return { answerMap, keyIdx }
}

function looksLikeAnswerKey(text: string): boolean {
  if (!text) return false

  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
  const usefulLines = lines.filter((line) => !RE_JUNK_LINE.test(line))
  if (usefulLines.length === 0) return false

  const titleMatched = RE_ANSWER_KEY_TITLE.test(text)
  const itemMatches = usefulLines.filter((line) => RE_ANSWER_KEY_ITEM.test(line)).length
  const hasRange = /(\d{1,3})\s*[-~—]\s*(\d{1,3})\s*[:：]?\s*[A-Ha-h]{2,}/.test(text)
  const inlineMatches = Array.from(
    text.matchAll(
      /(\d{1,3})\s*[.、):：]\s*(?:答案[:：]?\s*)?([A-Ha-h]+|[√✓×✗]|对|错|正确|错误|[TF])/g,
    ),
  ).length

  if (titleMatched && (inlineMatches > 0 || hasRange)) return true
  return itemMatches / usefulLines.length >= 0.6 || hasRange
}

function groupMaterialQuestions(entries: ParsedEntry[]): ParsedEntry[] {
  const result: ParsedEntry[] = []

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!isMaterialIntro(entry) || !isSubQuestion(entries[i + 1])) {
      result.push(entry)
      continue
    }

    const material = entry.blockText
    i++
    while (i < entries.length && isSubQuestion(entries[i])) {
      const q = entries[i].q
      q.stem = `【材料】${material}\n\n${q.stem}`
      result.push(entries[i])
      i++
    }
    i--
  }

  return result
}

function isMaterialIntro(entry: ParsedEntry | undefined): boolean {
  if (!entry) return false
  const q = entry.q
  if ((q.options?.length ?? 0) > 0 || hasAnswer(q.answer)) return false
  const text = entry.blockText.trim()
  return RE_MATERIAL_INTRO.test(text) || text.endsWith('：')
}

function isSubQuestion(entry: ParsedEntry | undefined): boolean {
  if (!entry) return false
  return isSubQuestionText(entry.blockText)
}

function isSubQuestionText(text: string): boolean {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim())
  return firstLine ? RE_SUB_QUESTION.test(firstLine) : false
}

/** 判断单行是否为乱码（二进制提取噪声） */
function isGarbledLine(line: string): boolean {
  const t = line.trim()
  if (t.length < 30) return false

  // 日文假名、罕见几何符号密集出现 → 大概率是 .doc 二进制噪声。
  // 注意：不可包含全角 ASCII 区（U+FF00–FFEF），该区含中文常用全角标点（）！？，．：；，
  // 否则会把「…（ B ）。」这类带内联答案的正常题干误判为乱码。
  const exoticChars = t.match(/[゠-ヿ぀-ゟ∷◆◇▪▫◎△▲▽▼※†‡§¶]/g)
  if (exoticChars && exoticChars.length / t.length > 0.08) return true

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

// 题干末尾内联答案：「…正确答案A」「…答案：BCD」「…正确答案对」
const RE_TRAILING_INLINE_ANSWER =
  /(?:正确答案|参考答案|答案)\s*[:：]?\s*([A-Ha-h]{1,8}|正确|错误|对|错|[√✓×✗TF])\s*$/

/** 剥离题干/末选项尾部粘连的内联答案，返回去除后的题干与答案 */
function extractTrailingInlineAnswer(stem: string): { stem: string; answer: string } | null {
  const m = stem.match(RE_TRAILING_INLINE_ANSWER)
  if (!m || m.index === undefined) return null
  const cleaned = stem.slice(0, m.index).trim()
  if (!cleaned) return null
  return { stem: cleaned, answer: m[1].trim() }
}

function extractInlineOptionsFromStem(stem: string): { stem: string; options: string[] } | null {
  const markerRe = /[A-Ha-h][.、．)]\s*/g
  const markers = Array.from(stem.matchAll(markerRe))
    .map((match) => ({
      key: match[0][0].toUpperCase(),
      index: match.index ?? -1,
      end: (match.index ?? 0) + match[0].length,
    }))
    .filter((marker) => marker.index >= 0 && isLikelyInlineOptionMarker(stem, marker.index))

  const start = markers.findIndex((marker) => marker.key === 'A')
  if (start < 0) return null

  const sequence = [markers[start]]
  for (let i = start + 1; i < markers.length; i++) {
    const expected = String.fromCharCode(65 + sequence.length)
    if (markers[i].key !== expected) break
    sequence.push(markers[i])
  }
  if (sequence.length < 2) return null

  const options = sequence
    .map((marker, i) => {
      const next = sequence[i + 1]
      return stem.slice(marker.end, next ? next.index : stem.length).trim()
    })
    .filter(Boolean)
  if (options.length < 2) return null

  return {
    stem: stem.slice(0, sequence[0].index).trim(),
    options,
  }
}

function isLikelyInlineOptionMarker(text: string, index: number): boolean {
  if (index === 0) return true
  const prev = text[index - 1]
  if (!prev) return true
  if (/[A-Za-z0-9]/.test(prev)) return false
  return true
}

export function detectType(
  stem: string,
  options: string[],
  answer: string,
  sectionType?: QuestionType,
): QuestionType {
  // 硬证据优先：有选项 → 一定是选择题（覆盖 sectionType）
  if (options.length >= 1) {
    const letters = answer.match(/[A-Ha-h]/g)
    if (letters && letters.length > 1) return 'multiple'
    if (!letters && (sectionType === 'single' || sectionType === 'multiple')) return sectionType
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

export function normalizeAnswer(
  type: QuestionType,
  raw: string,
  _options: string[],
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
      if (/^(对|正确)$/.test(raw.trim()) || /[√✓]/.test(raw) || /^[TtYy]$/.test(raw.trim()))
        return 'T'
      if (/^(错|错误)$/.test(raw.trim()) || /[×✗]/.test(raw) || /^[FfNn]$/.test(raw.trim()))
        return 'F'
      return raw
    }
    case 'fill': {
      const parts = raw
        .split(/[;；,，\n]/)
        .map((s) => s.trim())
        .filter(Boolean)
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
  if (!stem || stem.length < 3) return 0.2

  const garbled = isGarbledLine(stem) || options.some((option) => isGarbledLine(option))
  let score: number

  if (
    (type === 'single' || type === 'multiple') &&
    options.length >= 2 &&
    /[A-Ha-h]/.test(answer)
  ) {
    score = 0.95
  } else if (type === 'judge' && /^(对|错|正确|错误|[√✓×✗TF])/i.test(answer.trim())) {
    score = 0.95
  } else if (type === 'fill' && RE_BLANK.test(stem) && answer) {
    score = 0.9
  } else if (answer && stem.length > 5) {
    score = 0.7
  } else if (!answer) {
    score = 0.4
  } else {
    score = 0.55
  }

  if (garbled) score -= 0.4
  if (stem.length > 200 && (stem.match(RE_CN_PUNCT) || []).length < 2) score -= 0.2

  return Math.max(0, Math.min(score, 1))
}
