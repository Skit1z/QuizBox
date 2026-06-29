import { createClient, type WebDAVClient } from 'webdav'
import { db, isDeleted } from '@/db'
import { useSettingsStore } from '@/stores/settings'
import { debounce } from '@/utils/debounce'
import { sha256 } from '@/utils/hash'
import type {
  SyncRecord,
  Question,
  BankManifest,
  ShardEntry,
  MetaShard,
  QuestionShard,
} from '@/types'

// 需要参与同步的 Dexie 表名（带 updatedAt/deletedAt 的）
const SYNC_TABLES = [
  'subjects',
  'chapters',
  'questions',
] as const
type SyncTable = (typeof SYNC_TABLES)[number]

const SYNC_FILE = 'sync.json'
const ATTACH_DIR = 'attachments'
const TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000

let client: WebDAVClient | null = null
let syncing = false
let currentSync: Promise<{ pulled: number; pushed: number; ok: boolean }> | null = null

/**
 * 判断是否运行在浏览器网页环境（非 Tauri 桌面端）。
 * 网页环境受 CORS 限制，需走 /api/webdav 代理；Tauri 桌面端可直连。
 */
function isWebEnv(): boolean {
  return typeof window !== 'undefined' && !(window as any).__TAURI__
}

/**
 * 根据原始 WebDAV 地址，返回实际应连接的地址 + 额外请求头。
 * - 网页环境：走 /api/webdav 代理，真实地址放 X-WebDAV-Target 头
 * - Tauri 桌面端：直连原地址
 */
function resolveWebdavEndpoint(rawUrl: string): {
  url: string
  headers: Record<string, string>
} {
  if (isWebEnv()) {
    return {
      url: '/api/webdav',
      headers: { 'X-WebDAV-Target': rawUrl.replace(/\/$/, '') },
    }
  }
  return { url: rawUrl, headers: {} }
}

/** 用指定配置创建 WebDAV client（内部用） */
function makeClient(rawUrl: string, username: string, password: string): WebDAVClient {
  const { url, headers } = resolveWebdavEndpoint(rawUrl)
  const c = createClient(url, { username, password })
  if (Object.keys(headers).length) {
    c.setHeaders(headers as any)
  }
  return c
}

/** #15: 重置 client，使修改后的 WebDAV 配置生效 */
export function resetSyncClient() {
  client = null
}

/**
 * 用指定配置（无需先保存）测试 WebDAV 连通性。
 * 尝试访问根目录，成功即视为连接正常。
 */
export async function testWebdav(config: {
  url: string
  username: string
  password: string
}): Promise<void> {
  if (!config.url) throw new Error('请先填写服务器地址')
  if (!config.username) throw new Error('请先填写账号')
  const c = makeClient(config.url, config.username, config.password)
  // 尝试列目录，验证连通性与凭据
  await c.getDirectoryContents('/')
}

function getClient(): WebDAVClient | null {
  const s = useSettingsStore()
  if (!s.webdav.enabled || !s.webdav.url) return null
  if (!client) {
    client = makeClient(s.webdav.url, s.webdav.username, s.webdav.password)
  }
  return client
}

function remotePath(file: string): string {
  const s = useSettingsStore()
  const base = (s.webdav.remotePath || '/QuizBox').replace(/\/$/, '')
  return `${base}/${file}`
}

async function ensureDirs(c: WebDAVClient) {
  const s = useSettingsStore()
  const base = (s.webdav.remotePath || '/QuizBox').replace(/\/$/, '')
  await ensureDir(c, base)
  await ensureDir(c, `${base}/${ATTACH_DIR}`)
}

async function ensureDir(c: WebDAVClient, path: string) {
  try {
    const exists = await c.exists(path)
    if (!exists) await c.createDirectory(path, { recursive: true })
  } catch {
    // 忽略，可能已存在
  }
}

