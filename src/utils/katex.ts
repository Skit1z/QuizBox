import katex from 'katex'
import 'katex/dist/katex.min.css'

/**
 * 渲染文本中的 LaTeX 公式（支持 $...$ 行内、$$...$$ 块级），返回 HTML 字符串。
 * 同时转义其他 HTML，防止 XSS。
 */
export function renderRichText(text: string): string {
  if (!text) return ''
  // 性能优化：不含 $ 的纯文本无需走公式解析，直接转义返回
  if (!text.includes('$')) {
    return escapeHtml(text).replace(/\n/g, '<br/>')
  }
  // 先把公式占位提取出来
  const blocks: string[] = []
  let working = text
  // 块级 $$...$$
  working = working.replace(/\$\$([\s\S]+?)\$\$/g, (_, expr) => {
    const html = renderTex(expr, true)
    blocks.push(html)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })
  // 行内 $...$
  working = working.replace(/\$([^\$\n]+?)\$/g, (_, expr) => {
    const html = renderTex(expr, false)
    blocks.push(html)
    return `\u0000BLOCK${blocks.length - 1}\u0000`
  })
  // 转义剩余文本，保留换行
  working = escapeHtml(working).replace(/\n/g, '<br/>')
  // 还原公式块
  working = working.replace(/\u0000BLOCK(\d+)\u0000/g, (_, i) => blocks[Number(i)])
  return working
}

function renderTex(expr: string, displayMode: boolean): string {
  try {
    return katex.renderToString(expr.trim(), {
      displayMode,
      throwOnError: false,
      output: 'html',
      // 安全：禁止信任任意输入，禁止 \href 的 javascript: 等危险协议
      trust: false,
      strict: 'ignore',
      macros: {
        // 屏蔽可能被滥用的命令
        '\\href': '\\text{\\href}',
      },
    })
  } catch {
    return `<code>${escapeHtml(expr)}</code>`
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}
