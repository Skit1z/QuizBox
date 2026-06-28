// AI 供应商预设：选供应商后只需填 API Key。
// baseUrl 已固定，model 为该供应商推荐默认模型，用户可改。

export interface AiProvider {
  /** 供应商 id，'custom' 表示手动输入 */
  id: string
  label: string
  /** OpenAI 兼容接口的 base URL（不含末尾 /chat/completions） */
  baseUrl: string
  /** 默认推荐模型 */
  model: string
  /** 是否需要用户手动填 baseUrl（custom） */
  custom?: boolean
  /** 可选模型列表（供下拉） */
  models?: string[]
  /** 申请 key 的指引链接 */
  keyHelp?: string
}

export const AI_PROVIDERS: AiProvider[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com/v1',
    model: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyHelp: 'https://platform.deepseek.com/api_keys',
  },
  {
    id: 'glm',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4', 'glm-4-plus', 'glm-4-air'],
    keyHelp: 'https://open.bigmodel.cn/usercenter/apikeys',
  },
  {
    id: 'siliconflow',
    label: '硅基流动',
    baseUrl: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen2.5-7B-Instruct',
    models: [
      'Qwen/Qwen2.5-7B-Instruct',
      'Qwen/Qwen2.5-72B-Instruct',
      'deepseek-ai/DeepSeek-V3',
      'deepseek-ai/DeepSeek-R1',
    ],
    keyHelp: 'https://cloud.siliconflow.cn/account/ak',
  },
  {
    id: 'moonshot',
    label: 'Moonshot (Kimi)',
    baseUrl: 'https://api.moonshot.cn/v1',
    model: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    keyHelp: 'https://platform.moonshot.cn/console/api-keys',
  },
  {
    id: 'dashscope',
    label: '阿里通义千问',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    model: 'qwen-turbo',
    models: ['qwen-turbo', 'qwen-plus', 'qwen-max'],
    keyHelp: 'https://dashscope.console.aliyun.com/apiKey',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4-turbo'],
    keyHelp: 'https://platform.openai.com/api-keys',
  },
  {
    id: 'custom',
    label: '自定义 / 兼容接口',
    baseUrl: '',
    model: '',
    custom: true,
  },
]

export function findProvider(id: string): AiProvider | undefined {
  return AI_PROVIDERS.find((p) => p.id === id)
}