/** 主同步入口（并发安全：进行中的同步会让后续调用排队等待结果） */
export async function sync(): Promise<{ pulled: number; pushed: number; ok: boolean }> {
  const c = getClient()
  if (!c) return { pulled: 0, pushed: 0, ok: false }
  // 已有同步进行中：复用其结果，避免并发写冲突
  if (currentSync) return currentSync
  syncing = true
  currentSync = (async () => {
    try {
      await ensureDirs(c)
      await pruneLocalTombstones()
      const remote = await fetchRemote(c)
      const local = await exportLocal()
      const merged = pruneMergedTombstones(mergeAll(local, remote))
      await importLocal(merged)
      await uploadSyncFile(c, merged)
      await syncAttachments(c)
      await db.syncMeta.put({ key: 'lastSyncAt', value: String(Date.now()) })
      return { pulled: merged.stats.pulled, pushed: merged.stats.pushed, ok: true }
    } catch (e) {
      console.warn('[sync] failed', e)
      return { pulled: 0, pushed: 0, ok: false }
    } finally {
      syncing = false
      currentSync = null
    }
  })()
  return currentSync
}

/** 防抖自动同步（WebDAV + 云端题库，按各自开关执行） */
export const autoSync = debounce(() => {
  void sync()
  void syncBank()
}, 30000)

/** 启动时拉取 */
export async function syncOnStartup() {
  const s = useSettingsStore()
  await s.load()
  if (s.webdav.enabled) await sync()
  if (s.bankSync.enabled) await syncBank()
}

// ===== 数据导入导出 =====

interface SyncFileData {
  version: number
  tables: Record<SyncTable, Record<string, any>>
}

async function fetchRemote(c: WebDAVClient): Promise<SyncFileData> {
  try {
    const buf = await c.getFileContents(remotePath(SYNC_FILE), { format: 'binary' })
    const text = typeof buf === 'string' ? buf : new TextDecoder().decode(buf as ArrayBuffer)
    return JSON.parse(text) as SyncFileData
  } catch {
    return { version: 1, tables: {} as any }
  }
}

/**
 * 导出本地全量数据。
 * 注：曾尝试基于 lastSyncAt 做增量导出以减少序列化体积，但 WebDAV 同步
 * 是无条件 PUT 整个 sync.json（不支持按记录增量传输），增量导出反而带来
 * 数据丢失风险（D1：未变化但远端缺失的记录会被合并逻辑丢弃）。
 * 因此 export 始终全量，用 updatedAt 索引范围查询降低首次扫描成本，
 * 数据安全优先于微小的序列化开销。
 */
async function exportLocal(): Promise<SyncFileData> {
  const tables: Record<SyncTable, Record<string, any>> = {} as any
  for (const t of SYNC_TABLES) {
    // 全量读取：sync.json 需包含本地所有同步表记录
    const rows = await (db as any)[t].toArray()
    const map: Record<string, any> = {}
    for (const r of rows) map[r.id] = r
    tables[t] = map
  }
  return { version: 1, tables }
}

function isExpiredTombstone(row: any, now = Date.now()): boolean {
  return isDeleted(row?.deletedAt) && now - Number(row.deletedAt) > TOMBSTONE_RETENTION_MS
}

interface MergeStats {
  pulled: number
  pushed: number
}

/** 合并：逐条 last-write-wins */
function mergeAll(local: SyncFileData, remote: SyncFileData): SyncFileData & { stats: MergeStats } {
  const merged: SyncFileData = { version: 1, tables: {} as any }
  let pulled = 0
  let pushed = 0

  for (const t of SYNC_TABLES) {
    const lmap = local.tables[t] || {}
    const rmap = remote.tables[t] || {}
    // 远端可能存的是全量（旧版），也可能是增量；取并集 id
    const allIds = new Set([...Object.keys(lmap), ...Object.keys(rmap)])
    const out: Record<string, any> = {}
    for (const id of allIds) {
      const l = lmap[id]
      const r = rmap[id]
      if (!r) {
        out[id] = l
        pushed++
      } else if (!l) {
        out[id] = r
        pulled++
      } else {
        const lt = (l as SyncRecord).updatedAt || 0
        const rt = (r as SyncRecord).updatedAt || 0
        if (rt > lt) {
          out[id] = r
          pulled++
        } else {
          out[id] = l
          pushed++
        }
      }
    }
    merged.tables[t] = out
  }
  return { ...merged, stats: { pulled, pushed } }
}

