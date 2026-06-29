import { createClient, type WebDAVClient } from 'webdav'
import { db, isDeleted } from '@/db'
import { useSettingsStore } from '@/stores/settings'
import { debounce } from '@/utils/debounce'
import type { SyncRecord } from '@/types'

// 需要参与同步的 Dexie 表名（带 updatedAt/deletedAt 的）
const SYNC_TABLES = [
  'subjects',
  'chapters',
  'questions',
  'wrongBook',
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

function bankEndpoint(): string {
  const s = useSettingsStore()
  const base = (s.bankSync.baseUrl || '').replace(/\/$/, '')
  return base ? `${base}/api/bank` : '/api/bank'
}

function bankAuthHeaders(): Record<string, string> {
  const s = useSettingsStore()
  return s.bankSync.key ? { Authorization: `Bearer ${s.bankSync.key}` } : {}
}

let bankSyncing: Promise<{ pulled: number; pushed: number; ok: boolean }> | null = null

/**
 * 云端题库同步：拉取远端快照 → 与本地逐条 last-write-wins 合并 → 写回本地并推送。
 * 与 WebDAV 同步独立，互不影响；并发调用复用进行中的结果。
 */
export async function syncBank(): Promise<{ pulled: number; pushed: number; ok: boolean }> {
  const s = useSettingsStore()
  if (!s.loaded) await s.load()
  if (!s.bankSync.enabled) return { pulled: 0, pushed: 0, ok: false }
  if (bankSyncing) return bankSyncing

  bankSyncing = (async () => {
    try {
      const res = await fetch(bankEndpoint(), { headers: bankAuthHeaders() })
      if (!res.ok) throw new Error(`拉取失败 (${res.status})`)
      const remote = ((await res.json()) as SyncFileData) || { version: 1, tables: {} as any }
      const local = await exportLocal()
      const merged = pruneMergedTombstones(mergeAll(local, remote))
      await importLocal(merged)

      const put = await fetch(bankEndpoint(), {
        method: 'PUT',
        headers: { ...bankAuthHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: merged.version, tables: merged.tables }),
      })
      if (!put.ok) throw new Error(`推送失败 (${put.status})`)

      await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(Date.now()) })
      return { pulled: merged.stats.pulled, pushed: merged.stats.pushed, ok: true }
    } catch (e) {
      console.warn('[bank-sync] failed', e)
      return { pulled: 0, pushed: 0, ok: false }
    } finally {
      bankSyncing = null
    }
  })()
  return bankSyncing
}

/** 用当前配置测试云端题库接口连通性（GET 一次） */
export async function testBankSync(config: { baseUrl: string; key: string }): Promise<void> {
  const base = (config.baseUrl || '').replace(/\/$/, '')
  const url = base ? `${base}/api/bank` : '/api/bank'
  const headers: Record<string, string> = config.key ? { Authorization: `Bearer ${config.key}` } : {}
  const res = await fetch(url, { headers })
  if (res.status === 401) throw new Error('密钥不匹配')
  if (!res.ok) throw new Error(`接口不可用 (${res.status})`)
  await res.json().catch(() => {
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
