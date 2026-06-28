import { createClient, type WebDAVClient } from 'webdav'
import { db, isDeleted } from '@/db'
import { useSettingsStore } from '@/stores/settings'
import { debounce } from '@/utils/hash'
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

let client: WebDAVClient | null = null
let syncing = false

/** #15: 重置 client，使修改后的 WebDAV 配置生效 */
export function resetSyncClient() {
  client = null
}

function getClient(): WebDAVClient | null {
  const s = useSettingsStore()
  if (!s.webdav.enabled || !s.webdav.url) return null
  if (!client) {
    client = createClient(s.webdav.url, {
      username: s.webdav.username,
      password: s.webdav.password,
    })
  }
  return client
}

function remotePath(file: string): string {
  const s = useSettingsStore()
  const base = (s.webdav.remotePath || '/QAsystem').replace(/\/$/, '')
  return `${base}/${file}`
}

async function ensureDirs(c: WebDAVClient) {
  const s = useSettingsStore()
  const base = (s.webdav.remotePath || '/QAsystem').replace(/\/$/, '')
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

/** 主同步入口 */
export async function sync(): Promise<{ pulled: number; pushed: number; ok: boolean }> {
  const c = getClient()
  if (!c || syncing) return { pulled: 0, pushed: 0, ok: false }
  syncing = true
  try {
    await ensureDirs(c)
    const remote = await fetchRemote(c)
    const local = await exportLocal()
    const merged = mergeAll(local, remote)
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
  }
}

/** 防抖自动同步 */
export const autoSync = debounce(() => {
  void sync()
}, 5000)

/** 启动时拉取 */
export async function syncOnStartup() {
  const s = useSettingsStore()
  await s.load()
  if (s.webdav.enabled) await sync()
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
 * 导出本地数据。#14：增量优化——
 * 若有 lastSyncAt，则只导出 updatedAt > lastSyncAt 的变化记录，
 * 避免每次序列化全库。
 */
async function exportLocal(): Promise<SyncFileData> {
  const lastMeta = await db.syncMeta.get('lastSyncAt')
  const since = lastMeta ? Number(lastMeta.value) : 0

  const tables: Record<SyncTable, Record<string, any>> = {} as any
  for (const t of SYNC_TABLES) {
    const all = await (db as any)[t].toArray()
    const changed: Record<string, any> = {}
    for (const r of all) {
      // 无 lastSync（首次）或该记录变化时间晚于上次同步 → 导出
      const ut = (r as SyncRecord).updatedAt || 0
      if (since === 0 || ut > since) changed[r.id] = r
    }
    tables[t] = changed
  }
  return { version: 1, tables }
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
  const local = await db.attachments.toArray()
  for (const att of local) {
    if (att.synced) continue
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