function pruneMergedTombstones(
  merged: SyncFileData & { stats: MergeStats },
): SyncFileData & { stats: MergeStats } {
  const now = Date.now()
  for (const t of SYNC_TABLES) {
    const table = merged.tables[t] || {}
    for (const [id, row] of Object.entries(table)) {
      if (isExpiredTombstone(row, now)) delete table[id]
    }
  }
  return merged
}

async function pruneLocalTombstones() {
  const now = Date.now()
  const expiredBefore = now - TOMBSTONE_RETENTION_MS
  for (const t of SYNC_TABLES) {
    const rows = await (db as any)[t]
      .where('deletedAt')
      .between(1, expiredBefore, true, true)
      .toArray()
      .catch(async () => {
        const all = await (db as any)[t].toArray()
        return all.filter((row: any) => isExpiredTombstone(row, now))
      })
    const ids = rows
      .filter((row: any) => isExpiredTombstone(row, now))
      .map((row: any) => row.id)
    if (ids.length) await (db as any)[t].bulkDelete(ids)
  }
}

async function importLocal(merged: SyncFileData & { stats: MergeStats }) {
  for (const t of SYNC_TABLES) {
    const rows = Object.values(merged.tables[t] || {})
    if (rows.length) await (db as any)[t].bulkPut(rows)
  }
}

async function uploadSyncFile(c: WebDAVClient, merged: SyncFileData) {
  const json = JSON.stringify({ version: merged.version, tables: merged.tables })
  await c.putFileContents(remotePath(SYNC_FILE), json, { overwrite: true })
}

// ===== 附件同步 =====

async function syncAttachments(c: WebDAVClient) {
  // 只取未同步项（用 synced 索引，避免全量 Blob 载入内存）
  const local = await db.attachments.where('synced').equals(0 as any).toArray().catch(async () => {
    const all = await db.attachments.toArray()
    return all.filter((a) => !a.synced)
  })
  for (const att of local) {
    const remoteFile = remotePath(`${ATTACH_DIR}/${att.hash}`)
    try {
      const exists = await c.exists(remoteFile)
      if (!exists) {
        const buf = await att.blob.arrayBuffer()
        await c.putFileContents(remoteFile, buf, { overwrite: true })
      }
      await db.attachments.update(att.hash, { synced: true })
    } catch (e) {
      console.warn('[sync] attachment upload failed', att.hash, e)
    }
  }
}

// ===== 云端题库同步（部署自带的 /api/bank，跨设备共享） =====
// v2：按科目分片 + 哈希增量同步。
//   - 拉取：仅下载 manifest（~1 KB）+ 哈希变化的分片
//   - 推送：仅上传本地变更的分片（基于 lastBankSyncAt 检测）
//   - 兼容：远端若仍是旧版 bank.json，自动全量拉取后升级为分片格式

function bankEndpoint(): string {
  const s = useSettingsStore()
  const base = (s.bankSync.baseUrl || '').replace(/\/$/, '')
  return base ? `${base}/api/bank` : '/api/bank'
}

function bankAuthHeaders(): Record<string, string> {
  const s = useSettingsStore()
  return s.bankSync.key ? { Authorization: `Bearer ${s.bankSync.key}` } : {}
}

const MANIFEST_KEY = 'bank_manifest'
const SHARD_MAX_BYTES = 250 * 1024

interface BankSnapshotMeta {
  exists?: boolean
  pathname?: string
  size?: number
  uploadedAt?: string | null
  tableCounts?: Record<string, number>
}

let bankSyncing: Promise<BankSyncResult> | null = null

export interface BankSyncResult {
  pulled: number
  pushed: number
  ok: boolean
  error?: string
  /** 拉取的分片数 */
  shardsPulled?: number
  /** 推送的分片数 */
  shardsPushed?: number
}

