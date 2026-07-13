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

/** 防抖自动同步（云端题库分片同步）。
 *  拉长到 2 分钟：写操作频繁时合并为一次同步，降低 Vercel Blob 计费操作次数。 */
export const autoSync = debounce(() => {
  void syncBank()
}, 120000)

/** 启动时拉取 */
export async function syncOnStartup() {
  const s = useSettingsStore()
  await s.load()
  if (s.bankSync.enabled) await syncBank()
}

// ===== 云端题库同步（部署自带的 /api/bank，跨设备共享） =====
// v2：按科目分片 + 哈希增量同步。
//   - 拉取：仅下载 manifest（~1 KB）+ 哈希变化的分片
//   - 推送：仅上传本地变更的分片（基于 lastBankSyncAt 检测）

function bankEndpoint(): string {
  return '/api/bank'
}

function bankAuthHeaders(): Record<string, string> {
  const s = useSettingsStore()
  return s.bankSync.key ? { Authorization: `Bearer ${s.bankSync.key}` } : {}
}

const MANIFEST_KEY = 'bank_manifest'
const FORCE_SYNC_TOKEN_KEY = 'bank_force_sync_token'
const FORCE_SYNC_ACK_KEY = 'bank_force_sync_ack'
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

async function getForceSyncToken(): Promise<string> {
  const meta = await db.syncMeta.get(FORCE_SYNC_TOKEN_KEY)
  return meta?.value || ''
}

async function getForceSyncAck(): Promise<string> {
  const meta = await db.syncMeta.get(FORCE_SYNC_ACK_KEY)
  return meta?.value || ''
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
  if (!res.ok) {
    const err = new Error(`推送失败：${await readErrorMessage(res)} (${res.status})`)
    ;(err as any).status = res.status
    throw err
  }
  const data = await res.json()
  return data.manifest as BankManifest
}

/**
 * 推送并在 409（manifest 被其他设备抢先更新）时「重拉远端 + 合并新分片/meta + 重新检测本地变更」后重试。
 * 多设备并发推送会撞乐观锁，单次推送必然失败；这里做有界重试让本地变更最终能推上去。
 * @param build 给定最新远端 manifest，返回本次要推送的 body 与是否还有变更
 */
async function putShardsWithRetry(
  build: (remote: BankManifest | null) => Promise<{
    body: Parameters<typeof putShards>[0]
    hasChanges: boolean
  }>,
  initialRemote: BankManifest | null,
  localManifest: BankManifest | null,
  maxAttempts = 4,
): Promise<BankManifest | null> {
  let remote = initialRemote
  let base = localManifest
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const { body, hasChanges } = await build(remote)
    if (!hasChanges) return remote
    try {
      return await putShards(body)
    } catch (e: any) {
      if (e?.status !== 409 || attempt === maxAttempts - 1) throw e
      // 409：远端被其他设备更新 → 重拉 manifest，合并新增/变化的 meta 与分片，再基于最新状态重试
      const fresh = await fetchRemoteManifest()
      if (fresh) {
        if (isMetaChanged(base, fresh)) {
          const metaRes = await fetch(
            `${bankEndpoint()}?shard=${encodeURIComponent(fresh.meta.path)}`,
            { headers: bankAuthHeaders() },
          )
          if (metaRes.ok) await mergeMetaToLocal((await metaRes.json()) as MetaShard)
        }
        for (const entry of diffManifestShards(base, fresh)) {
          const shard = await fetchShard(entry.path).catch(() => null)
          if (shard) await mergeShardToLocal(shard)
        }
      }
      base = fresh
      remote = fresh
    }
  }
  return remote
}

export async function requestBankForceSync(): Promise<BankManifest> {
  const s = useSettingsStore()
  if (!s.loaded) await s.load()
  if (!s.bankSync.enabled) throw new Error('请先启用云端题库同步')
  const syncUpperBound = Date.now() - 1
  const remoteManifest = await fetchRemoteManifest()
  const localManifest = await getLocalManifest()
  // 整轮复用同一个 force token，保证 409 重试后云端 token 与本地 ACK 一致
  const forceToken = `force_${Date.now()}`
  const newManifest = await putShardsWithRetry(
    async (remote) => {
      const changes = await detectLocalChanges(remote)
      const meta = await exportMetaShard(forceToken)
      return {
        hasChanges: true, // 强制同步：始终推 meta（带新 force token 广播给其它设备）
        body: {
          version: 2 as const,
          baseManifestUpdatedAt: remote?.updatedAt || 0,
          meta,
          shards: changes.shards.map((c) => ({
            path: shardPath(c.subjectId, c.index),
            content: c.content,
          })),
          deletePaths: changes.deletePaths,
        },
      }
    },
    remoteManifest,
    localManifest,
  )
  if (newManifest) await saveLocalManifest(newManifest)
  await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(syncUpperBound) })
  await db.syncMeta.put({ key: FORCE_SYNC_ACK_KEY, value: forceToken })
  return newManifest as BankManifest
}

