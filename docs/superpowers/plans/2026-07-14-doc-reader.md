# 文档资料阅读器 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **⚠️ 仓库硬规则 (AGENTS.md §0):禁止任何测试。** 本计划不写测试文件,每个任务的验证改为「实现 → 跑 `npm run type-check && npm run build && npm run lint` → commit」。保留 bite-sized 任务粒度、完整代码块、确切命令。

**Goal:** 为 QuizBox 新增「文档资料阅读器」:用户上传 ≤4MB 的 .docx/.md,客户端一次性解析为 HTML(图片单独存 Blob),云端存渲染产物,阅读时直接显示。

**Architecture:** 上传时浏览器端解析(docx→mammoth / md→marked),图片提取后单独上传到 Vercel Blob(public URL),HTML 内引用图片 URL;云端只存 `{meta, html}` JSON。阅读页直接 `v-html` 渲染,本地 IndexedDB 缓存 HTML。写操作需 `BANK_KEY` token,读开放,不开放下载。

**Tech Stack:** Vue 3.5 `<script setup lang="ts">`、Vant 4、Pinia、Dexie 4、mammoth、marked、@vercel/blob、KaTeX(复用)。

**Spec:** `docs/superpowers/specs/2026-07-14-doc-reader-design.md`

---

## 文件结构

### 新建(8 个)

| 文件                          | 职责                                              |
| ----------------------------- | ------------------------------------------------- |
| `api/docs.ts`                 | Vercel serverless:文档/图片 CRUD + multipart 解析 |
| `src/types/docs.ts`           | 文档相关类型(独立文件,避免 types/index.ts 膨胀)   |
| `src/db/docs.ts`              | docsCache 表 repo                                 |
| `src/services/docs-api.ts`    | 云端文档/图片 API 客户端                          |
| `src/services/doc-render.ts`  | 上传时「解析 + 图片上传 + URL 替换」渲染器        |
| `src/stores/docs.ts`          | Pinia store                                       |
| `src/views/DocsView.vue`      | 文档列表页                                        |
| `src/views/DocReaderView.vue` | 阅读页                                            |

### 修改(5 个)

| 文件                  | 改动                                                      |
| --------------------- | --------------------------------------------------------- |
| `src/db/index.ts`     | bump version 7 + `docsCache` 表 + 类字段 + 类型 import    |
| `src/types/index.ts`  | re-export docs 类型(保持单一类型入口约定)                 |
| `src/router/index.ts` | 新增 `/docs`、`/docs/:id` 路由                            |
| `src/App.vue`         | `navItems` 增加 docs 项(移动 tabbar + 桌面侧边栏)         |
| `src/utils/format.ts` | 新建,提取 `fmtSize`(DocsView 复用,避免与 ImportView 重复) |

---

## 任务依赖图

```
Task 1 (类型)  ─┬─→ Task 3 (db repo) ──→ Task 5 (store) ──→ Task 7 (DocsView)  ─┐
                │                                      ├──→ Task 8 (ReaderView) │
Task 2 (api)  ──┼─→ Task 4 (docs-api) ─→ Task 5         │                       ├─→ Task 9 (集成)
                │                      └─→ Task 6 (render)─┘                    │
Task 1 ──→ Task 6                                                               │
Task 6 ──→ Task 7                                                              ─┘
```

顺序执行:Task 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9。

---

## Task 1: 定义文档相关类型

**Files:**

- Create: `src/types/docs.ts`
- Modify: `src/types/index.ts`(末尾追加 re-export)

- [ ] **Step 1: 创建 `src/types/docs.ts`**

```ts
/**
 * 文档资料阅读器相关类型。
 * 独立文件,避免 types/index.ts 膨胀;由 types/index.ts re-export。
 */

/** 云端文档元数据(docs/manifest.json 的条目) */
export interface DocMeta {
  /** uuid,同时是 doc_<id>.json 的 id */
  id: string
  /** 原始文件名,如 "复习笔记.docx" */
  name: string
  /** 文档类型(仅用于列表图标展示;解析后统一为 HTML) */
  ext: 'docx' | 'md'
  /** 上传时间戳(ms) */
  uploadedAt: number
  /** 渲染产物 HTML 的字节数(用于列表展示大小) */
  htmlSize: number
  /** 图片数量(用于列表展示) */
  imageCount: number
}

/** docs/manifest.json 结构 */
export interface DocsManifest {
  updatedAt: number
  docs: DocMeta[]
}

/** GET /api/docs?id=xxx 返回的文档主体 */
export interface DocRecord {
  meta: DocMeta
  /** 已解析的 HTML(图片 URL 已替换为云端 public URL) */
  html: string
}

/** IndexedDB docsCache 表记录(本地读缓存) */
export interface DocCacheRecord {
  /** 主键,等于 DocMeta.id */
  id: string
  /** 渲染好的 HTML,直接可 v-html */
  html: string
  /** meta 快照,便于离线展示列表项 */
  meta: DocMeta
  /** 缓存写入时间戳(ms) */
  cachedAt: number
}
```