async function readErrorMessage(res: Response): Promise<string> {
  const data = await res.json().catch(() => null)
  return data?.error || data?.message || res.statusText || `HTTP ${res.status}`
}

// ----- 本地 manifest 缓存 -----

async function getLocalManifest(): Promise<BankManifest | null> {
  const meta = await db.syncMeta.get(MANIFEST_KEY)
  if (!meta) return null
  try {
    return JSON.parse(meta.value) as BankManifest
  } catch {
    return null
  }
}

async function saveLocalManifest(manifest: BankManifest) {
  await db.syncMeta.put({ key: MANIFEST_KEY, value: JSON.stringify(manifest) })
}

async function getLastBankSyncAt(): Promise<number> {
  const meta = await db.syncMeta.get('lastBankSyncAt')
  return meta ? Number(meta.value) : 0
}

// ----- 远端请求 -----

async function fetchRemoteManifest(): Promise<BankManifest | null> {
  const res = await fetch(`${bankEndpoint()}?manifest=1`, { headers: bankAuthHeaders() })
  if (!res.ok) throw new Error(`manifest 拉取失败：${await readErrorMessage(res)} (${res.status})`)
  const data = await res.json().catch(() => null)
  return data?.manifest || null
}

async function fetchShard(path: string): Promise<QuestionShard> {
  const res = await fetch(`${bankEndpoint()}?shard=${encodeURIComponent(path)}`, {
    headers: bankAuthHeaders(),
  })
  if (!res.ok) throw new Error(`分片拉取失败：${await readErrorMessage(res)} (${res.status})`)
  return (await res.json()) as QuestionShard
}

async function fetchLegacyFullBank(): Promise<SyncFileData | null> {
  const res = await fetch(bankEndpoint(), { headers: bankAuthHeaders() })
  if (!res.ok) throw new Error(`全量拉取失败：${await readErrorMessage(res)} (${res.status})`)
  const data = (await res.json()) as SyncFileData
  if (!data?.tables) return null
  return data
}

