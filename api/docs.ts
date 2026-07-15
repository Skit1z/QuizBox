// Vercel Serverless Function:文档资料阅读器云端存储
//
// 存储布局(独立命名空间,不碰现有 quizbox/):
//   docs/manifest.json        (元数据清单,轻量 JSON)
//   docs/doc_<id>.json        (文档主体 { meta, html })
//   docs/img/<hash>.<ext>     (图片,public access,被 HTML <img src> 引用)
//
// 鉴权:写操作(POST/DELETE)需 BANK_KEY;读操作(GET)开放。
// 与 api/bank.ts 的 BANK_KEY 机制一致,密钥共享。

import { del, get, put, BlobNotFoundError } from '@vercel/blob'
import type { IncomingMessage, ServerResponse } from 'http'

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>
  body: any
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse
  json: (data: any) => void
}

export const config = { runtime: 'nodejs' }

const PREFIX = 'docs/'
const MANIFEST_PATH = `${PREFIX}manifest.json`
const MAX_REQUEST_BYTES = 4 * 1024 * 1024 // 文档 JSON body 上限
const MAX_IMAGE_BYTES = 2 * 1024 * 1024 // 单张图片上限

interface DocMeta {
  id: string
  name: string
  ext: 'docx' | 'md'
  uploadedAt: number
  htmlSize: number
  imageCount: number
}

interface DocsManifest {
  updatedAt: number
  docs: DocMeta[]
}

// ===== 通用 Blob 读写 =====

async function readJson<T = any>(path: string): Promise<T | null> {
  const access = path.startsWith('docs/img/') ? 'public' : 'private'
  let blob: Awaited<ReturnType<typeof get>> | null
  try {
    blob = await get(path, { access })
  } catch (e) {
    // 仅「文件不存在」视为空;网络异常、权限异常等必须上抛(→500),
    // 否则会被当成空清单,进而用空清单覆盖历史文档,造成数据丢失。
    if (e instanceof BlobNotFoundError) return null
    throw e
  }
  if (!blob?.stream) return null
  const text = await new Response(blob.stream).text()
  if (!text) return null
  // JSON 损坏同样上抛,而非静默返回 null —— 同理防止用空清单覆盖历史数据。
  return JSON.parse(text) as T
}

async function writeJson(path: string, body: string) {
  await put(path, body, {
    access: 'private',
    contentType: 'application/json',
    addRandomSuffix: false,
    allowOverwrite: true,
  })
}

// SHA-256(Node Web Crypto)
async function sha256Bytes(buf: Buffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

/** 校验写操作鉴权;未配置 BANK_KEY 时放行(与 bank.ts 一致),读操作不走这里 */
function checkAuth(req: VercelRequest, res: VercelResponse): boolean {
  const key = process.env.BANK_KEY
  if (!key) return true
  const auth = String(req.headers['authorization'] || '')
  if (auth !== `Bearer ${key}`) {
    res.status(401).json({ error: '未授权:密钥不匹配' })
    return false
  }
  return true
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  try {
    const url = req.url || ''
    // 图片上传统一走 /api/docs?action=upload-image(单文件函数分流,避免 Vercel
    // 需要为 /api/docs/img 单独建函数入口);兼容旧的 /api/docs/img 子路径写法。
    const isImgRoute =
      url.includes('action=upload-image') ||
      url.startsWith('/api/docs/img') ||
      req.query?.action === 'upload-image'

    if (req.method === 'GET') {
      return await handleGet(req, res)
    }
    if (req.method === 'POST') {
      if (!checkAuth(req, res)) return
      return isImgRoute ? await handleUploadImage(req, res) : await handleUploadDoc(req, res)
    }
    if (req.method === 'DELETE') {
      if (!checkAuth(req, res)) return
      return await handleDelete(req, res)
    }
    res.status(405).json({ error: 'method not allowed' })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '文档存储错误' })
  }
}

// ===== GET:读清单 / 读单文档 =====

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const q = req.query || {}
  const manifest = await readJson<DocsManifest>(MANIFEST_PATH)

  // GET /api/docs:返回清单
  if (!q.id) {
    res.status(200).json({ ok: true, manifest: manifest || { updatedAt: 0, docs: [] } })
    return
  }

  // GET /api/docs?id=xxx:返回单个文档主体
  const id = String(q.id)
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: '非法的文档 id' })
    return
  }
  const docPath = `${PREFIX}doc_${id}.json`
  const doc = await readJson<{ meta: DocMeta; html: string }>(docPath)
  if (!doc) {
    res.status(404).json({ error: '文档不存在' })
    return
  }
  res.status(200).json({ ok: true, doc })
}

// ===== POST /api/docs:上传文档主体(JSON) =====

async function handleUploadDoc(req: VercelRequest, res: VercelResponse) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    res.status(413).json({ error: '文档主体超过 4MB 限制' })
    return
  }
  let parsed: { meta: DocMeta; html: string }
  try {
    parsed = JSON.parse(body)
  } catch {
    res.status(400).json({ error: '请求体不是合法 JSON' })
    return
  }
  if (!parsed.meta || typeof parsed.html !== 'string') {
    res.status(400).json({ error: '缺少 meta 或 html 字段' })
    return
  }
  const { meta, html } = parsed
  if (!/^[A-Za-z0-9_-]+$/.test(meta.id)) {
    res.status(400).json({ error: '非法的文档 id' })
    return
  }
  if (meta.ext !== 'docx' && meta.ext !== 'md') {
    res.status(400).json({ error: '非法的文档类型' })
    return
  }

  // 先读清单:读失败(非「不存在」)会上抛→500,避免写入主体后再用空清单回写导致列表丢失。
  const manifest = (await readJson<DocsManifest>(MANIFEST_PATH)) || { updatedAt: 0, docs: [] }

  // 写文档主体
  const docPath = `${PREFIX}doc_${meta.id}.json`
  await writeJson(docPath, JSON.stringify({ meta, html }))

  // 更新清单(last-write-wins;文档场景并发概率极低,无服务端乐观锁)
  const idx = manifest.docs.findIndex((d) => d.id === meta.id)
  if (idx >= 0) manifest.docs[idx] = meta
  else manifest.docs.unshift(meta)
  manifest.updatedAt = Date.now()
  await writeJson(MANIFEST_PATH, JSON.stringify(manifest))

  res.status(200).json({ ok: true, doc: meta })
}