// ----- 分片工具 -----

function shardPath(subjectId: string, index: number): string {
  return `quizbox/shard_sub_${subjectId}_${index}.json`
}

/**
 * 将一个科目的题目按 250KB 上限拆分为多个分片。
 * 题目按 updatedAt 升序排列，使新修改的题目集中在最后分片，旧分片哈希保持稳定。
 */
function splitIntoShards(subjectId: string, questions: Record<string, Question>): QuestionShard[] {
  const sorted = Object.values(questions).sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0))
  const shards: QuestionShard[] = []
  let current: Record<string, Question> = {}

  const flush = (index: number) => {
    if (Object.keys(current).length > 0) {
      shards.push({ subjectId, index, questions: { ...current } })
      current = {}
    }
  }

  let index = 0
  for (const q of sorted) {
    const trial = { ...current, [q.id]: q }
    const trialSize = new Blob([
      JSON.stringify({ subjectId, index, questions: trial } satisfies QuestionShard),
    ]).size
    if (trialSize > SHARD_MAX_BYTES && Object.keys(current).length > 0) {
      flush(index)
      index++
    }
    const singleSize = new Blob([
      JSON.stringify({ subjectId, index, questions: { [q.id]: q } } satisfies QuestionShard),
    ]).size
    if (singleSize > SHARD_MAX_BYTES) {
      throw new Error(`题目 ${q.id} 超过单分片 250KB 限制，请压缩题干内容`)
    }
    current[q.id] = q
  }
  flush(index)
  return shards
}

