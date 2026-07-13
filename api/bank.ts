// Vercel Serverless Function：云端题库存储（跨设备共享）
//
// v2：按科目分片 + 哈希增量同步。
//   quizbox/manifest.json           (~1 KB, 索引)
//   quizbox/meta.json               (~0.5 KB, subjects + chapters)
//   quizbox/shard_sub_<subjectId>_<index>.json  (<250 KB, 题目分片)
//
// 部署前需在 Vercel 项目里创建一个 Blob store（Storage → Blob → Create），
// 它会自动注入 BLOB_READ_WRITE_TOKEN 环境变量。
// 可选设置 BANK_KEY 作为共享密钥；未设置时同源网页可直接同步当前项目的 Blob。

import { del, get, put } from '@vercel/blob'
import type { IncomingMessage, ServerResponse } from 'http'

interface VercelRequest extends IncomingMessage {
  query: Record<string, string | string[] | undefined>
  body: any
}

interface VercelResponse extends ServerResponse {
  status: (code: number) => VercelResponse
  json: (data: any) => void
  send: (data: any) => void
}

export const config = { runtime: 'nodejs' }

const PREFIX = 'quizbox/'
const MANIFEST_PATH = `${PREFIX}manifest.json`
const META_PATH = `${PREFIX}meta.json`
const SHARD_PATH_RE = /^quizbox\/shard_sub_[A-Za-z0-9_-]+_\d+\.json$/
const SUBJECT_ID_RE = /^[A-Za-z0-9_-]+$/
const MAX_REQUEST_BYTES = 4 * 1024 * 1024
const MAX_SHARD_BYTES = 250 * 1024

const BLOB_OPTS = {
  access: 'private' as const,
  contentType: 'application/json',
  addRandomSuffix: false,
  // @vercel/blob 2.x 起 put() 默认禁止覆盖已存在的 blob；本服务始终写固定路径
  // （manifest/meta/分片），必须显式允许覆盖，否则每次推送都 500「blob already exists」。
  allowOverwrite: true,
}

// ===== 通用 Blob 读写 =====

async function readJson<T = any>(path: string): Promise<T | null> {
  const blob = await get(path, { access: 'private' }).catch(() => null)
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
  await put(path, body, BLOB_OPTS)
}

// SHA-256（Node Web Crypto，Vercel Node runtime 支持）
async function sha256(text: string): Promise<string> {
  const buf = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', buf)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ===== Manifest / Shards =====

interface ShardEntry {
  path: string
  subjectId: string
  index: number
  hash: string
  size: number
  count: number
  updatedAt: number
}

interface BankManifest {
  version: 2
  updatedAt: number
  meta: { path: string; hash: string; size: number }
  shards: ShardEntry[]
}

interface MetaShard {
  subjects: Record<string, any>
  chapters: Record<string, any>
  adminPwdHash?: string
  forceSyncToken?: string
}

interface QuestionShard {
  subjectId: string
  index: number
  questions: Record<string, any>
}

/** 读取远端 manifest，若不存在返回 null */
async function readManifest(): Promise<BankManifest | null> {
  return await readJson<BankManifest>(MANIFEST_PATH)
}

async function writeManifest(m: BankManifest) {
  await writeJson(MANIFEST_PATH, JSON.stringify(m))
}

async function blobMeta(manifest: BankManifest | null) {
  const meta = manifest ? await readJson<MetaShard>(META_PATH) : null
  return {
    exists: !!manifest,
    pathname: MANIFEST_PATH,
    size: manifest ? JSON.stringify(manifest).length : 0,
    uploadedAt: new Date().toISOString(),
    tableCounts: {
      subjects: Object.keys(meta?.subjects || {}).length,
      chapters: Object.keys(meta?.chapters || {}).length,
      questions: manifest?.shards.reduce((sum, shard) => sum + shard.count, 0) || 0,
    },
  }
}

function setCors(res: VercelResponse) {
  // Web/PWA 与 API 同源部署在 Vercel，不开放跨域调用。
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  setCors(res)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  // 同源 Vercel Web/PWA 默认可直接同步；配置 BANK_KEY 后再额外校验共享密钥。
  const key = process.env.BANK_KEY
  const auth = String(req.headers['authorization'] || '')
  if (key && auth !== `Bearer ${key}`) {
    res.status(401).json({ error: '未授权：密钥不匹配' })
    return
  }

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res)
    }
    if (req.method === 'PUT') {
      return await handlePut(req, res)
    }
    res.status(405).json({ error: 'method not allowed' })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '云端题库存储错误' })
  }
}

