/**
 * Markdown 文件解析：直接读取文本内容。
 * Markdown 本身就是结构化文本，无需额外转换，直接送 AI 解析。
 */

export interface MdParseResult {
  text: string
  html: string
  images: []
}

export async function parseMd(file: File): Promise<MdParseResult> {
  const text = await file.text()
  return {
    text,
    html: text,
    images: [],
  }
}
