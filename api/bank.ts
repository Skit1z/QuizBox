// Vercel Serverless Function：云端题库存储（跨设备共享）
//
// v2：按科目分片 + 哈希增量同步。
//   quizbox/manifest.json           (~1 KB, 索引)
//   quizbox/meta.json               (~0.5 KB, subjects + chapters)
//   quizbox/shard_sub_<subjectId>_<index>.json  (<250 KB, 题目分片)
//   quizbox/bank.json               (旧版全量，向后兼容)
//
// 部署前需在 Vercel 项目里创建一个 Blob store（Storage → Blob → Create），
// 它会自动注入 BLOB_READ_WRITE_TOKEN 环境变量。
// 可选：设置环境变量 BANK_KEY 作为共享密钥（非账号系统，仅防陌生人覆盖），
// 客户端在「设置」里填同样的密钥即可。

import { del, get, put, head } from '@vercel/blob'

export const config = { runtime: 'nodejs' }

const PREFIX = 'quizbox/'
const MANIFEST_PATH = `${PREFIX}manifest.json`
const META_PATH = `${PREFIX}meta.json`
const LEGACY_BANK_PATH = `${PREFIX}bank.json`
const SHARD_PATH_RE = /^quizbox\/shard_sub_[A-Za-z0-9_-]+_\d+\.json$/

const BLOB_OPTS = {
  access: 'private' as const,
  contentType: 'application/json',
  addRandomSuffix: false,
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

async function blobExists(path: string): Promise<boolean> {
  const b = await head(path).catch(() => null)
  return !!b
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

/** 根据 manifest 重新拼装出旧版全量 bank.json 结构（供旧客户端降级读取） */
async function assembleLegacyBank(manifest: BankManifest): Promise<{
  version: number
  tables: Record<string, Record<string, any>>
}> {
  const tables: Record<string, Record<string, any>> = {
    subjects: {},
    chapters: {},
    questions: {},
  }
  const meta = await readJson<MetaShard>(META_PATH)
  if (meta) {
    tables.subjects = meta.subjects || {}
    tables.chapters = meta.chapters || {}
  }
  for (const entry of manifest.shards) {
    const shard = await readJson<QuestionShard>(entry.path)
    if (shard?.questions) Object.assign(tables.questions, shard.questions)
  }
  return { version: 1, tables }
}

function countTables(data: any) {
  const tables = data?.tables || {}
  return Object.fromEntries(
    ['subjects', 'chapters', 'questions'].map((name) => [
      name,
      tables[name] ? Object.keys(tables[name]).length : 0,
    ]),
  )
}

function blobMeta(data?: any) {
  return {
    exists: !!data,
    pathname: MANIFEST_PATH,
    size: data ? JSON.stringify(data).length : 0,
    uploadedAt: new Date().toISOString(),
    tableCounts: data ? countTables(data) : undefined,
  }
}

function setCors(res: any) {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,PUT,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization')
}

export default async function handler(req: any, res: any) {
  setCors(res)
  if (req.method === 'OPTIONS') {
    res.status(204).end()
    return
  }

  // 可选共享密钥校验
  const key = process.env.BANK_KEY
  if (key) {
    const auth = String(req.headers['authorization'] || '')
    if (auth !== `Bearer ${key}`) {
      res.status(401).json({ error: '未授权：密钥不匹配' })
      return
    }
  }

  try {
    if (req.method === 'GET') {
      return await handleGet(req, res)
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      return await handlePut(req, res)
    }
    res.status(405).json({ error: 'method not allowed' })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '云端题库存储错误' })
  }
}

// ===== GET =====

async function handleGet(req: any, res: any) {
  const q = req.query || {}
  const manifest = await readManifest()

  // ?manifest=1：只返回索引（~1 KB），增量同步核心入口
  if (q.manifest === '1') {
    if (!manifest) {
      // 兼容：远端仍是旧版全量 bank.json
      const legacyExists = await blobExists(LEGACY_BANK_PATH)
      res.status(200).json({ ok: true, manifest: null, legacy: legacyExists })
      return
    }
    res.status(200).json({ ok: true, manifest })
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

  // ?meta=1：兼容旧版统计信息
  if (q.meta === '1') {
    if (manifest) {
      const bank = await assembleLegacyBank(manifest)
      res.status(200).json({ ok: true, ...blobMeta(bank) })
      return
    }
    // 旧版 bank.json
    const legacy = await readJson<any>(LEGACY_BANK_PATH)
    res.status(200).json({
      ok: true,
      exists: !!legacy,
      pathname: LEGACY_BANK_PATH,
      size: legacy ? JSON.stringify(legacy).length : 0,
      tableCounts: legacy ? countTables(legacy) : countTables(null),
    })
    return
  }

  // 无参数：返回完整合并后的 bank（降级模式，供旧客户端使用）
  if (manifest) {
    const bank = await assembleLegacyBank(manifest)
    res.status(200).json(bank)
    return
  }
  // 旧版全量
  const legacy = await readJson<any>(LEGACY_BANK_PATH)
  res.status(200).json(legacy || { version: 1, tables: {} })
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

async function handlePut(req: any, res: any) {
  const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
  let parsed: BankPutRequest
  try {
    parsed = JSON.parse(body)
  } catch {
    res.status(400).json({ error: '请求体不是合法 JSON' })
    return
  }

  // ===== 旧版兼容：version !== 2 视为全量 bank.json 推送 =====
  if (parsed.version !== 2) {
    await writeJson(LEGACY_BANK_PATH, body)
    const verified = JSON.parse(body)
    res.status(200).json({ ok: true, ...blobMeta(verified) })
    return
  }

  // ===== v2 增量推送 =====
  let manifest = await readManifest()

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

  // 4. 写入新 manifest
  manifest.updatedAt = Date.now()
  manifest.shards = shardEntries.sort(
    (a, b) =>
      a.subjectId < b.subjectId ? -1 : a.subjectId > b.subjectId ? 1 : a.index - b.index,
  )
  await writeManifest(manifest)

  // 推送后清理旧版 bank.json（新格式已生效）
  if (await blobExists(LEGACY_BANK_PATH)) {
    await del(LEGACY_BANK_PATH).catch(() => {})
  }

  res.status(200).json({ ok: true, manifest })
}