async function putShards(body: {
  version: 2
  baseManifestUpdatedAt: number
  meta?: MetaShard
  shards?: Array<{ path: string; content: QuestionShard }>
  deletePaths?: string[]
}): Promise<BankManifest> {
  const res = await fetch(bankEndpoint(), {
    method: 'PUT',
    headers: { ...bankAuthHeaders(), 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`推送失败：${await readErrorMessage(res)} (${res.status})`)
  const data = await res.json()
  return data.manifest as BankManifest
}

// ----- 分片工具 -----

function shardPath(subjectId: string, index: number): string {
  return `quizbox/shard_sub_${subjectId}_${index}.json`
}

/**
 * 将一个科目的题目按 250KB 上限拆分为多个分片。
 * 题目按 updatedAt 升序排列，使新修改的题目集中在最后分片，旧分片哈希保持稳定。
 */
function splitIntoShards(
  subjectId: string,
  questions: Record<string, Question>,
): QuestionShard[] {
  const sorted = Object.values(questions).sort(
    (a, b) => (a.updatedAt || 0) - (b.updatedAt || 0),
  )
  const shards: QuestionShard[] = []
  let current: Record<string, Question> = {}
  let currentSize = 0

  const flush = (index: number) => {
    if (Object.keys(current).length > 0) {
      shards.push({ subjectId, index, questions: { ...current } })
      current = {}
      currentSize = 0
    }
  }

  let index = 0
  for (const q of sorted) {
    const qSize = new Blob([JSON.stringify(q)]).size
    if (currentSize + qSize > SHARD_MAX_BYTES && Object.keys(current).length > 0) {
      flush(index)
      index++
    }
    current[q.id] = q
    currentSize += qSize
  }
  flush(index)
  return shards
}

/** 找出本地缓存 manifest 与远端 manifest 之间哈希变化的分片 */
function diffManifestShards(
  local: BankManifest | null,
  remote: BankManifest,
): ShardEntry[] {
  if (!local) return remote.shards
  const localByPath = new Map(local.shards.map((s) => [s.path, s]))
  return remote.shards.filter((rs) => {
    const ls = localByPath.get(rs.path)
    return !ls || ls.hash !== rs.hash
  })
}

/** meta 分片是否变化（哈希不同） */
function isMetaChanged(local: BankManifest | null, remote: BankManifest): boolean {
  if (!local) return true
  return local.meta.hash !== remote.meta.hash
}

// ----- 本地数据导出（按科目） -----

async function exportMetaShard(): Promise<MetaShard> {
  const [subjects, chapters] = await Promise.all([
    db.subjects.toArray(),
    db.chapters.toArray(),
  ])
  const subjectMap: Record<string, any> = {}
  for (const s of subjects) subjectMap[s.id] = s
  const chapterMap: Record<string, any> = {}
  for (const c of chapters) chapterMap[c.id] = c
  // 管理员密码哈希随 meta 分片同步到云端，实现跨设备共享
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  return { subjects: subjectMap, chapters: chapterMap, adminPwdHash: adminStore.getHash() }
}

async function exportSubjectQuestions(subjectId: string): Promise<Record<string, any>> {
  const rows = await db.questions.where('subjectId').equals(subjectId).toArray()
  const map: Record<string, any> = {}
  for (const q of rows) map[q.id] = q
  return map
}

// ----- 拉取合并 -----

/** 逐条 last-write-wins 合并远端分片到本地 */
async function mergeShardToLocal(shard: QuestionShard): Promise<number> {
  const rows = Object.values(shard.questions)
  if (!rows.length) return 0
  const ids = rows.map((r) => r.id)
  const existing = await db.questions.bulkGet(ids)
  let pulled = 0
  const toPut: any[] = []
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]
    const ex = existing[i]
    if (!ex || (r.updatedAt || 0) >= (ex.updatedAt || 0)) {
      toPut.push(r)
      pulled++
    }
  }
  if (toPut.length) await db.questions.bulkPut(toPut)
  return pulled
}

/** 合并远端 meta（subjects/chapters）到本地，逐条 last-write-wins */
async function mergeMetaToLocal(meta: MetaShard): Promise<number> {
  let pulled = 0
  const subjects = Object.values(meta.subjects || {})
  if (subjects.length) {
    const existing = await db.subjects.bulkGet(subjects.map((s: any) => s.id))
    const toPut = subjects.filter((r: any, i: number) => {
      const ex = existing[i]
      return !ex || (r.updatedAt || 0) >= (ex.updatedAt || 0)
    })
    if (toPut.length) {
      await db.subjects.bulkPut(toPut)
      pulled += toPut.length
    }
  }
  const chapters = Object.values(meta.chapters || {})
  if (chapters.length) {
    const existing = await db.chapters.bulkGet(chapters.map((c: any) => c.id))
    const toPut = chapters.filter((r: any, i: number) => {
      const ex = existing[i]
      return !ex || (r.updatedAt || 0) >= (ex.updatedAt || 0)
    })
    if (toPut.length) {
      await db.chapters.bulkPut(toPut)
      pulled += toPut.length
    }
  }
  // 同步管理员密码哈希：以云端为权威源，跨设备共享同一密码
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  adminStore.applyRemoteHash(meta.adminPwdHash)
  return pulled
}

// ----- 推送检测 -----

interface ChangedShard {
  subjectId: string
  index: number
  content: QuestionShard
  hash: string
}

