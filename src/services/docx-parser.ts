import mammoth from 'mammoth'
import { sha256 } from '@/utils/hash'
import { db } from '@/db'

export interface ParsedImage {
  hash: string
  blob: Blob
}

export interface DocxParseResult {
  /** 纯文本（保留段落，图片位置用 [图] 占位） */
  text: string
  /** HTML 文本（含 img 标签，便于 AI 理解结构） */
  html: string
  images: ParsedImage[]
}

/**
 * 解析 .docx 文件。文本中图片位置以 [IMG_n] 占位，对应 images[n]。
 */
export async function parseDocx(file: File): Promise<DocxParseResult> {
  const arrayBuffer = await file.arrayBuffer()

  const htmlResult = await mammoth.convertToHtml({ arrayBuffer })

  // 从 HTML 中提取 base64 图片
  const images: ParsedImage[] = []
  let html = htmlResult.value
  const placeholders: string[] = []
  let idx = 0
  const matches = [...html.matchAll(/<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g)]
  for (const m of matches) {
    const mime = m[1]
    const base64 = m[2]
    const bytes = base64ToBytes(base64)
    const blob = new Blob([bytes], { type: mime })
    const hash = await sha256(blob)
    images.push({ hash, blob })
    placeholders.push(`[IMG_${idx}]`)
    idx++
  }
  let imgIdx = 0
  html = html.replace(
    /<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g,
    () => placeholders[imgIdx++] || '',
  )

  // 从 HTML 提取纯文本，避免二次解析
  const text = htmlToText(html)

  return { text, html, images }
}

function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>\s*<p[^>]*>/gi, '\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim()
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64)
  const len = bin.length
  const bytes = new Uint8Array(len)
  for (let i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i)
  return bytes
}

/** 保存解析出的图片到 attachments 表（按 hash 去重，批量写入） */
export async function saveImages(images: ParsedImage[]): Promise<void> {
  if (!images.length) return
  const hashes = images.map((i) => i.hash)
  // 一次批量查已存在项
  const existing = await db.attachments.bulkGet(hashes)
  const toAdd = images
    .filter((img, i) => !existing[i])
    .map((img) => ({
      hash: img.hash,
      blob: img.blob,
      size: img.blob.size,
      synced: false,
    }))
  if (toAdd.length) await db.attachments.bulkPut(toAdd)
}