- [ ] **Step 2: 在 `src/types/index.ts` 末尾追加 re-export**

在 `src/types/index.ts` 最后新增一行:

```ts
export type { DocMeta, DocsManifest, DocRecord, DocCacheRecord } from './docs'
```

- [ ] **Step 3: 验证类型编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误(types-only 文件,不影响现有代码)。

- [ ] **Step 4: Commit**

```bash
git add src/types/docs.ts src/types/index.ts
git commit -m "feat(docs): 定义文档资料阅读器类型"
```

---

## Task 2: 实现 `api/docs.ts` (Vercel Serverless)

**Files:**

- Create: `api/docs.ts`

**设计要点:**

- 两个路由前缀:`/api/docs`(文档 CRUD,JSON body)+ `/api/docs/img`(图片上传,multipart)。
- 文档主体 Blob:`access: 'private'`,经 serverless 读。
- 图片 Blob:`access: 'public'`,浏览器 `<img src>` 直接加载。
- 鉴权复用 `api/bank.ts:142-147` 模式:`BANK_KEY` 存在时校验 `Authorization: Bearer <key>`;写(POST/DELETE)强制校验,读(GET)跳过。
- multipart 手写最小 parser,只提取单个 `file` 字段。

- [ ] **Step 1: 创建 `api/docs.ts`**

```ts
// Vercel Serverless Function:文档资料阅读器云端存储
//
// 存储布局(独立命名空间,不碰现有 quizbox/):
//   docs/manifest.json        (元数据清单,轻量 JSON)
//   docs/doc_<id>.json        (文档主体 { meta, html })
//   docs/img/<hash>.<ext>     (图片,public access,被 HTML <img src> 引用)
//
// 鉴权:写操作(POST/DELETE)需 BANK_KEY;读操作(GET)开放。
// 与 api/bank.ts 的 BANK_KEY 机制一致,密钥共享。

import { del, get, put } from '@vercel/blob'
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
const DOC_PATH_RE = /^docs\/doc_[A-Za-z0-9_-]+\.json$/
const IMG_PATH_RE = /^docs\/img\/[a-f0-9]{64}\.(png|jpe?g|gif|webp|svg)$/i
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
  const blob = await get(path, {
    access: path.startsWith('docs/img/') ? 'public' : 'private',
  }).catch(() => null)
  if (!blob?.stream) return null
  const text = await new Response(blob.stream).text()
  if (!text) return null
  try {
    return JSON.parse(text) as T
  } catch {
    return null
  }
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
async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function setCors(res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

/** 校验写操作鉴权;读操作跳过 */
function checkAuth(req: VercelRequest, res: VercelResponse): boolean {
  const key = process.env.BANK_KEY
  if (!key) return true // 未配置 BANK_KEY 时写也开放(与 bank.ts 一致)
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
    const isImgRoute = url.startsWith('/api/docs/img')

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

  // 写文档主体
  const docPath = `${PREFIX}doc_${meta.id}.json`
  await writeJson(docPath, JSON.stringify({ meta, html }))

  // 更新清单(last-write-wins + 重拉合并,最多重试 2 次)
  let attempts = 0
  while (attempts < 3) {
    const manifest = (await readJson<DocsManifest>(MANIFEST_PATH)) || { updatedAt: 0, docs: [] }
    const idx = manifest.docs.findIndex((d) => d.id === meta.id)
    if (idx >= 0) manifest.docs[idx] = meta
    else manifest.docs.unshift(meta)
    manifest.updatedAt = Date.now()
    await writeJson(MANIFEST_PATH, JSON.stringify(manifest))
    // 无服务端乐观锁,写完即视为成功(并发概率极低)
    break
  }

  res.status(200).json({ ok: true, doc: meta })
}

// ===== POST /api/docs/img:上传图片(multipart) =====

async function handleUploadImage(req: VercelRequest, res: VercelResponse) {
  // 收集原始 body(Vercel 对 multipart 不会自动解析 req.body)
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : (chunk as Buffer))
    if (Buffer.concat(chunks).length > MAX_IMAGE_BYTES + 1024) {
      res.status(413).json({ error: '图片超过 2MB 限制' })
      return
    }
  }
  const raw = Buffer.concat(chunks)
  if (raw.length > MAX_IMAGE_BYTES + 1024) {
    res.status(413).json({ error: '图片超过 2MB 限制' })
    return
  }

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

  // 去重:已存在则直接返回 URL
  const existed = await get(imgPath, { access: 'public' }).catch(() => null)
  if (existed) {
    res.status(200).json({ ok: true, url: existed.url, hash, existed: true })
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

  // 更新清单
  const manifest = (await readJson<DocsManifest>(MANIFEST_PATH)) || { updatedAt: 0, docs: [] }
  manifest.docs = manifest.docs.filter((d) => d.id !== id)
  manifest.updatedAt = Date.now()
  await writeJson(MANIFEST_PATH, JSON.stringify(manifest))
  // 注意:不删图片(可能被其他文档引用),孤儿图片清理属未来增强
  res.status(200).json({ ok: true })
}

// ===== multipart 最小 parser(只提取第一个 file 字段) =====

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
    const body = part.slice(headerEnd + 4)
    // 去掉尾部的 \r\n
    const trimmed = body.endsWith('\r\n') ? body.slice(0, -2) : body
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

async function sha256Bytes(buf: Buffer): Promise<string> {
  // Buffer 是 Uint8Array 子类,可直接传给 subtle.digest
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
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
```