async function detectLocalChanges(
  remoteManifest: BankManifest | null,
): Promise<{ meta: MetaShard | null; shards: ChangedShard[]; deletePaths: string[] }> {
  const lastSync = await getLastBankSyncAt()
  const result: { meta: MetaShard | null; shards: ChangedShard[]; deletePaths: string[] } = {
    meta: null,
    shards: [],
    deletePaths: [],
  }

  // 检查 subjects/chapters 变更
  const [changedSubjects, changedChapters] = await Promise.all([
    lastSync
      ? db.subjects.where('updatedAt').above(lastSync).toArray()
      : db.subjects.toArray(),
    lastSync
      ? db.chapters.where('updatedAt').above(lastSync).toArray()
      : db.chapters.toArray(),
  ])

  // 管理员密码哈希是否与云端不同（设/改密码后需推送）
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  const adminChanged = adminStore.getHash() !== adminStore._remoteHash

  if (changedSubjects.length || changedChapters.length || adminChanged) {
    result.meta = await exportMetaShard()
  }

  // 检查题目变更（按科目）
  const changedQuestions = lastSync
    ? await db.questions.where('updatedAt').above(lastSync).toArray()
    : await db.questions.toArray()
  const affectedSubjects = new Set(changedQuestions.map((q) => q.subjectId))

  for (const subjectId of affectedSubjects) {
    if (!subjectId) continue
    const questions = await exportSubjectQuestions(subjectId)
    const shards = splitIntoShards(subjectId, questions)
    for (const shard of shards) {
      const hash = await sha256(JSON.stringify(shard))
      const remoteShard = remoteManifest?.shards.find(
        (s) => s.subjectId === subjectId && s.index === shard.index,
      )
      if (!remoteShard || remoteShard.hash !== hash) {
        result.shards.push({ subjectId, index: shard.index, content: shard, hash })
      }
    }
    // 远端存在但本地已无该 subjectId 的题目 → 科目可能被删除，删除其全部分片
    if (
      Object.keys(questions).length === 0 &&
      remoteManifest?.shards.some((s) => s.subjectId === subjectId)
    ) {
      for (const s of remoteManifest.shards) {
        if (s.subjectId === subjectId) result.deletePaths.push(s.path)
      }
    }
  }

  // 本地存在但远端 manifest 中缺失的科目分片（首次推送）
  if (remoteManifest) {
    const remoteSubjects = new Set(remoteManifest.shards.map((s) => s.subjectId))
    const localSubjects = await db.subjects.toArray()
    for (const sub of localSubjects) {
      if (!remoteSubjects.has(sub.id)) {
        const questions = await exportSubjectQuestions(sub.id)
        if (Object.keys(questions).length === 0) continue
        const shards = splitIntoShards(sub.id, questions)
        for (const shard of shards) {
          const hash = await sha256(JSON.stringify(shard))
          result.shards.push({ subjectId: sub.id, index: shard.index, content: shard, hash })
        }
      }
    }
  }

  return result
}

/**
 * 云端题库同步：哈希增量同步。
 * 1. 拉取远端 manifest（~1 KB）
 * 2. 对比本地缓存 manifest，仅拉取哈希变化的分片
 * 3. 检测本地变更（基于 lastBankSyncAt），仅推送变化的分片
 * 4. 保存最新 manifest
 *
 * 与 WebDAV 同步独立，互不影响；并发调用复用进行中的结果。
 */
