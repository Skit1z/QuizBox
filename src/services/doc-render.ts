import { marked } from 'marked'
import katex from 'katex'
import DOMPurify from 'dompurify'
import { uploadImage } from './docs-api'

/**
 * 文档渲染器(仅上传时调用一次)。
 * 解析原始文件为 HTML,docx 图片提取后单独上传,HTML 内引用云端 URL。
 * 阅读页不再需要此模块(云端已存渲染产物)。
 */

/**
 * 清洗 HTML,剥离 XSS 风险(script / 事件处理器 / javascript: 协议等)。
 * marked v18 与 mammoth 都可能透传用户输入里的裸 HTML,产物最终走 v-html,
 * 必须在入库前清洗一次,避免存储型 XSS。
 */
function sanitizeHtml(html: string): string {
  return DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    // 禁用内联 style(可被用于 CSS 注入),保留 class 供 KaTeX/prose 样式
    FORBID_ATTR: ['style'],
  })
}

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
  let result
  try {
    result = await mammoth.convertToHtml({ arrayBuffer })
  } catch {
    // 损坏 / 非法 docx:统一提示,不暴露 mammoth 原始错误
    throw new Error('文档格式无法解析')
  }
  let html = result.value

  // 先提取内联 base64 图片并上传(此时 html 未经 sanitize,base64 src 完整保留),
  // 替换为云端 https URL 后再做 XSS 清洗 —— 避免 data URI 被 DOMPurify 误判
  const imgRe = /<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g
  const matches = [...html.matchAll(imgRe)]
  let uploaded = 0
  for (const m of matches) {
    const mime = m[1]
    const base64 = m[2]
    const blob = base64ToBlob(base64, mime)
    onProgress?.('uploading-images', `上传图片 ${uploaded + 1}/${matches.length}`)
    const url = await uploadImage(blob)
    // 替换该 img 标签为带云端 URL 的标准形式
    html = html.replace(m[0], `<img src="${url}" alt="" />`)
    uploaded++
  }

  // 图片已全部替换为 https URL,此时清洗 XSS 不再涉及 data URI
  html = sanitizeHtml(html)

  return {
    html,
    meta: { imageCount: matches.length, htmlSize: new Blob([html]).size },
  }
}

// ===== .md =====

async function renderMd(file: File): Promise<RenderResult> {
  const text = await file.text()
  // marked.parse 在同步配置下返回 string;防御未来启用 async 扩展时返回 Promise
  let parsed: string | Promise<string>
  try {
    parsed = marked.parse(text, { gfm: true, breaks: true })
  } catch {
    throw new Error('文档格式无法解析')
  }
  if (typeof parsed !== 'string') {
    throw new Error('marked 异步模式不支持,请检查扩展配置')
  }
  // 先清洗 marked 透传的裸 HTML(XSS 防御),再渲染 KaTeX(输出可信 span)
  let html = sanitizeHtml(parsed)

  // marked 不处理 $...$ 公式,后处理渲染 KaTeX(复用项目已有 katex 依赖)
  html = renderKatexInHtml(html)

  // md 内联 base64 图片(罕见)同样上传替换
  const imgRe = /<img[^>]+src="data:([^;]+);base64,([^"]+)"[^>]*\/?>/g
  const matches = [...html.matchAll(imgRe)]
  for (const m of matches) {
    const blob = base64ToBlob(m[2], m[1])
    const url = await uploadImage(blob)
    html = html.replace(m[0], `<img src="${url}" alt="" />`)
  }

  return {
    html,
    meta: { imageCount: matches.length, htmlSize: new Blob([html]).size },
  }
}

/**
 * 在已渲染的 HTML 中把 $...$ / $$...$$ 替换为 KaTeX 输出。
 * 与 utils/katex.ts 的 renderRichText 不同:这里输入已是 HTML(marked 产出)。
 *
 * 通过 DOM 文本节点遍历处理公式,跳过 code/pre/script/style/textarea —— 否则代码块
 * 里的 `$$...$$` 或成对 `$` 会被误当公式渲染,破坏 GFM 代码块的原始内容,
 * 也避免破坏标签属性里的 `$`。
 */
function renderKatexInHtml(html: string): string {
  if (!html.includes('$')) return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const SKIP = new Set(['CODE', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA'])
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT)
  const targets: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const t = node as Text
    if (!t.nodeValue || !t.nodeValue.includes('$')) continue
    let anc = t.parentElement
    let skip = false
    while (anc) {
      if (SKIP.has(anc.tagName)) {
        skip = true
        break
      }
      anc = anc.parentElement
    }
    if (!skip) targets.push(t)
  }
  for (const t of targets) {
    const rendered = texTextToHtml(t.nodeValue!)
    if (rendered == null) continue // 无公式命中,保持原节点
    const tpl = doc.createElement('template')
    tpl.innerHTML = rendered
    t.replaceWith(tpl.content)
  }
  return doc.body.innerHTML
}

/**
 * 把纯文本里的 $...$ / $$...$$ 转成 KaTeX HTML,非公式片段做 HTML 转义。
 * 无公式命中时返回 null(调用方跳过替换,保持原文本节点)。
 */
function texTextToHtml(text: string): string | null {
  const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  let out = ''
  let i = 0
  let hit = false
  while (i < text.length) {
    if (text.startsWith('$$', i)) {
      const end = text.indexOf('$$', i + 2)
      if (end > i + 1) {
        out += renderTex(text.slice(i + 2, end).trim(), true)
        i = end + 2
        hit = true
        continue
      }
    }
    if (text[i] === '$') {
      const m = /^\$([^$\n]+?)\$/.exec(text.slice(i))
      if (m) {
        out += renderTex(m[1].trim(), false)
        i += m[0].length
        hit = true
        continue
      }
    }
    out += esc(text[i])
    i++
  }
  return hit ? out : null
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
