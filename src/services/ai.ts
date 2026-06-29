import { useSettingsStore } from '@/stores/settings'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/**
 * 调用 OpenAI 兼容协议的 chat completions 接口。
 * 兼容 OpenAI / 智谱 GLM / DeepSeek 等。
 */
export async function chat(
  messages: ChatMessage[],
  opts: { jsonMode?: boolean; temperature?: number; maxTokens?: number } = {},
): Promise<string> {
  const settings = useSettingsStore()
  if (!settings.loaded) await settings.load()

  const { baseUrl, apiKey, model } = settings.ai
  if (!apiKey) throw new Error('未配置 AI API Key，请在设置中填写')

  const url = baseUrl.replace(/\/$/, '') + '/chat/completions'
  const body: Record<string, any> = {
    model,
    messages,
    temperature: opts.temperature ?? 0.1,
  }
  if (opts.jsonMode) {
    body.response_format = { type: 'json_object' }
  }
  if (opts.maxTokens) {
    body.max_tokens = opts.maxTokens
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    throw new Error(`AI 接口错误 (${res.status}): ${txt.slice(0, 200)}`)
  }

  const data = await res.json()
  const content = data?.choices?.[0]?.message?.content
  if (!content) throw new Error('AI 返回内容为空')
  return content as string
}

/** 请求 AI 返回 JSON 对象 */
export async function chatJson<T = any>(
  messages: ChatMessage[],
  opts: { temperature?: number; maxTokens?: number } = {},
): Promise<T> {
  const raw = await chat(messages, { jsonMode: true, ...opts })
  try {
    return parseJsonPayload<T>(raw)
  } catch {
    const fixed = await chat(
      [
        {
          role: 'system',
          content: '你只修复 JSON 格式。保持原字段和内容不变，仅输出合法 JSON，不要解释。',
        },
        { role: 'user', content: raw },
      ],
      { jsonMode: true, temperature: 0, maxTokens: opts.maxTokens },
    )
    return parseJsonPayload<T>(fixed)
  }
}

function parseJsonPayload<T>(raw: string): T {
  // 部分接口可能仍把 json 包在 markdown 里
  const cleaned = raw.replace(/^```json\s*|\s*```$/g, '').trim()
  try {
    return JSON.parse(cleaned) as T
  } catch {
    // 尝试提取第一个 {...} 或 [...]
    const m = cleaned.match(/[{[][\s\S]*[}\]]/)
    if (m) return JSON.parse(m[0]) as T
    throw new Error('AI 返回的不是有效 JSON')
  }
}

/**
 * 用指定配置（无需先保存到 store）发起一次最小请求，检测连通性与模型可用性。
 * 返回模型实际返回的内容（用于展示）。
 */
export async function testConnection(config: {
  baseUrl: string
  apiKey: string
  model: string
}): Promise<string> {
  if (!config.apiKey) throw new Error('请先填写 API Key')
  if (!config.baseUrl) throw new Error('请先填写 Base URL')
  if (!config.model) throw new Error('请先选择/填写模型')

  const url = config.baseUrl.replace(/\/$/, '') + '/chat/completions'
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [{ role: 'user', content: '请回复"OK"两个字' }],
      temperature: 0,
      max_tokens: 16,
    }),
  })

  if (!res.ok) {
    const txt = await res.text().catch(() => '')
    // 提取常见错误信息
    let detail = txt.slice(0, 200)
    try {
      const j = JSON.parse(txt)
      detail = j?.error?.message || j?.message || detail
    } catch {
      // 非 JSON，用原始文本
    }
    if (res.status === 401 || res.status === 403) {
      throw new Error('认证失败（401/403）：API Key 无效或无权访问')
    }
    if (res.status === 404) {
      throw new Error('接口地址或模型不存在（404）：请检查 Base URL 与模型名')
    }
    throw new Error(`接口错误 (${res.status})：${detail}`)
  }

  const data = await res.json()

  // 标准路径：choices[0].message.content
  const msg = data?.choices?.[0]?.message
  let content = msg?.content

  // 部分模型（如带 reasoning 的）会把内容放在 reasoning_content / thinking 字段
  if (!content) content = msg?.reasoning_content || msg?.thinking

  // content 存在（含空字符串）即视为连通成功
  if (content !== undefined && content !== null) {
    return content as string
  }

  // 兜底：确实没拿到内容，把响应结构摘要出来便于排查
  const keys = data && typeof data === 'object' ? Object.keys(data).join(', ') : String(data)
  const choiceKeys =
    data?.choices?.[0] && typeof data.choices[0] === 'object'
      ? Object.keys(data.choices[0]).join(', ')
      : ''
  throw new Error(
    `接口已连通但返回结构异常（顶层字段: ${keys}；choice 字段: ${choiceKeys}）。` +
      `若使用推理模型，可能内容在 reasoning 字段。`,
  )
}
