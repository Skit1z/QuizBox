import { chatJson } from './ai'
import type { ParsedQuestion } from './importer'
import { parseWithRulesHybrid } from './rule-parser'
import type { HybridResult, RuleProfile } from './rule-parser'

/**
 * AI 题库格式识别（fallback）。
 *
 * 设计要点：本模块**不自带解析器**，只在默认规则明显搞不定时，让 AI 推断这份题库的
 * 结构性"方言"（题号/选项开头的正则），再把参数喂回统一的 `parseWithRulesHybrid` 引擎。
 * 这样：
 *  - 两条路共用同一套解析"语法"（内联拆分/答案剥离/判断改错…），不再各自漂移；
 *  - AI 给的正则若无效，引擎会安全回退默认 → profile 路最差也只等于默认规则，绝不更差。
 */

interface ParseProfile {
  questionStart?: string
  optionStart?: string
}

const PROFILE_SYSTEM = `你是题库格式识别助手。用户给你一份题库片段，你只需识别两条稳定排版规则并输出 JSON：
- questionStart：匹配每道题开头的正则，必须用第 1 个捕获组捕获题号数字。
- optionStart：匹配每个选项开头的正则，第 1 个捕获组为选项字母（只需匹配"A."这样的前缀，不必捕获选项正文）。
只输出 JSON，不要解释。示例：
{"questionStart":"^\\\\s*(\\\\d{1,4})[.、．)]\\\\s*","optionStart":"^\\\\s*([A-Ha-h])[.、．)]\\\\s*"}`

const DEFAULT_PROFILE: Required<ParseProfile> = {
  questionStart: '^\\s*[(（【\\[]?(\\d{1,4})[)）】\\]]?[.、．)]\\s*',
  optionStart: '^\\s*[(（【\\[]?([A-Ha-h])[)）】\\]]?[.、．)]\\s*',
}

export function shouldTryProfileParse(hybrid: HybridResult, text: string): boolean {
  const questions = hybrid.questions
  if (questions.length === 0) return text.trim().length > 200
  if (questions.length < 20 && text.length > 6000) return true
  if (hybrid.lowConfidenceBlocks.length > 40) return true

  const lowRatio = questions.filter((q) => (q.confidence ?? 0) < 0.6).length / questions.length
  if (lowRatio > 0.35) return true

  const shortRatio =
    questions.filter((q) => q.type === 'short' || q.type === 'essay').length / questions.length
  if (questions.length > 30 && shortRatio > 0.55) return true

  const brokenChoiceRatio =
    questions.filter(
      (q) => (q.type === 'single' || q.type === 'multiple') && (q.options?.length ?? 0) < 2,
    ).length / questions.length
  return brokenChoiceRatio > 0.2
}

export function profileParseScore(hybrid: HybridResult): number {
  const questions = hybrid.questions
  const answered = questions.filter((q) => hasAnswer(q.answer)).length
  const choiceReady = questions.filter(
    (q) => (q.type === 'single' || q.type === 'multiple') && (q.options?.length ?? 0) >= 2,
  ).length
  const brokenChoice = questions.filter(
    (q) => (q.type === 'single' || q.type === 'multiple') && (q.options?.length ?? 0) < 2,
  ).length
  const low = questions.filter((q) => (q.confidence ?? 0) < 0.6).length
  return questions.length * 5 + answered * 3 + choiceReady * 2 - brokenChoice * 6 - low * 3
}

export function isProfileResultBetter(current: HybridResult, profiled: HybridResult): boolean {
  if (profiled.questions.length === 0) return false
  if (profiled.questions.length < Math.max(3, current.questions.length * 0.65)) return false
  return profileParseScore(profiled) > profileParseScore(current) + 12
}

export async function parseWithDetectedProfile(
  text: string,
  onProgress?: (message: string) => void,
): Promise<HybridResult> {
  onProgress?.('AI 正在识别题库格式…')
  const profile = await detectProfile(text)
  onProgress?.('正在按识别规则重新解析…')
  const ruleProfile: RuleProfile = {
    questionStart: profile.questionStart,
    optionStart: profile.optionStart,
  }
  return parseWithRulesHybrid(text, ruleProfile)
}

async function detectProfile(text: string): Promise<ParseProfile> {
  const sample = buildProfileSample(text)
  const profile = await chatJson<ParseProfile>(
    [
      { role: 'system', content: PROFILE_SYSTEM },
      { role: 'user', content: sample },
    ],
    { temperature: 0, maxTokens: 400 },
  )
  return {
    questionStart: profile.questionStart || DEFAULT_PROFILE.questionStart,
    optionStart: profile.optionStart || DEFAULT_PROFILE.optionStart,
  }
}

function buildProfileSample(text: string): string {
  const normalized = text.replace(/\r\n/g, '\n')
  const head = normalized.slice(0, 6000)
  const tail = normalized.slice(Math.max(0, normalized.length - 3000))
  return ['请识别以下题库的排版规则。只输出 JSON。', '--- 文档开头 ---', head, '--- 文档结尾 ---', tail].join(
    '\n',
  )
}

function hasAnswer(answer: ParsedQuestion['answer']): boolean {
  return Array.isArray(answer) ? answer.length > 0 : !!answer
}