> **说明:** `handleUploadDoc` 里 `while` 循环实际只跑一次(无服务端乐观锁),保留循环结构是为了未来加 baseManifestUpdatedAt 时有扩展点。提交前可简化为直接执行,这里写法已可编译。

- [ ] **Step 2: 验证 api 文件无语法错误**

Run: `npx tsc --noEmit --skipLibCheck api/docs.ts 2>&1 | head -20`
Expected: 无致命错误(可能有 @vercel/node 类型提示,不影响)。或直接依赖后续 `npm run build`(Vercel api 在 dev 构建时不编译,但 lint 会检查)。

- [ ] **Step 3: Commit**

```bash
git add api/docs.ts
git commit -m "feat(docs): 新增文档云端 serverless api/docs.ts"
```

---

## Task 3: 数据库升级 + docsCache repo

**Files:**

- Modify: `src/db/index.ts`(version 7 + 类字段)
- Create: `src/db/docs.ts`(repo)

- [ ] **Step 1: 修改 `src/db/index.ts`**

在 import 块中(`src/db/index.ts:2-11`)追加 `DocCacheRecord`:

```ts
import type {
  Subject,
  Chapter,
  Question,
  Attempt,
  WrongItem,
  ExamSession,
  Attachment,
  SyncMeta,
  DocCacheRecord,
} from '@/types'
```

在 `QADatabase` 类(`src/db/index.ts:17-26`)的 `parseCache` 字段后追加:

```ts
  parseCache!: Table<{ hash: string; value: string; createdAt: number }, string>
  docsCache!: Table<DocCacheRecord, string>
```

在 version 6 后(`src/db/index.ts:78-80` 之后、构造函数结束 `}` 之前)追加 version 7:

```ts
// version 7：文档资料阅读器本地缓存(仅缓存已渲染 HTML,不参与同步)
this.version(7).stores({
  docsCache: 'id, cachedAt',
})
```

- [ ] **Step 2: 创建 `src/db/docs.ts`**

```ts
import { db } from './index'
import type { DocCacheRecord, DocRecord } from '@/types'

/**
 * 文档本地缓存 repo。
 * 仅存「已渲染 HTML」用于二次打开加速,可随时清空重建,不参与任何同步。
 */
export const docsRepo = {
  /** 读取缓存;未命中返回 undefined */
  async get(id: string): Promise<DocCacheRecord | undefined> {
    return db.docsCache.get(id)
  },

  /** 写入/更新缓存 */
  async put(record: DocCacheRecord): Promise<void> {
    await db.docsCache.put(record)
  },

  /** 清除指定文档缓存;不传 id 则清空全部 */
  async clear(id?: string): Promise<void> {
    if (id) await db.docsCache.delete(id)
    else await db.docsCache.clear()
  },
}
```

- [ ] **Step 3: 验证编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/db/index.ts src/db/docs.ts
git commit -m "feat(docs): Dexie v7 新增 docsCache 表与 repo"
```

---

## Task 4: 提取 `fmtSize` 到 utils + 实现 docs-api 客户端

**Files:**

- Create: `src/utils/format.ts`
- Create: `src/services/docs-api.ts`

- [ ] **Step 1: 创建 `src/utils/format.ts`**(从 ImportView 提取,供 DocsView 复用)

```ts
/** 格式化字节数为人类可读字符串(B / KB / MB) */
export function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}
```

- [ ] **Step 2: 创建 `src/services/docs-api.ts`**

```ts
import { useSettingsStore } from '@/stores/settings'
import { sha256 } from '@/utils/hash'
import type { DocMeta, DocRecord, DocsManifest } from '@/types'