// ===== GET =====

async function handleGet(req: VercelRequest, res: VercelResponse) {
  const q = req.query || {}
  const manifest = await readManifest()

  // ?manifest=1：只返回索引（~1 KB），增量同步核心入口
  if (q.manifest === '1') {
    res.status(200).json({ ok: true, manifest: manifest || null })
    return
  }

  // ?shard=path：返回指定分片内容
  if (typeof q.shard === 'string') {
    const shardPath = q.shard
    // 安全校验：只允许读取 quizbox/shard_* 题目分片，或 meta.json
    // （meta 含 subjects/chapters/admin 密码哈希，是同步必需的元数据分片）
    if (!SHARD_PATH_RE.test(shardPath) && shardPath !== META_PATH) {
      res.status(400).json({ error: '非法的分片路径' })
      return
    }
    const shard = await readJson(shardPath)
    if (!shard) {
      res.status(404).json({ error: '分片不存在' })
      return
    }
    res.status(200).json(shard)
    return
  }

  // ?meta=1：设置页连通性与题量统计
  if (q.meta === '1') {
    res.status(200).json({ ok: true, ...(await blobMeta(manifest)) })
    return
  }

  res.status(400).json({ error: '缺少 manifest、shard 或 meta 查询参数' })
}

// ===== PUT =====

interface BankPutRequest {
  /** 客户端版本标识，2 = 分片增量 */
  version?: number
  /** 客户端基于的远端 manifest.updatedAt，用于乐观并发控制 */
  baseManifestUpdatedAt?: number
  /** 需要更新的 meta（可选，无变化则不传） */
  meta?: MetaShard
  /** 需要更新的分片（仅传变化的） */
  shards?: Array<{ path: string; content: QuestionShard }>
  /** 需要删除的分片路径（科目被删除时） */
  deletePaths?: string[]
}