// ===== POST /api/docs/img:上传图片(multipart) =====

async function handleUploadImage(req: VercelRequest, res: VercelResponse) {
  // Vercel 对 multipart 不会自动解析 req.body,需手动收集原始字节流
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const c = typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer)
    chunks.push(c)
    total += c.length
    if (total > MAX_IMAGE_BYTES + 1024) {
      res.status(413).json({ error: '图片超过 2MB 限制' })
      return
    }
  }
  const raw = Buffer.concat(chunks)

  const contentType = String(req.headers['content-type'] || '')
  const boundary = extractBoundary(contentType)
  if (!boundary) {
    res.status(400).json({ error: '缺少 multipart boundary' })
    return
  }

  const file = parseMultipartFile(raw, boundary)
  if (!file) {
    res.status(400).json({ error: '未找到 file 字段' })
    return
  }
  if (file.data.length > MAX_IMAGE_BYTES) {
    res.status(413).json({ error: '图片超过 2MB 限制' })
    return
  }

  const hash = await sha256Bytes(file.data)
  const ext = guessImgExt(file.filename, file.contentType)
  const imgPath = `${PREFIX}img/${hash}.${ext}`

  // 去重:已存在则直接返回现有 URL
  const existed = await get(imgPath, { access: 'public' }).catch(() => null)
  if (existed) {
    // 下载 URL 位于 result.blob.url,而非顶层 .url
    res.status(200).json({ ok: true, url: existed.blob.url, hash, existed: true })
    return
  }

  const result = await put(imgPath, file.data, {
    access: 'public',
    contentType: file.contentType || `image/${ext}`,
    addRandomSuffix: false,
    allowOverwrite: true,
  })
  res.status(200).json({ ok: true, url: result.url, hash, existed: false })
}

// ===== DELETE /api/docs?id=xxx:删除文档 =====

async function handleDelete(req: VercelRequest, res: VercelResponse) {
  const id = String(req.query?.id || '')
  if (!/^[A-Za-z0-9_-]+$/.test(id)) {
    res.status(400).json({ error: '非法的文档 id' })
    return
  }
  const docPath = `${PREFIX}doc_${id}.json`
  await del(docPath).catch(() => {})

  // 更新清单(不删图片,可能被其他文档引用)
  const manifest = (await readJson<DocsManifest>(MANIFEST_PATH)) || { updatedAt: 0, docs: [] }
  manifest.docs = manifest.docs.filter((d) => d.id !== id)
  manifest.updatedAt = Date.now()
  await writeJson(MANIFEST_PATH, JSON.stringify(manifest))
  res.status(200).json({ ok: true })
}

// ===== multipart 最小 parser(只提取 name="file" 的第一个字段) =====

function extractBoundary(contentType: string): string | null {
  const m = contentType.match(/boundary=(?:"([^"]+)"|([^;,\s]+))/i)
  return m?.[1] || m?.[2] || null
}

function parseMultipartFile(
  raw: Buffer,
  boundary: string,
): { data: Buffer; filename: string; contentType: string } | null {
  const sep = Buffer.from(`--${boundary}`)
  const parts = splitBuffer(raw, sep)
  for (const part of parts) {
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd < 0) continue
    const header = part.slice(0, headerEnd).toString('utf8')
    if (!/name="file"/i.test(header)) continue
    const body = part.subarray(headerEnd + 4)
    // 去掉尾部的 \r\n(Buffer 继承自 Uint8Array,无 String.endsWith,须按字节判断)
    const n = body.length
    const trimmed =
      n >= 2 && body[n - 2] === 0x0d && body[n - 1] === 0x0a ? body.subarray(0, n - 2) : body
    const fname = header.match(/filename="([^"]*)"/i)?.[1] || ''
    const ctype = header.match(/content-type:\s*([^\r\n]+)/i)?.[1].trim() || ''
    return { data: trimmed, filename: fname, contentType: ctype }
  }
  return null
}

function splitBuffer(buf: Buffer, sep: Buffer): Buffer[] {
  const result: Buffer[] = []
  let start = 0
  let idx = buf.indexOf(sep, start)
  while (idx >= 0) {
    result.push(buf.slice(start, idx))
    start = idx + sep.length
    idx = buf.indexOf(sep, start)
  }
  result.push(buf.slice(start))
  return result
}

function guessImgExt(filename: string, contentType: string): string {
  const ct = contentType.toLowerCase()
  if (ct.includes('png')) return 'png'
  if (ct.includes('jpeg') || ct.includes('jpg')) return 'jpg'
  if (ct.includes('gif')) return 'gif'
  if (ct.includes('webp')) return 'webp'
  if (ct.includes('svg')) return 'svg'
  const ext = filename.split('.').pop()?.toLowerCase()
  if (ext && ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext)) {
    return ext === 'jpeg' ? 'jpg' : ext
  }
  return 'png'
}
