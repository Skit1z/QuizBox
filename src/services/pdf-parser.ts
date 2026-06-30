/**
 * PDF 文件解析：调用飞桨 PaddleOCR 云 API（异步任务模式）。
 * 流程：上传 PDF → 轮询任务状态 → 下载 JSONL 结果 → 拼接 Markdown + 图片。
 */

import { sha256 } from '@/utils/hash'
import type { ParsedImage } from './docx-images'

const JOB_URL = 'https://paddleocr.aistudio-app.com/api/v2/ocr/jobs'
const MODEL = 'PaddleOCR-VL-1.6'
const POLL_INTERVAL = 5000
const MAX_POLL_COUNT = 120 // 最多 10 分钟

export interface PdfParseResult {
  text: string
  html: string
  images: ParsedImage[]
}

export interface PdfParseProgress {
  state: 'pending' | 'running' | 'done' | 'failed'
  totalPages?: number
  extractedPages?: number
}

export async function parsePdf(
  file: File,
  token: string,
  onProgress?: (p: PdfParseProgress) => void,
): Promise<PdfParseResult> {
  if (!token) {
    throw new Error('未配置 PaddleOCR Token，请在设置中填写')
  }

  const jobId = await submitJob(file, token)
  const jsonlUrl = await pollUntilDone(jobId, token, onProgress)
  return await fetchResults(jsonlUrl)
}

async function submitJob(file: File, token: string): Promise<string> {
  const form = new FormData()
  form.append('file', file)
  form.append('model', MODEL)
  form.append(
    'optionalPayload',
    JSON.stringify({
      useDocOrientationClassify: false,
      useDocUnwarping: false,
      useChartRecognition: false,
    }),
  )

  const res = await fetch(JOB_URL, {
    method: 'POST',
    headers: { Authorization: `bearer ${token}` },
    body: form,
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OCR 提交失败 (${res.status}): ${detail.slice(0, 200)}`)
  }

  const data = await res.json()
  const jobId = data?.data?.jobId
  if (!jobId) throw new Error('OCR 返回异常：缺少 jobId')
  return jobId
}

async function pollUntilDone(
  jobId: string,
  token: string,
  onProgress?: (p: PdfParseProgress) => void,
): Promise<string> {
  for (let i = 0; i < MAX_POLL_COUNT; i++) {
    await sleep(POLL_INTERVAL)

    const res = await fetch(`${JOB_URL}/${jobId}`, {
      headers: { Authorization: `bearer ${token}` },
    })
    if (!res.ok) throw new Error(`OCR 状态查询失败 (${res.status})`)

    const { data } = await res.json()
    const state: string = data.state

    if (state === 'pending') {
      onProgress?.({ state: 'pending' })
    } else if (state === 'running') {
      onProgress?.({
        state: 'running',
        totalPages: data.extractProgress?.totalPages,
        extractedPages: data.extractProgress?.extractedPages,
      })
    } else if (state === 'done') {
      onProgress?.({
        state: 'done',
        extractedPages: data.extractProgress?.extractedPages,
      })
      const jsonlUrl = data.resultUrl?.jsonUrl
      if (!jsonlUrl) throw new Error('OCR 完成但缺少结果链接')
      return jsonlUrl
    } else if (state === 'failed') {
      throw new Error(`OCR 识别失败: ${data.errorMsg || '未知错误'}`)
    }
  }
  throw new Error('OCR 超时，请稍后重试')
}

async function fetchResults(jsonlUrl: string): Promise<PdfParseResult> {
  const res = await fetch(jsonlUrl)
  if (!res.ok) throw new Error(`下载 OCR 结果失败 (${res.status})`)

  const text = await res.text()
  const lines = text.trim().split('\n').filter(Boolean)

  const allTextParts: string[] = []
  const allImages: ParsedImage[] = []
  const imgTasks: Promise<{ idx: number; hash: string; blob: Blob } | null>[] = []
  let imgIdx = 0

  for (const line of lines) {
    const { result } = JSON.parse(line)
    if (!result?.layoutParsingResults) continue

    for (const layout of result.layoutParsingResults) {
      const md = layout.markdown
      if (!md) continue

      let pageText = md.text || ''

      // 收集图片下载任务，稍后并行执行
      if (md.images && typeof md.images === 'object') {
        for (const [imgPath, imgUrl] of Object.entries(md.images)) {
          const placeholder = `[IMG_${imgIdx}]`
          pageText = pageText.replaceAll(`![](${imgPath})`, placeholder)
          pageText = pageText.replaceAll(imgPath, placeholder)

          const idx = imgIdx++
          imgTasks.push(
            fetch(imgUrl as string)
              .then(async (r) => {
                if (!r.ok) return null
                const blob = await r.blob()
                const hash = await sha256(blob)
                return { idx, hash, blob } as const
              })
              .catch(() => null),
          )
        }
      }

      allTextParts.push(pageText)
    }
  }

  // 并行下载所有图片
  const imgResults = await Promise.all(imgTasks)
  const remap = new Map<number, number>()
  for (const r of imgResults) {
    if (!r) continue
    remap.set(r.idx, allImages.length)
    allImages.push({ hash: r.hash, blob: r.blob })
  }

  const finalText = allTextParts.join('\n\n').replace(/\[IMG_(\d+)\]/g, (_, rawIdx: string) => {
    const nextIdx = remap.get(Number(rawIdx))
    return nextIdx === undefined ? '' : `[IMG_${nextIdx}]`
  })
  return {
    text: finalText,
    html: finalText,
    images: allImages,
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
