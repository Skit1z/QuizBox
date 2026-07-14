import { marked } from 'marked'
import katex from 'katex'
import { uploadImage } from './docs-api'

/**
 * 文档渲染器(仅上传时调用一次)。
 * 解析原始文件为 HTML,docx 图片提取后单独上传,HTML 内引用云端 URL。
 * 阅读页不再需要此模块(云端已存渲染产物)。
 */

export interface RenderResult {
  /** 图片 URL 已替换完毕的 HTML,可直接上传/渲染 */
  html: string
  /** 供构造 DocMeta 用 */
  meta: { imageCount: number; htmlSize: number }
}

/** 渲染进度回调(用于上传 UI 展示图片进度) */
export type RenderProgress = (phase: 'parsing' | 'uploading-images', detail?: string) => void

/**
 * 解析文档并把图片上传到云端,返回 URL 已替换的 HTML。
 * @throws 解析失败或图片上传失败时抛出
 */
export async function renderDoc(file: File, onProgress?: RenderProgress): Promise<RenderResult> {
  const ext = file.name.split('.').pop()?.toLowerCase()
  if (ext === 'docx') return renderDocx(file, onProgress)
  if (ext === 'md') return renderMd(file)
  throw new Error(`不支持的文件格式: ${file.name}`)
}

// ===== .docx =====

async function renderDocx(file: File, onProgress?: RenderProgress): Promise<RenderResult> {
  onProgress?.('parsing', '解析 Word 文档…')
  const mammoth = (await import('mammoth')).default
  const arrayBuffer = await file.arrayBuffer()
  const result = await mammoth.convertToHtml({ arrayBuffer })
  let html = result.value

  // 提取内联 base64 图片,逐张上传,替换为云端 URL
  const imgRe = /<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g
  const matches = [...html.matchAll(imgRe)]
  let uploaded = 0
  for (const m of matches) {
    const mime = m[1]
    const base64 = m[2]
    const blob = base64ToBlob(base64, mime)
    onProgress?.('uploading-images', `上传图片 ${uploaded + 1}/${matches.length}`)
    const { url } = await uploadImage(blob)
    // 替换该 img 标签为带云端 URL 的标准形式
    html = html.replace(m[0], `<img src="${url}" alt="" />`)
    uploaded++
  }

  return {
    html,
    meta: { imageCount: matches.length, htmlSize: new Blob([html]).size },
  }
}

// ===== .md =====

async function renderMd(file: File): Promise<RenderResult> {
  const text = await file.text()
  marked.setOptions({ gfm: true, breaks: true })
  let html = marked.parse(text) as string

  // marked 不处理 $...$ 公式,后处理渲染 KaTeX(复用项目已有 katex 依赖)
  html = renderKatexInHtml(html)

  // md 内联 base64 图片(罕见)同样上传替换
  const imgRe = /<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g
  const matches = [...html.matchAll(imgRe)]
  for (const m of matches) {
    const blob = base64ToBlob(m[2], m[1])
    const { url } = await uploadImage(blob)
    html = html.replace(m[0], `<img src="${url}" alt="" />`)
  }

  return {
    html,
    meta: { imageCount: matches.length, htmlSize: new Blob([html]).size },
  }
}

/**
 * 在已渲染的 HTML 中把 $...$ / $$...$$ 替换为 KaTeX 输出。
 * 与 utils/katex.ts 的 renderRichText 不同:这里输入已是 HTML(marked 产出),
 * 只处理文本节点里的 $...$,不动已有标签。
 */
function renderKatexInHtml(html: string): string {
  // 块级 $$...$$
  html = html.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => renderTex(expr.trim(), true))
  // 行内 $...$(避免跨行、避免吃掉 HTML 标签里的 $)
  html = html.replace(/\$([^\$\n<>]+?)\$/g, (_, expr) => renderTex(expr.trim(), false))
  return html
}

function renderTex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr, {
      displayMode,
      throwOnError: false,
      output: 'html',
      trust: false,
      strict: 'ignore',
    })
  } catch {
    return `<code>${expr}</code>`
  }
}

function base64ToBlob(base64: string, mime: string): Blob {
  const bytes = atob(base64)
  const arr = new Uint8Array(bytes.length)
  for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
