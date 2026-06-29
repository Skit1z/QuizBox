import mammoth from 'mammoth'
import type { ParsedImage } from './docx-parser'

export interface DocParseResult {
  text: string
  html: string
  images: ParsedImage[]
}

/**
 * 解析 .doc 文件。
 * 取巧方案：先尝试 mammoth（部分 .doc 实际是 .docx 改后缀），
 * 失败则走二进制文本提取（OLE2 中的 UTF-16LE 文本流）。
 */
export async function parseDoc(file: File): Promise<DocParseResult> {
  const arrayBuffer = await file.arrayBuffer()

  // 1) 先试 mammoth — 有些 .doc 实际上是 .docx 格式（改了后缀）
  try {
    const result = await mammoth.extractRawText({ arrayBuffer })
    if (result.value.trim().length > 20) {
      return { text: result.value, html: result.value, images: [] }
    }
  } catch {
    // mammoth 解析失败，走兜底
  }

  // 2) 二进制提取：扫描 OLE2 中的 UTF-16LE 文本
  const text = extractTextFromBinary(arrayBuffer)
  if (!text.trim()) {
    throw new Error('.doc 文件无法提取文本，建议另存为 .docx 格式后重试')
  }
  return { text, html: text, images: [] }
}

/**
 * 从 .doc 二进制中提取文本。
 * Word 97-2003 的正文以 UTF-16LE 存储，扫描连续的可读字符区段。
 */
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

  const meaningful = chunks.filter(isReadableChunk)
  return meaningful.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** 只接受真正的文本码位，排除 OLE2 格式数据常映射到的区间 */
function isTextCodePoint(cp: number): boolean {
  // ASCII 可打印
  if (cp >= 0x20 && cp <= 0x7e) return true
  // 常用中文标点 + 全角符号
  if (cp >= 0x2000 && cp <= 0x206f) return true // 通用标点
  if (cp >= 0x3000 && cp <= 0x303f) return true // CJK 符号和标点（。、「」）
  if (cp >= 0xff00 && cp <= 0xff5e) return true // 全角 ASCII
  // CJK 统一汉字（主区 + 扩展 A）
  if (cp >= 0x4e00 && cp <= 0x9fff) return true
  if (cp >= 0x3400 && cp <= 0x4dbf) return true
  // 拉丁补充（法语、德语等西欧字符）
  if (cp >= 0x00c0 && cp <= 0x024f) return true
  // 不接受：日文假名(30A0-30FF,3040-309F)、韩文(AC00-D7AF)、
  // 私用区(E000-F8FF)、杂项符号、兼容区等 — 这些在中文题库中极罕见，
  // 但 OLE2 二进制格式数据经常映射到这些区间
  return false
}

/** 判断一个文本块是否为可读的有意义内容 */
function isReadableChunk(chunk: string): boolean {
  const t = chunk.trim()
  if (t.length < 4) return false

  // 统计常用汉字占比
  const cjkChars = t.match(/[一-鿿]/g)
  const cjkRatio = (cjkChars?.length || 0) / t.length

  // 统计标点符号
  const punctChars = t.match(/[。，、；：！？""''（）《》【】.,:;!?()\-\s\n]/g)
  const punctRatio = (punctChars?.length || 0) / t.length

  // 正文特征：汉字占比 > 20% 或 (汉字+标点+字母数字) 占比 > 60%
  const alnumChars = t.match(/[a-zA-Z0-9]/g)
  const meaningfulRatio = cjkRatio + punctRatio + (alnumChars?.length || 0) / t.length

  if (cjkRatio > 0.2) return true
  if (meaningfulRatio > 0.6 && t.length > 10) return true

  return false
}
