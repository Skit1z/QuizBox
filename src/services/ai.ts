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
  opts: { jsonMode?: boolean; temperature?: number } = {},
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
  opts: { temperature?: number } = {},
): Promise<T> {
  const raw = await chat(messages, { jsonMode: true, ...opts })
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