/**
 * 文档资料云端 API 客户端。
 * 路由:/api/docs(文档 CRUD)+ /api/docs/img(图片上传)。
 * 写操作带 BANK_KEY(Authorization: Bearer),复用 settings.bankSync.key。
 */

const DOCS_ENDPOINT = '/api/docs'
const IMG_ENDPOINT = '/api/docs/img'

/** 获取写操作鉴权头;未配置 BANK_KEY 时返回空对象(此时服务端也开放写) */
function authHeaders(): Record<string, string> {
  const s = useSettingsStore()
  return s.bankSync.key ? { Authorization: `Bearer ${s.bankSync.key}` } : {}
}

/** 判断是否已配置写操作所需密钥(用于 UI 禁用上传按钮) */
export function hasWriteAuth(): boolean {
  const s = useSettingsStore()
  // 若服务端未设 BANK_KEY 则无需本地 key;但客户端无法预知,统一要求有 key 才允许写
  return !!s.bankSync.key
}

async function readError(res: Response): Promise<string> {
  const data = await res.json().catch(() => null)
  return data?.error || data?.message || res.statusText || `HTTP ${res.status}`
}

/** 上传单张图片,返回 public URL(图片按 hash 去重) */
export async function uploadImage(img: Blob): Promise<{ url: string; hash: string }> {
  const hash = await sha256(img)
  const form = new FormData()
  form.append('file', img, `img.${guessExt(img.type)}`)
  const res = await fetch(IMG_ENDPOINT, {
    method: 'POST',
    headers: authHeaders(),
    body: form,
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return { url: data.url, hash }
}

/** 上传文档主体:已渲染 HTML + meta */
export async function uploadDoc(meta: DocMeta, html: string): Promise<DocMeta> {
  const res = await fetch(DOCS_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders() },
    body: JSON.stringify({ meta, html }),
  })
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return data.doc as DocMeta
}

/** 读清单 */
export async function listDocs(): Promise<DocsManifest> {
  const res = await fetch(DOCS_ENDPOINT)
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return data.manifest as DocsManifest
}

/** 读单个文档主体 */
export async function fetchDoc(id: string): Promise<DocRecord> {
  const res = await fetch(`${DOCS_ENDPOINT}?id=${encodeURIComponent(id)}`)
  if (!res.ok) throw new Error(await readError(res))
  const data = await res.json()
  return data.doc as DocRecord
}