export async function syncBank(): Promise<BankSyncResult> {
  const s = useSettingsStore()
  if (!s.loaded) await s.load()
  if (!s.bankSync.enabled) return { pulled: 0, pushed: 0, ok: false }
  if (bankSyncing) return bankSyncing

  bankSyncing = (async () => {
    try {
      // 1. 拉取远端 manifest
      let remoteManifest = await fetchRemoteManifest()
      const localManifest = await getLocalManifest()

      let pulled = 0
      let shardsPulled = 0

      if (!remoteManifest) {
        // 远端仍是旧版全量 bank.json：全量拉取并升级为分片格式
        const legacy = await fetchLegacyFullBank()
        if (legacy) {
          const merged = pruneMergedTombstones(mergeAll(await exportLocal(), legacy))
          await importLocal(merged)
          pulled = merged.stats.pulled
        }
        // 首次推送本地全量 → 触发服务端建立分片格式
        const changes = await detectLocalChanges(null)
        if (changes.shards.length || changes.meta) {
          const newManifest = await putShards({
            version: 2,
            baseManifestUpdatedAt: 0,
            meta: changes.meta || undefined,
            shards: changes.shards.map((c) => ({ path: shardPath(c.subjectId, c.index), content: c.content })),
            deletePaths: changes.deletePaths,
          })
          await saveLocalManifest(newManifest)
          await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(Date.now()) })
          return {
            pulled,
            pushed: changes.shards.length,
            ok: true,
            shardsPulled,
            shardsPushed: changes.shards.length,
          }
        }
        // 本地也无数据：无需推送
        await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(Date.now()) })
        return { pulled, pushed: 0, ok: true, shardsPulled, shardsPushed: 0 }
      }

      // 2. 拉取变化的分片
      if (isMetaChanged(localManifest, remoteManifest)) {
        const metaRes = await fetch(`${bankEndpoint()}?shard=${encodeURIComponent(remoteManifest.meta.path)}`, {
          headers: bankAuthHeaders(),
        })
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as MetaShard
          pulled += await mergeMetaToLocal(meta)
        }
      }

      const changedShards = diffManifestShards(localManifest, remoteManifest)
      for (const entry of changedShards) {
        const shard = await fetchShard(entry.path)
        pulled += await mergeShardToLocal(shard)
        shardsPulled++
      }

      // 3. 检测本地变更并推送
      const changes = await detectLocalChanges(remoteManifest)
      let pushed = 0
      let shardsPushed = 0

      if (changes.shards.length || changes.meta || changes.deletePaths.length) {
        // 乐观并发：失败时（409）重拉一次合并后重试
        try {
          const newManifest = await putShards({
            version: 2,
            baseManifestUpdatedAt: remoteManifest.updatedAt,
            meta: changes.meta || undefined,
            shards: changes.shards.map((c) => ({ path: shardPath(c.subjectId, c.index), content: c.content })),
            deletePaths: changes.deletePaths,
          })
          remoteManifest = newManifest
          pushed = changes.shards.length
          shardsPushed = changes.shards.length
        } catch (e: any) {
          // 推送冲突：保留已拉取的合并结果，本次跳过推送，下次同步重试
          console.warn('[bank-sync] push conflict, will retry next sync', e?.message)
        }
      }

      // 4. 保存最新 manifest
      await saveLocalManifest(remoteManifest)
      await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(Date.now()) })

      return { pulled, pushed, ok: true, shardsPulled, shardsPushed }
    } catch (e: any) {
      console.warn('[bank-sync] failed', e)
      return { pulled: 0, pushed: 0, ok: false, error: e?.message || '云端同步失败' }
    } finally {
      bankSyncing = null
    }
  })()
  return bankSyncing
}

/** 用当前配置测试云端题库接口连通性（GET meta 一次） */
export async function testBankSync(config: {
  baseUrl: string
  key: string
}): Promise<BankSnapshotMeta> {
  const base = (config.baseUrl || '').replace(/\/$/, '')
  const url = base ? `${base}/api/bank?meta=1` : '/api/bank?meta=1'
  const headers: Record<string, string> = config.key ? { Authorization: `Bearer ${config.key}` } : {}
  const res = await fetch(url, { headers })
  if (res.status === 401) throw new Error('密钥不匹配')
  if (!res.ok) throw new Error(`接口不可用：${await readErrorMessage(res)} (${res.status})`)
  return await res.json().catch(() => {
    throw new Error('返回内容异常')
  })
}

/** 从远端下载缺失的附件（懒加载时调用） */
export async function fetchAttachment(hash: string): Promise<Blob | null> {
  const local = await db.attachments.get(hash)
  if (local) return local.blob
  const c = getClient()
  if (!c) return null
  try {
    const buf = await c.getFileContents(remotePath(`${ATTACH_DIR}/${hash}`), {
      format: 'binary',
    })
    const blob = buf instanceof Blob ? buf : new Blob([buf as ArrayBuffer])
    await db.attachments.put({ hash, blob, size: blob.size, synced: true })
    return blob
  } catch {
    return null
  }
}
