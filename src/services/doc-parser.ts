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

  // 替换表：Word 控制字符 → 可读字符
  const ctrl: Record<number, string> = {
    0x07: '\t', 0x0a: '\n', 0x0b: '\n', 0x0c: '\n', 0x0d: '\n',
  }

  // 尝试 UTF-16LE 解码（.doc 正文的主要编码）
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

    // 可打印区间：ASCII 0x20-0x7e，CJK 及常见 Unicode
    if ((cp >= 0x20 && cp <= 0x7e) || cp >= 0x00a0) {
      run += String.fromCharCode(cp)
    } else if (cp < 0x20) {
      // 不可见控制字符 → 跳过
    } else {
      if (run.length > 2) chunks.push(run)
      run = ''
    }
  }
  if (run.length > 2) chunks.push(run)

  // 过滤：只保留含中文或足够长的片段（去掉 OLE 元数据噪声）
  const meaningful = chunks.filter(
    (c) => (c.length > 10 && /[一-鿿]/.test(c)) || c.length > 40,
  )

  return meaningful.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}