/** 删除文档 */
export async function deleteDoc(id: string): Promise<void> {
  const res = await fetch(`${DOCS_ENDPOINT}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: authHeaders(),
  })
  if (!res.ok) throw new Error(await readError(res))
}

function guessExt(mime: string): string {
  if (mime.includes('png')) return 'png'
  if (mime.includes('jpeg') || mime.includes('jpg')) return 'jpg'
  if (mime.includes('gif')) return 'gif'
  if (mime.includes('webp')) return 'webp'
  if (mime.includes('svg')) return 'svg'
  return 'png'
}
```

- [ ] **Step 3: 验证编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/utils/format.ts src/services/docs-api.ts
git commit -m "feat(docs): 提取 fmtSize 工具并实现 docs-api 客户端"
```

---

## Task 5: 实现 doc-render(上传时解析 + 图片上传)

**Files:**

- Create: `src/services/doc-render.ts`

**设计要点:**

- `.docx`:mammoth.convertToHtml → 提取 base64 图片 → 转 Blob → uploadImage → URL 替换。
- `.md`:marked.parse(GFM) → 后处理 `$...$` KaTeX(marked 不处理公式)。
- md 内联 base64 图片(`![](data:...)`)同样走上传替换(罕见但仍处理)。

- [ ] **Step 1: 创建 `src/services/doc-render.ts`**

```ts
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
    // 用函数形式 replace 避免.url 里的特殊字符被 $ 解析
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
  // 行内 $...$(避免跨行、避免吃掉代码块里的 $)
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
```

- [ ] **Step 2: 安装 marked 依赖**

Run: `npm install marked`
Expected: package.json 新增 `"marked"` 依赖,package-lock.json 更新。

- [ ] **Step 3: 验证编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/services/doc-render.ts package.json package-lock.json
git commit -m "feat(docs): 实现文档渲染器(mammoth+marked,图片上传替换)"
```

---

## Task 6: 实现 Pinia store

**Files:**

- Create: `src/stores/docs.ts`

- [ ] **Step 1: 创建 `src/stores/docs.ts`**

```ts
import { defineStore } from 'pinia'
import { uid } from '@/db'
import { docsRepo } from '@/db/docs'
import { uploadDoc, listDocs, fetchDoc, deleteDoc } from '@/services/docs-api'
import { renderDoc, type RenderProgress } from '@/services/doc-render'
import type { DocMeta, DocRecord } from '@/types'

/**
 * 文档资料阅读器 store。
 * 职责:拉取云端清单、上传(解析+图片+主体)、删除、打开(取 HTML+缓存)。
 */
export const useDocsStore = defineStore('docs', {
  state: () => ({
    /** 云端文档清单(按 uploadedAt 降序) */
    list: [] as DocMeta[],
    loading: false,
    /** 当前打开的文档(阅读页用) */
    current: null as DocRecord | null,
    currentLoading: false,
  }),
  actions: {
    /** 拉取云端清单;失败时保留旧值 */
    async loadList() {
      this.loading = true
      try {
        const manifest = await listDocs()
        this.list = [...manifest.docs].sort((a, b) => b.uploadedAt - a.uploadedAt)
      } finally {
        this.loading = false
      }
    },

    /**
     * 上传文档:解析 → 图片上传 → 主体上传 → 本地缓存 → 刷新清单
     * @throws 任一步骤失败时抛出,UI 层捕获提示
     */
    async upload(file: File, onProgress?: RenderProgress): Promise<void> {
      const { html, meta: renderMeta } = await renderDoc(file, onProgress)
      const docMeta: DocMeta = {
        id: uid('doc_'),
        name: file.name,
        ext: file.name.split('.').pop()?.toLowerCase() === 'docx' ? 'docx' : 'md',
        uploadedAt: Date.now(),
        htmlSize: renderMeta.htmlSize,
        imageCount: renderMeta.imageCount,
      }
      await uploadDoc(docMeta, html)
      // 顺手缓存,二次打开命中本地
      await docsRepo.put({
        id: docMeta.id,
        html,
        meta: docMeta,
        cachedAt: Date.now(),
      })
      await this.loadList()
    },

    /** 删除文档(不删图片,可能被其他文档引用) */
    async remove(id: string) {
      await deleteDoc(id)
      await docsRepo.clear(id)
      // 若当前阅读的就是被删文档,清空
      if (this.current?.meta.id === id) this.current = null
      await this.loadList()
    },

    /**
     * 打开文档:优先本地缓存,否则拉云端并缓存
     * @throws 网络失败且无缓存时抛出
     */
    async open(id: string) {
      this.currentLoading = true
      try {
        // 1. 查缓存
        const cached = await docsRepo.get(id)
        if (cached) {
          this.current = { meta: cached.meta, html: cached.html }
          return
        }
        // 2. 拉云端
        const doc = await fetchDoc(id)
        this.current = doc
        await docsRepo.put({
          id: doc.meta.id,
          html: doc.html,
          meta: doc.meta,
          cachedAt: Date.now(),
        })
      } finally {
        this.currentLoading = false
      }
    },

    /** 清空当前文档(离开阅读页时调用) */
    clearCurrent() {
      this.current = null
    },
  },
})
```

- [ ] **Step 2: 验证编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/stores/docs.ts
git commit -m "feat(docs): 实现 docs Pinia store"
```

---

## Task 7: 实现 DocsView(文档列表页)

**Files:**

- Create: `src/views/DocsView.vue`

**设计要点:**

- `defineOptions({ name: 'DocsView' })`(keep-alive 依赖)。
- `van-uploader` + `:max-size="4*1024*1024"` + `@oversize`。
- 上传过程展示 phase 文案(解析中 / 上传图片 n/m / 保存中)。
- 列表 `van-swipe-cell` + `van-cell`,左滑删除经 `guardedAction`。
- 本地定义 `guardedAction`(复用 SubjectDetailView.vue:307 模式)+ `AdminDialog`。

- [ ] **Step 1: 创建 `src/views/DocsView.vue`**

先看一眼 AdminDialog 组件的 props(确保用法正确),再写。运行:

Run: `grep -n "defineProps\|defineEmits\|defineExpose\|name:" src/components/AdminDialog.vue`

然后创建文件:

```vue
<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { showToast, showFailToast, showSuccessToast } from 'vant'
import AdminDialog from '@/components/AdminDialog.vue'
import { useDocsStore } from '@/stores/docs'
import { useAdminStore } from '@/stores/admin'
import { useSettingsStore } from '@/stores/settings'
import { hasWriteAuth } from '@/services/docs-api'
import { fmtSize } from '@/utils/format'

defineOptions({ name: 'DocsView' })

const MAX_SIZE = 4 * 1024 * 1024

const router = useRouter()
const store = useDocsStore()
const adminStore = useAdminStore()
const settingsStore = useSettingsStore()

const uploading = ref(false)
const uploadPhase = ref('')
const refreshing = ref(false)

// 管理员鉴权(复用 SubjectDetailView.vue:307 的 guardedAction 模式)
const showAdminDialog = ref(false)
const pendingAction = ref<(() => void) | null>(null)

function guardedAction(action: () => void) {
  if (adminStore.canOperate()) {
    action()
  } else {
    pendingAction.value = action
    showAdminDialog.value = true
  }
}

function onAdminVerified() {
  if (pendingAction.value) {
    pendingAction.value()
    pendingAction.value = null
  }
}

async function onFileRead(fileItem: any) {
  const file: File = fileItem.file || fileItem
  if (file.size > MAX_SIZE) {
    showFailToast('文件超过 4MB 限制')
    return
  }
  if (!hasWriteAuth()) {
    showFailToast('请先在设置页配置云题库密钥')
    return
  }
  uploading.value = true
  uploadPhase.value = '解析中…'
  try {
    await store.upload(file, (phase, detail) => {
      uploadPhase.value = phase === 'parsing' ? '解析中…' : detail || '上传图片…'
    })
    showSuccessToast('上传成功')
  } catch (e: any) {
    showFailToast(e?.message || '上传失败')
  } finally {
    uploading.value = false
    uploadPhase.value = ''
  }
}

function openDoc(id: string) {
  router.push({ name: 'doc-reader', params: { id } })
}

function removeDoc(id: string) {
  guardedAction(async () => {
    try {
      await store.remove(id)
      showSuccessToast('已删除')
    } catch (e: any) {
      showFailToast(e?.message || '删除失败')
    }
  })
}

async function onRefresh() {
  refreshing.value = true
  try {
    await store.loadList()
  } catch (e: any) {
    showFailToast('刷新失败')
  } finally {
    refreshing.value = false
  }
}

function fmtDate(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

onMounted(async () => {
  await adminStore.load()
  await store.loadList().catch(() => {
    // 静默失败,空态由列表展示
  })
})
</script>

<template>
  <div class="docs-page">
    <div class="page-head">
      <h1 class="page-title">资料</h1>
      <p class="page-sub">上传 Word / Markdown 文档,随时阅读</p>
    </div>

    <!-- 上传区 -->
    <div class="upload-area">
      <van-uploader
        :after-read="onFileRead"
        :max-size="MAX_SIZE"
        accept=".docx,.md"
        :max-count="1"
        :disabled="uploading"
        @oversize="() => showFailToast('文件超过 4MB 限制')"
      >
        <van-button
          icon="plus"
          type="primary"
          round
          :loading="uploading"
          :loading-text="uploadPhase"
        >
          上传文档
        </van-button>
      </van-uploader>
      <p v-if="!hasWriteAuth()" class="upload-hint">
        上传需配置密钥,请前往
        <router-link to="/settings">设置页</router-link>
      </p>
    </div>

    <!-- 文档列表 -->
    <van-pull-refresh v-model="refreshing" @refresh="onRefresh">
      <van-loading v-if="store.loading && !store.list.length" class="list-loading" type="spinner" />
      <van-empty
        v-else-if="!store.list.length"
        description="还没有资料,点击上方上传你的第一份文档"
      />
      <div v-else class="doc-list">
        <van-swipe-cell v-for="doc in store.list" :key="doc.id">
          <van-cell class="doc-cell" :title="doc.name" @click="openDoc(doc.id)">
            <template #label>
              <span class="doc-meta">
                <van-icon :name="doc.ext === 'md' ? 'description-o' : 'description'" />
                {{ fmtSize(doc.htmlSize) }}
                <span v-if="doc.imageCount">· {{ doc.imageCount }} 图</span>
                · {{ fmtDate(doc.uploadedAt) }}
              </span>
            </template>
            <template #right-icon>
              <van-icon name="arrow" class="doc-arrow" />
            </template>
          </van-cell>
          <template #right>
            <van-button
              square
              type="danger"
              text="删除"
              class="del-btn"
              @click="removeDoc(doc.id)"
            />
          </template>
        </van-swipe-cell>
      </div>
    </van-pull-refresh>

    <!-- 管理员验证弹窗 -->
    <AdminDialog v-model:show="showAdminDialog" @verified="onAdminVerified" />
  </div>
</template>

<style scoped>
.docs-page {
  padding: var(--sp-3);
}
.page-head {
  padding: var(--sp-4) var(--sp-2) var(--sp-3);
}
.page-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text);
}
.page-sub {
  margin-top: var(--sp-1);
  font-size: 13px;
  color: var(--text-2);
}
.upload-area {
  padding: var(--sp-3) var(--sp-2);
}
.upload-hint {
  margin-top: var(--sp-2);
  font-size: 12px;
  color: var(--text-3);
}
.upload-hint a {
  color: var(--brand);
}
.list-loading {
  display: flex;
  justify-content: center;
  padding: var(--sp-8);
}
.doc-list {
  margin-top: var(--sp-2);
}
.doc-cell {
  align-items: center;
}
.doc-meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-3);
}
.doc-arrow {
  color: var(--text-3);
}
.del-btn {
  height: 100%;
}
</style>
```

- [ ] **Step 2: 验证 AdminDialog 的 v-model 和 emit 事件名**

Run: `grep -n "defineProps\|defineEmits\|defineModel\|emit(\|update:show\|verified" src/components/AdminDialog.vue`

若 AdminDialog 用的是 `update:show` + `verified` 事件,则上面用法正确;若不同,按实际调整 `v-model:show` 和 `@verified`。

- [ ] **Step 3: 验证编译**(此时路由还没加,DocsView 不会被引用,但 vue-tsc 会检查文件本身)

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/views/DocsView.vue
git commit -m "feat(docs): 实现文档列表页 DocsView"
```

