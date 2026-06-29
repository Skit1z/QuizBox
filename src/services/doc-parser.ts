import mammoth from 'mammoth'
import type { ParsedImage } from './docx-parser'

export interface DocParseResult {
  text: string
  html: string
  images: ParsedImage[]
}

export async function parseDoc(file: File): Promise<DocParseResult> {
  const arrayBuffer = await file.arrayBuffer()

  try {
    const result = await mammoth.extractRawText({ arrayBuffer })
    if (result.value.trim().length > 20) {
      return { text: result.value, html: result.value, images: [] }
    }
  } catch {
    // mammoth 解析失败，走兜底
  }

  const text = extractTextFromBinary(arrayBuffer)
  if (!text.trim()) {
    throw new Error('.doc 文件无法提取文本，建议另存为 .docx 格式后重试')
  }
  return { text, html: text, images: [] }
}

function extractTextFromBinary(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)

  const ctrl: Record<number, string> = {
    0x07: '\t', 0x0a: '\n', 0x0b: '\n', 0x0c: '\n', 0x0d: '\n',
  }

  const chunks: string[] = []
  let run = ''

  for (let i = 0; i + 1 < bytes.length; i += 2) {
    const lo = bytes[i]
    const hi = bytes[i + 1]
    const cp = lo | (hi << 8)

    if (cp === 0) {
      if (run.length > 2) chunks.push(run)
      run = ''
      continue
    }

    const replacement = ctrl[cp]
    if (replacement) {
      run += replacement
      continue
    }

    if (isTextCodePoint(cp)) {
      run += String.fromCharCode(cp)
    } else {
      if (run.length > 2) chunks.push(run)
      run = ''
    }
  }
  if (run.length > 2) chunks.push(run)

  const raw = chunks.join('\n')
  return filterExtractedText(raw)
}

function isTextCodePoint(cp: number): boolean {
  if (cp >= 0x20 && cp <= 0x7e) return true
  if (cp >= 0x00a0 && cp <= 0x024f) return true
  if (cp >= 0x2000 && cp <= 0x206f) return true
  if (cp >= 0x2190 && cp <= 0x22ff) return true
  if (cp >= 0x3000 && cp <= 0x303f) return true
  if (cp >= 0x3400 && cp <= 0x4dbf) return true
  if (cp >= 0x4e00 && cp <= 0x9fff) return true
  if (cp >= 0xff00 && cp <= 0xff5e) return true
  return false
}

function filterExtractedText(text: string): string {
  const metaIdx = findMetaMarker(text)
  const usable = metaIdx >= 0 ? text.slice(0, metaIdx) : text

  return usable
    .split('\n')
    .filter(line => !isGarbledExtractedLine(line))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const RE_CN_PUNCT = /[。，、；：！？""''（）《》【】…]/
const RE_QUESTION_NUM = /^\d{1,3}[.、．)）]/
const RE_OPTION = /^[A-Ha-h][.、．)）\s]/
const RE_ANSWER_KW = /^(答案|解析|答|对|错|正确|错误|[TF]$)/

function findMetaMarker(text: string): number {
  const markers = ['WordDocument', 'SummaryInformation', 'DocumentSummaryInformation']
  let earliest = -1
  for (const m of markers) {
    const idx = text.indexOf(m)
    if (idx >= 0 && (earliest < 0 || idx < earliest)) earliest = idx
  }
  if (earliest >= 0) {
    const lineStart = text.lastIndexOf('\n', earliest)
    return lineStart >= 0 ? lineStart : earliest
  }
  return -1
}

function isGarbledExtractedLine(line: string): boolean {
  const t = line.trim()
  if (!t) return false
  if (t.length <= 2) return false

  if (RE_CN_PUNCT.test(t)) return false
  if (RE_QUESTION_NUM.test(t)) return false
  if (RE_OPTION.test(t)) return false
  if (RE_ANSWER_KW.test(t)) return false

  const isolatedAsciiMix = (t.match(/[一-鿿][A-Za-z]{1,2}[一-鿿]/g) || []).length
  if (isolatedAsciiMix >= 2) return true

  if (/[À-ɏ]/.test(t) && /[一-鿿]/.test(t)) return true

  const extACount = (t.match(/[㐀-䶿]/g) || []).length
  if (extACount >= 3) return true

  const cjkCount = (t.match(/[一-鿿]/g) || []).length
  const ratio = cjkCount / t.length

  if (t.length <= 8 && ratio < 0.5 && !RE_CN_PUNCT.test(t)) return true
  if (t.length > 8 && t.length <= 20 && ratio < 0.3 && !RE_CN_PUNCT.test(t)) return true

  if (t.length >= 6) {
    for (let patLen = 2; patLen <= 4; patLen++) {
      const pat = t.slice(0, patLen)
      let repeats = 0
      for (let i = 0; i + patLen <= t.length; i += patLen) {
        if (t.slice(i, i + patLen) === pat) repeats++
        else break
      }
      if (repeats >= 3) return true
    }
  }

  return false
}
