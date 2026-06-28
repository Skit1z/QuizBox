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

// 题号：1. / 1、/ 1) / (1) / 1．
const RE_QUESTION_NUM = /^[\s　]*[(\[（【]?(\d{1,4})[)\]）】]?[.、．)\s]/m

// 选项行：A. / A、/ A) / (A) / A．
const RE_OPTION = /^[\s　]*[(\[（]?([A-Ha-h])[)\]）]?[.、．)]\s*/

// 答案标记
const RE_ANSWER = /^[\s　]*(?:【?答案】?|答案|Answer|answer|正确答案)\s*[:：]\s*/i
// 解析标记
const RE_ANALYSIS = /^[\s　]*(?:【?解析】?|解析|详解|Explanation|explanation)\s*[:：]?\s*/i

// 判断题答案
const RE_JUDGE_TRUE = /^[（(]?\s*[√✓对正确TtYy]\s*[）)]?$/
const RE_JUDGE_FALSE = /^[（(]?\s*[×✗错误FfNn]\s*[）)]?$/

// 填空占位（不带 /g，用于 .test()；需要 matchAll 时现场加 /g）
const RE_BLANK = /_{2,}|（\s*）|\(\s*\)/

export function parseWithRules(text: string): ParsedQuestion[] {
  const lines = text.split(/\r?\n/)
  const blocks = splitIntoBlocks(lines)
  return blocks.map(parseBlock).filter((q): q is ParsedQuestion => q !== null)
}

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
    // 检测区段标题
    const secMatch = line.match(RE_SECTION_HEADER)
    if (secMatch) {
      flush()
      const key = secMatch[1]
      currentSectionType = SECTION_TYPE_MAP[key]
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

function parseBlock(block: RawBlock): ParsedQuestion | null {
  const { lines, sectionType } = block
  const text = lines.join('\n').trim()
  if (!text || text.length < 4) return null

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

    if (phase === 'answer') {
      answerRaw += '\n' + trimmed
      continue
    }
    if (phase === 'analysis') {
      analysis += '\n' + trimmed
      continue
    }

    // 选项行
    const optMatch = trimmed.match(RE_OPTION)
    if (optMatch) {
      const content = trimmed.replace(RE_OPTION, '').trim()
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

function detectType(
  stem: string,
  options: string[],
  answer: string,
  sectionType?: QuestionType,
): QuestionType {
  // 区段标题优先
  if (sectionType) return sectionType

  // 有选项 → 选择题
  if (options.length >= 2) {
    // 答案含多个字母 → 多选
    const letters = answer.match(/[A-Ha-h]/g)
    if (letters && letters.length > 1) return 'multiple'
    return 'single'
  }

  // 判断题特征
  if (RE_JUDGE_TRUE.test(answer) || RE_JUDGE_FALSE.test(answer)) return 'judge'
  if (/[（(]\s*[)\s）]/.test(stem) && stem.length < 80) return 'judge'

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
      if (RE_JUDGE_TRUE.test(raw)) return 'T'
      if (RE_JUDGE_FALSE.test(raw)) return 'F'
      return raw
    }
    case 'fill': {
      // 多个答案以分号/逗号/换行分隔
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

  // 有题干 +0.2
  if (stem.length > 5) score += 0.2

  // 有答案 +0.2
  if (answer) score += 0.2

  // 选择题有足够选项 +0.1
  if ((type === 'single' || type === 'multiple') && options.length >= 3) score += 0.1

  return Math.min(score, 1)
}