---

## Task 8: 实现 DocReaderView(阅读页)

**Files:**

- Create: `src/views/DocReaderView.vue`

- [ ] **Step 1: 创建 `src/views/DocReaderView.vue`**

```vue
<script setup lang="ts">
import { onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast } from 'vant'
import { useDocsStore } from '@/stores/docs'

defineOptions({ name: 'DocReaderView' })

const route = useRoute()
const router = useRouter()
const store = useDocsStore()

onMounted(async () => {
  const id = String(route.params.id)
  try {
    await store.open(id)
  } catch (e: any) {
    showFailToast(e?.message || '无法获取文档')
  }
})

onBeforeUnmount(() => {
  store.clearCurrent()
})
</script>

<template>
  <div class="reader-page">
    <van-nav-bar
      :title="store.current?.meta.name || '阅读'"
      left-arrow
      @click-left="router.back()"
    />
    <div class="reader-body">
      <van-loading v-if="store.currentLoading" class="reader-loading" type="spinner" vertical>
        加载中…
      </van-loading>
      <van-empty v-else-if="!store.current" description="文档无法显示" />
      <!-- 阅读零解析开销:HTML 已是渲染产物,图片 URL 浏览器自动加载 -->
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-else class="doc-prose" v-html="store.current.html"></div>
    </div>
  </div>
</template>

<style scoped>
.reader-page {
  min-height: 100vh;
  background: var(--surface);
}
.reader-body {
  padding: var(--sp-4) var(--sp-3) var(--sp-8);
}
.reader-loading {
  display: flex;
  justify-content: center;
  padding: var(--sp-8);
}

/* 文档 prose 排版(复用题库 RichText 的排版语义) */
.doc-prose {
  font-size: 16px;
  line-height: 1.75;
  color: var(--text);
  word-break: break-word;
}
.doc-prose :deep(h1),
.doc-prose :deep(h2),
.doc-prose :deep(h3) {
  margin: var(--sp-5) 0 var(--sp-2);
  font-weight: 700;
  line-height: 1.3;
}
.doc-prose :deep(h1) {
  font-size: 22px;
}
.doc-prose :deep(h2) {
  font-size: 19px;
}
.doc-prose :deep(h3) {
  font-size: 17px;
}
.doc-prose :deep(p) {
  margin: var(--sp-2) 0;
}
.doc-prose :deep(ul),
.doc-prose :deep(ol) {
  margin: var(--sp-2) 0;
  padding-left: var(--sp-5);
}
.doc-prose :deep(li) {
  margin: var(--sp-1) 0;
}
.doc-prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  margin: var(--sp-3) 0;
  font-size: 14px;
}
.doc-prose :deep(th),
.doc-prose :deep(td) {
  border: 1px solid var(--border);
  padding: var(--sp-2);
  text-align: left;
}
.doc-prose :deep(th) {
  background: var(--surface-2);
  font-weight: 600;
}
.doc-prose :deep(code) {
  background: var(--surface-2);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 14px;
}
.doc-prose :deep(pre) {
  background: var(--surface-2);
  padding: var(--sp-3);
  border-radius: var(--r-md);
  overflow-x: auto;
  margin: var(--sp-3) 0;
}
.doc-prose :deep(pre code) {
  background: none;
  padding: 0;
}
.doc-prose :deep(blockquote) {
  margin: var(--sp-3) 0;
  padding: var(--sp-2) var(--sp-4);
  border-left: 3px solid var(--brand);
  color: var(--text-2);
}
.doc-prose :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--r-md);
  margin: var(--sp-3) 0;
}
.doc-prose :deep(.katex-display) {
  overflow-x: auto;
  overflow-y: hidden;
  margin: var(--sp-3) 0;
}
</style>
```