async function handlePut(req: VercelRequest, res: VercelResponse) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
  if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
    res.status(413).json({ error: '请求体超过 4MB 限制' })
    return
  }
  let parsed: BankPutRequest
  try {
    parsed = JSON.parse(body)
  } catch {
    res.status(400).json({ error: '请求体不是合法 JSON' })
    return
  }

  if (parsed.version !== 2) {
    res.status(400).json({ error: '仅支持 version=2 的 Vercel 分片同步协议' })
    return
  }

  if (parsed.meta && (!isRecord(parsed.meta.subjects) || !isRecord(parsed.meta.chapters))) {
    res.status(400).json({ error: 'meta 结构不合法' })
    return
  }
  for (const shard of parsed.shards || []) {
    const expectedPath = `quizbox/shard_sub_${shard.content?.subjectId}_${shard.content?.index}.json`
    const shardBody = JSON.stringify(shard.content)
    if (
      !SHARD_PATH_RE.test(shard.path) ||
      !SUBJECT_ID_RE.test(shard.content?.subjectId || '') ||
      !Number.isInteger(shard.content?.index) ||
      shard.content.index < 0 ||
      shard.path !== expectedPath ||
      !isRecord(shard.content?.questions)
    ) {
      res.status(400).json({ error: `分片结构或路径不合法：${shard.path}` })
      return
    }
    if (Buffer.byteLength(shardBody) > MAX_SHARD_BYTES) {
      res.status(413).json({ error: `分片超过 250KB：${shard.path}` })
      return
    }
  }

  // ===== v2 增量推送 =====
  // 乐观并发控制：由于 Vercel Blob 当前不支持内置事务锁，此处 handlePut 在 readManifest() 后进行比对，
  // 并在 hasChanges 时 writeManifest()，属于典型的 Read-Check-Write 乐观锁实现，在高并发时存在写覆盖的竞态漏洞。
  // 在当前应用场景中，因多端并发 PUT 概率极低且客户端有 last-write-wins 自主合并，此限制在设计上是可接受的。
  let manifest = await readManifest()

  if (typeof parsed.baseManifestUpdatedAt !== 'number') {
    res.status(400).json({ error: '缺少 baseManifestUpdatedAt' })
    return
  }

  // 乐观并发控制：baseManifestUpdatedAt 不匹配 → 409，要求客户端重拉合并
  if (
    manifest &&
    typeof parsed.baseManifestUpdatedAt === 'number' &&
    parsed.baseManifestUpdatedAt !== manifest.updatedAt
  ) {
    res.status(409).json({
      error: '远端 manifest 已被其他设备更新，请重新拉取合并',
      manifest,
    })
    return
  }

  // 首次推送或不存在 manifest：初始化空结构
  if (!manifest) {
    manifest = {
      version: 2,
      updatedAt: 0,
      meta: { path: META_PATH, hash: '', size: 0 },
      shards: [],
    }
  }

  const shardEntries: ShardEntry[] = manifest.shards

  // 1. 写入 meta 分片
  if (parsed.meta) {
    // 防御：旧版本/无密码客户端推送的 meta 不含（或为空）adminPwdHash，
    // 不能让它把云端已有的管理员密码哈希抹掉。仅当本次带了非空哈希才覆盖，
    // 否则保留云端现有值——与客户端 applyRemoteHash 的「空值不覆盖」对称，
    // 杜绝混版客户端互相清空密码。
    if (!parsed.meta.adminPwdHash) {
      const existingMeta = await readJson<MetaShard>(META_PATH)
      if (existingMeta?.adminPwdHash) parsed.meta.adminPwdHash = existingMeta.adminPwdHash
    }
    const metaBody = JSON.stringify(parsed.meta)
    const hash = await sha256(metaBody)
    await writeJson(META_PATH, metaBody)
    manifest.meta = { path: META_PATH, hash, size: Buffer.byteLength(metaBody) }
  }

  // 2. 写入变化的题目分片，更新 manifest 中对应 entry
  if (parsed.shards?.length) {
    for (const s of parsed.shards) {
      if (!SHARD_PATH_RE.test(s.path)) {
        res.status(400).json({ error: `非法的分片路径：${s.path}` })
        return
      }
      const shardBody = JSON.stringify(s.content)
      const hash = await sha256(shardBody)
      await writeJson(s.path, shardBody)
      const questions = s.content?.questions || {}
      const count = Object.keys(questions).length
      const updatedAt = Object.values(questions).reduce(
        (max: number, q: any) => Math.max(max, Number(q?.updatedAt || 0)),
        0,
      )
      const entry: ShardEntry = {
        path: s.path,
        subjectId: s.content.subjectId,
        index: s.content.index,
        hash,
        size: Buffer.byteLength(shardBody),
        count,
        updatedAt,
      }
      const idx = shardEntries.findIndex(
        (e) => e.subjectId === entry.subjectId && e.index === entry.index,
      )
      if (idx >= 0) shardEntries[idx] = entry
      else shardEntries.push(entry)
    }
  }

  // 3. 删除分片（科目被删除时）
  if (parsed.deletePaths?.length) {
    const valid = parsed.deletePaths.filter((p) => SHARD_PATH_RE.test(p))
    if (valid.length) {
      await del(valid).catch(() => {})
      for (const p of valid) {
        const idx = shardEntries.findIndex((e) => e.path === p)
        if (idx >= 0) shardEntries.splice(idx, 1)
      }
    }
  }

  // 4. 写入新 manifest（仅当有实际变更时；无变更则不写，省一次 put）
  const hasChanges = !!parsed.meta || !!parsed.shards?.length || !!parsed.deletePaths?.length
  if (hasChanges) {
    manifest.updatedAt = Date.now()
    manifest.shards = shardEntries.sort((a, b) =>
      a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : a.index - b.index,
    )
    await writeManifest(manifest)
  }

  res.status(200).json({ ok: true, manifest })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}
