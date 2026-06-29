/**
 * 统一文件解析入口：根据文件扩展名分发到不同管线。
 *   .docx → mammoth.js（浏览器端）
 *   .md   → 直接读取文本
 *   .pdf  → PaddleOCR 服务端识别
 *
 * 注：.doc（旧二进制格式）不受支持。浏览器端无可靠解析库，
 *     请在 Word/WPS 中另存为 .docx 后导入。
 */

import { parseDocx, type ParsedImage } from './docx-parser'
import { parseMd } from './md-parser'
import { parsePdf, type PdfParseProgress } from './pdf-parser'

export type SupportedExt = 'docx' | 'md' | 'pdf'

export const SUPPORTED_EXTENSIONS: SupportedExt[] = ['docx', 'md', 'pdf']

export const EXT_LABELS: Record<SupportedExt, string> = {
  docx: 'Word 文档 (.docx)',
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
  if (ext === 'docx' || ext === 'md' || ext === 'pdf') return ext
  // 明确拦截 .doc，给出友好提示而非当未知格式
  if (ext === 'doc') return null
  return null
}

export function isDocFile(filename: string): boolean {
  return filename.split('.').pop()?.toLowerCase() === 'doc'
}

export function isSupportedFile(filename: string): boolean {
  return getFileExt(filename) !== null
}

export const ACCEPT_EXTENSIONS = '.docx,.md,.pdf'

export async function parseFile(
  file: File,
  opts?: { ocrToken?: string; onPdfProgress?: (p: PdfParseProgress) => void },
): Promise<FileParseResult> {
  const ext = getFileExt(file.name)

  switch (ext) {
    case 'docx':
      return parseDocx(file)

    case 'md':
      return parseMd(file)

    case 'pdf':
      return parsePdf(file, opts?.ocrToken || '', opts?.onPdfProgress)

    default:
      throw new Error(
        isDocFile(file.name)
          ? '不支持 .doc 旧格式，请在 Word/WPS 中另存为 .docx 后重试'
          : `不支持的文件格式: ${file.name}`,
      )
  }
}