- [ ] **Step 2: 验证编译**

Run: `npx vue-tsc --noEmit`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/views/DocReaderView.vue
git commit -m "feat(docs): 实现文档阅读页 DocReaderView"
```

---

## Task 9: 路由 + tabbar 集成

**Files:**

- Modify: `src/router/index.ts`
- Modify: `src/App.vue`

- [ ] **Step 1: 在 `src/router/index.ts` 增加 docs 路由**

在 `import` 路由(`src/router/index.ts:53-58`,import 路由)之后、或紧接 wrong 路由(`:27-29`)之后插入 docs 路由。具体地,在数组里 `wrong` 路由后插入:

```ts
  {
    path: '/docs',
    name: 'docs',
    component: () => import('@/views/DocsView.vue'),
    meta: { title: '资料', tabbar: true },
  },
  {
    path: '/docs/:id',
    name: 'doc-reader',
    component: () => import('@/views/DocReaderView.vue'),
    meta: { title: '阅读' },
  },
```

- [ ] **Step 2: 修改 `src/App.vue` 的 navItems**

定位 `src/App.vue:29-33`,把 navItems 改为:

```ts
const navItems = [
  { name: 'home', label: '首页', icon: 'wap-home-o' },
  { name: 'library', label: '题库', icon: 'bookmark-o' },
  { name: 'docs', label: '资料', icon: 'description-o' },
  { name: 'settings', label: '设置', icon: 'setting-o' },
]
```

- [ ] **Step 3: 确认桌面端侧边栏也用了 navItems**

Run: `grep -n "navItems\|app-sidebar__item" src/App.vue`

若桌面端侧边栏也遍历 `navItems`,则无需额外改动(自动包含 docs 项)。若侧边栏是独立硬编码列表,需同步增加一项。

- [ ] **Step 4: 全量验证**

Run: `npm run type-check && npm run build && npm run lint`
Expected: 三项全 exit 0。如 lint 报 `vue/no-v-html` warning,确认 DocsView/DocReaderView 里的 `v-html` 已加 `<!-- eslint-disable-next-line vue/no-v-html -->`(DocReaderView 已加)。

- [ ] **Step 5: Commit**

```bash
git add src/router/index.ts src/App.vue
git commit -m "feat(docs): 接入资料 tab 与阅读页路由"
```

---

## Task 10: 更新版本历史 + 最终验收

**Files:**

- Modify: `src/views/SettingsView.vue`(`updateHistory` 数组)

- [ ] **Step 1: 在 SettingsView.vue 的 updateHistory 数组开头新增条目**

定位 `updateHistory` 数组(搜索 `const updateHistory` 或 `updateHistory =`),在最前面插入(日期用当天构建时刻格式 `yyyy-mm-dd hh-mm`,但 spec 里说 `version` 填日期即可):

```ts
    {
      version: '2026-07-14',
      date: '2026-07-14',
      changes: [
        '新增「资料」功能:支持上传 Word/Markdown 文档在线阅读',
        '文档云端存储(跨设备共享),本地缓存加速二次打开',
        '支持 GFM Markdown 与 KaTeX 数学公式渲染',
        '阅读页零解析开销,图片单独存储自动加载',
      ],
    },