/** 找出本地缓存 manifest 与远端 manifest 之间哈希变化的分片 */
function diffManifestShards(local: BankManifest | null, remote: BankManifest): ShardEntry[] {
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

async function exportMetaShard(forceSyncToken?: string): Promise<MetaShard> {
  const [subjects, chapters] = await Promise.all([db.subjects.toArray(), db.chapters.toArray()])
  const subjectMap: Record<string, any> = {}
  for (const s of subjects) subjectMap[s.id] = s
  const chapterMap: Record<string, any> = {}
  for (const c of chapters) chapterMap[c.id] = c
  // 管理员密码哈希随 meta 分片同步到云端，实现跨设备共享
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  // 必须先加载，否则 getHash() 返回空串会把云端已有密码覆盖成空
  await adminStore.load()
  const token = forceSyncToken || (await getForceSyncToken())
  if (forceSyncToken) {
    await db.syncMeta.put({ key: FORCE_SYNC_TOKEN_KEY, value: forceSyncToken })
  }
  return {
    subjects: subjectMap,
    chapters: chapterMap,
    adminPwdHash: adminStore.getHash(),
    forceSyncToken: token,
  }
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
  // 云端权威：清理「别处已删、tombstone 已被清理」的孤儿题库。
  // 本地存活、但云端 meta 完全不存在的 subject：
  //   - updatedAt ≤ lastBankSyncAt → 曾经成功上过云、之后本机未改动 → 判定为远端已删 → 本地软删 + 级联
  //   - updatedAt > lastBankSyncAt → 本机新建/刚改尚未推送 → 保留，等下一轮推送
  // 软删而非硬删：下一轮推送会把这些 tombstone 重新带上云，传播给其它漏掉删除的旧设备。
  const cloudSubjectIds = new Set(Object.keys(meta.subjects || {}))
  const lastSync = await getLastBankSyncAt()
  const localSubjects = await db.subjects.toArray()
  const orphanIds = localSubjects
    .filter(
      (s) =>
        !isDeleted(s.deletedAt) && !cloudSubjectIds.has(s.id) && (s.updatedAt || 0) <= lastSync,
    )
    .map((s) => s.id)
  if (orphanIds.length) {
    const now = Date.now()
    const tombstone = <T extends SyncRecord>(rows: T[]): T[] =>
      rows
        .filter((r) => !isDeleted(r.deletedAt))
        .map((r) => ({ ...r, deletedAt: now, updatedAt: now }))
    const subjectRows = (await db.subjects.bulkGet(orphanIds)).filter(
      (s): s is NonNullable<typeof s> => !!s,
    )
    await db.subjects.bulkPut(tombstone(subjectRows))
    const chapterRows = await db.chapters.where('subjectId').anyOf(orphanIds).toArray()
    const deadChapters = tombstone(chapterRows)
    if (deadChapters.length) await db.chapters.bulkPut(deadChapters)
    const questionRows = await db.questions.where('subjectId').anyOf(orphanIds).toArray()
    const deadQuestions = tombstone(questionRows)
    if (deadQuestions.length) await db.questions.bulkPut(deadQuestions)
  }

  // 同步管理员密码哈希：以云端为权威源，跨设备共享同一密码
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  adminStore.applyRemoteHash(meta.adminPwdHash)
  if (meta.forceSyncToken) {
    await db.syncMeta.put({ key: FORCE_SYNC_TOKEN_KEY, value: meta.forceSyncToken })
  }
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
  // 云端尚未初始化时必须全量扫描，不能沿用其它部署留下的本地同步水位。
  const lastSync = remoteManifest ? await getLastBankSyncAt() : 0
  const result: { meta: MetaShard | null; shards: ChangedShard[]; deletePaths: string[] } = {
    meta: null,
    shards: [],
    deletePaths: [],
  }

  // 检查 subjects/chapters 变更
  const [changedSubjects, changedChapters] = await Promise.all([
    lastSync ? db.subjects.where('updatedAt').above(lastSync).toArray() : db.subjects.toArray(),
    lastSync ? db.chapters.where('updatedAt').above(lastSync).toArray() : db.chapters.toArray(),
  ])

  // 管理员密码哈希是否与云端不同（设/改密码后需推送）
  const { useAdminStore } = await import('@/stores/admin')
  const adminStore = useAdminStore()
  // 必须先加载，否则未加载时 getHash() 返回空串，会误判 adminChanged
  // 或在 exportMetaShard 里把云端密码覆盖成空
  await adminStore.load()
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
    const newShardCount = shards.length
    for (const shard of shards) {
      const hash = await sha256(JSON.stringify(shard))
      const remoteShard = remoteManifest?.shards.find(
        (s) => s.subjectId === subjectId && s.index === shard.index,
      )
      if (!remoteShard || remoteShard.hash !== hash) {
        result.shards.push({ subjectId, index: shard.index, content: shard, hash })
      }
    }
    // 分片泄漏修复：题量减少但未归零时，远端可能残留 index >= 新分片数的旧分片。
    // 这些分片既不更新也不删除，造成存储泄漏 + 流量浪费。
    // 这里把超出新分片数的远端分片加入 deletePaths，保持云端分片数与本地一致。
    if (remoteManifest && newShardCount === 0) {
      // 远端存在但本地已无该 subjectId 的题目 → 科目可能被删除，删除其全部分片
      for (const s of remoteManifest.shards) {
        if (s.subjectId === subjectId) result.deletePaths.push(s.path)
      }
    } else if (remoteManifest) {
      for (const s of remoteManifest.shards) {
        if (s.subjectId === subjectId && s.index >= newShardCount) {
          result.deletePaths.push(s.path)
        }
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
 * 并发调用复用进行中的结果。
 */
export async function syncBank(): Promise<BankSyncResult> {
  const s = useSettingsStore()
  if (!s.loaded) await s.load()
  if (!s.bankSync.enabled) return { pulled: 0, pushed: 0, ok: false }
  if (bankSyncing) return bankSyncing

  bankSyncing = (async () => {
    // 成功后只能推进到同步开始前，避免同步过程中产生的本地写入被水位跨过去。
    const syncUpperBound = Date.now() - 1
    try {
      // 1. 拉取远端 manifest
      let remoteManifest = await fetchRemoteManifest()
      let localManifest = await getLocalManifest()

      let pulled = 0
      let shardsPulled = 0

      if (!remoteManifest) {
        // Vercel Blob 尚未初始化：首次推送本地全量并建立分片格式。
        const changes = await detectLocalChanges(null)
        if (changes.shards.length || changes.meta) {
          const newManifest = await putShards({
            version: 2,
            baseManifestUpdatedAt: 0,
            meta: changes.meta || undefined,
            shards: changes.shards.map((c) => ({
              path: shardPath(c.subjectId, c.index),
              content: c.content,
            })),
            deletePaths: changes.deletePaths,
          })
          await saveLocalManifest(newManifest)
          await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(syncUpperBound) })
          return {
            pulled,
            pushed: changes.shards.length,
            ok: true,
            shardsPulled,
            shardsPushed: changes.shards.length,
          }
        }
        // 本地也无数据：无需推送
        await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(syncUpperBound) })
        return { pulled, pushed: 0, ok: true, shardsPulled, shardsPushed: 0 }
      }

      // 2. 拉取变化的分片
      let forceSyncToken = ''
      let shouldForcePull = false
      if (isMetaChanged(localManifest, remoteManifest)) {
        const metaRes = await fetch(
          `${bankEndpoint()}?shard=${encodeURIComponent(remoteManifest.meta.path)}`,
          {
            headers: bankAuthHeaders(),
          },
        )
        if (metaRes.ok) {
          const meta = (await metaRes.json()) as MetaShard
          forceSyncToken = meta.forceSyncToken || ''
          shouldForcePull = !!forceSyncToken && forceSyncToken !== (await getForceSyncAck())
          pulled += await mergeMetaToLocal(meta)
        }
      }
      if (shouldForcePull) {
        localManifest = null
      }

      const changedShards = diffManifestShards(localManifest, remoteManifest)
      for (const entry of changedShards) {
        const shard = await fetchShard(entry.path)
        pulled += await mergeShardToLocal(shard)
        shardsPulled++
      }

      // 3. 检测本地变更并推送（仅当本地确有自上次同步后的变更时才扫描，省 DB 开销）
      const lastSync = await getLastBankSyncAt()
      // 管理员密码变化也算「本地变更」——否则「只改密码、没动题目」时这段扫描被跳过，
      // 密码哈希永远推不上云（setPassword 触发的 syncBank 也会在此被短路）。
      const { useAdminStore } = await import('@/stores/admin')
      const adminStore = useAdminStore()
      await adminStore.load()
      const adminChanged = adminStore.getHash() !== adminStore._remoteHash
      const hasLocalChanges =
        lastSync === 0 ||
        adminChanged ||
        (await Promise.all([
          db.subjects.where('updatedAt').above(lastSync).count(),
          db.chapters.where('updatedAt').above(lastSync).count(),
          db.questions.where('updatedAt').above(lastSync).count(),
        ]).then((cs) => cs.some((c) => c > 0)))

      let pushed = 0
      let shardsPushed = 0
      let pushError = ''
      if (hasLocalChanges) {
        // 乐观并发：409 冲突时由 putShardsWithRetry 重拉合并后重试，避免多设备并发推送活锁
        try {
          const result = await putShardsWithRetry(
            async (remote) => {
              const changes = await detectLocalChanges(remote)
              const hasChanges = !!(
                changes.shards.length ||
                changes.meta ||
                changes.deletePaths.length
              )
              pushed = changes.shards.length
              shardsPushed = changes.shards.length
              return {
                hasChanges,
                body: {
                  version: 2 as const,
                  baseManifestUpdatedAt: remote?.updatedAt || 0,
                  meta: changes.meta || undefined,
                  shards: changes.shards.map((c) => ({
                    path: shardPath(c.subjectId, c.index),
                    content: c.content,
                  })),
                  deletePaths: changes.deletePaths,
                },
              }
            },
            remoteManifest,
            localManifest,
          )
          if (result) remoteManifest = result
        } catch (e: any) {
          // 重试仍冲突/失败：保留已拉取的合并结果，但不能推进 lastBankSyncAt。
          // 否则本地未推送成功的 updatedAt 会被下一轮同步跳过。
          console.warn('[bank-sync] push failed after retries', e?.message)
          pushError = e?.message || '云端推送失败'
          pushed = 0
          shardsPushed = 0
        }
      }

      // 4. 保存最新 manifest
      await saveLocalManifest(remoteManifest)
      if (!pushError) {
        await db.syncMeta.put({ key: 'lastBankSyncAt', value: String(syncUpperBound) })
      }
      if (forceSyncToken) {
        await db.syncMeta.put({ key: FORCE_SYNC_ACK_KEY, value: forceSyncToken })
      }

      return {
        pulled,
        pushed,
        ok: !pushError,
        error: pushError || undefined,
        shardsPulled,
        shardsPushed,
      }
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
export async function testBankSync(config: { key: string }): Promise<BankSnapshotMeta> {
  const headers: Record<string, string> = config.key
    ? { Authorization: `Bearer ${config.key}` }
    : {}
  const res = await fetch('/api/bank?meta=1', { headers })
  if (res.status === 401) throw new Error('密钥不匹配')
  if (!res.ok) throw new Error(`接口不可用：${await readErrorMessage(res)} (${res.status})`)
  return await res.json().catch(() => {
    throw new Error('返回内容异常')
  })
}
