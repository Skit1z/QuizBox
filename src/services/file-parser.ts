/**
 * 统一文件解析入口：根据文件扩展名分发到不同管线。
 *   .docx → mammoth.js（浏览器端）
 *   .md   → 直接读取文本
 *   .pdf  → PaddleOCR 服务端识别
 */

import { parseDocx, type ParsedImage } from './docx-parser'
import { parseDoc } from './doc-parser'
import { parseMd } from './md-parser'
import { parsePdf, type PdfParseProgress } from './pdf-parser'

export type SupportedExt = 'docx' | 'doc' | 'md' | 'pdf'

export const SUPPORTED_EXTENSIONS: SupportedExt[] = ['docx', 'doc', 'md', 'pdf']

export const EXT_LABELS: Record<SupportedExt, string> = {
  docx: 'Word 文档 (.docx)',
  doc: 'Word 文档 (.doc)',
  md: 'Markdown',
  pdf: 'PDF（OCR 识别）',
}

export interface FileParseResult {
  text: string
  html: string
  images: ParsedImage[]
}

export function getFileExt(filename: string): SupportedExt | null {
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext === 'docx' || ext === 'doc' || ext === 'md' || ext === 'pdf') return ext
  return null
}

export function isSupportedFile(filename: string): boolean {
  return getFileExt(filename) !== null
}

export const ACCEPT_EXTENSIONS = '.docx,.doc,.md,.pdf'

export async function parseFile(
  file: File,
  opts?: { ocrToken?: string; onPdfProgress?: (p: PdfParseProgress) => void },
): Promise<FileParseResult> {
  const ext = getFileExt(file.name)

  switch (ext) {
    case 'docx':
      return parseDocx(file)

    case 'doc':
      return parseDoc(file)

    case 'md':
      return parseMd(file)

    case 'pdf':
      return parsePdf(file, opts?.ocrToken || '', opts?.onPdfProgress)

    default:
      throw new Error(`不支持的文件格式: ${file.name}`)
  }
}