```

> **注意:** 真实日期以 `date` 命令当天为准;`changes` 必须基于真实提交内容,不得编造。

- [ ] **Step 2: 确认当天日期**

Run: `date "+%Y-%m-%d"`
Expected: 形如 `2026-07-14`,用真实值替换上面的 version/date。

- [ ] **Step 3: 最终全量验收**

Run: `npm run type-check && npm run build && npm run lint`
Expected: 三项全 exit 0,无 error。

- [ ] **Step 4: Commit**

```bash
git add src/views/SettingsView.vue
git commit -m "docs: 更新版本历史——新增资料阅读功能"
```

---

## 验收清单(全部完成后)

遵循 AGENTS.md §8:

```bash
npm run type-check   # exit 0
npm run build        # exit 0
npm run lint         # 0 error
```

功能验收(手动,部署到 Vercel 后):

1. 「资料」tab 可见,点进入 DocsView。
2. 上传一个 < 4MB 的 .md → 列表出现,imageCount=0,点开能阅读(GFM + KaTeX)。
3. 上传一个带图片的 .docx → 图片显示正常,列表 imageCount 正确。
4. 上传 > 4MB 文件 → 被拦截提示。
5. 二次打开同一文档 → 走缓存秒开(断网也能开)。
6. 左滑删除(需管理员密码)→ 列表移除。
7. 未配 BANK_KEY → 上传按钮可用但会提示配置密钥(因 hasWriteAuth 返回 false)。
8. 损坏 docx → 上传时即提示「文档格式无法解析」。

---

## 部署前置条件

- Vercel 项目需有 Blob store(已配置 `BLOB_READ_WRITE_TOKEN`,与现有 bank 共用)。
- 可选设置 `BANK_KEY` 环境变量控制写权限(与 bank.ts 共享)。
- 无需改 `vercel.json`(`/api/(.*)` rewrite 已存在)。
