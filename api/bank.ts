// Vercel Serverless Function：云端题库存储（跨设备共享）
// 把整库快照（questions/chapters/subjects/wrongBook 的 JSON）存到 Vercel Blob，
// 电脑端导入后 PUT，手机端打开站点 GET 后合并进本地，即可接着做题。
//
// 部署前需在 Vercel 项目里创建一个 Blob store（Storage → Blob → Create），
// 它会自动注入 BLOB_READ_WRITE_TOKEN 环境变量。
// 可选：设置环境变量 BANK_KEY 作为共享密钥（非账号系统，仅防陌生人覆盖），
// 客户端在「设置」里填同样的密钥即可。

import { del, get, put, list } from '@vercel/blob'

export const config = { runtime: 'nodejs' }

const BANK_PATH = 'quizbox/bank.json'

async function listBankBlobs() {
  const { blobs } = await list({ prefix: BANK_PATH })
  return blobs.filter((blob) => blob.pathname === BANK_PATH)
}

async function readBankJson() {
  const blob = await get(BANK_PATH, { access: 'private' })
  if (!blob?.stream) return { version: 1, tables: {} }
  const text = await new Response(blob.stream).text()
  return JSON.parse(text)
}

function countTables(data: any) {
  const tables = data?.tables || {}
  return Object.fromEntries(
    ['subjects', 'chapters', 'questions', 'wrongBook'].map((name) => [
      name,
      tables[name] ? Object.keys(tables[name]).length : 0,
    ]),
  )
}

function blobMeta(blob: any, data?: any) {
  return {
    exists: !!blob,
    pathname: blob?.pathname || BANK_PATH,
    size: blob?.size || 0,
    uploadedAt: blob?.uploadedAt || null,
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
      const blobs = await listBankBlobs()
      if (!blobs.length) {
        if (req.query?.meta === '1') {
          res.status(200).json({ ok: true, ...blobMeta(null), tableCounts: countTables(null) })
          return
        }
        res.status(200).json({ version: 1, tables: {} })
        return
      }
      const latest = blobs.sort(
        (a, b) => +new Date(b.uploadedAt) - +new Date(a.uploadedAt),
      )[0]
      const data = await readBankJson()
      if (req.query?.meta === '1') {
        res.status(200).json({ ok: true, ...blobMeta(latest, data) })
        return
      }
      res.status(200).json(data)
      return
    }

    if (req.method === 'PUT' || req.method === 'POST') {
      const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body ?? {})
      let parsed: any = null
      try {
        parsed = JSON.parse(body)
      } catch {
        res.status(400).json({ error: '请求体不是合法 JSON' })
        return
      }
      const existing = await listBankBlobs()
      if (existing.length) {
        await del(existing.map((blob) => blob.pathname))
      }
      const uploaded = await put(BANK_PATH, body, {
        access: 'private',
        contentType: 'application/json',
        addRandomSuffix: false,
      })
      const verified = (await listBankBlobs()).find((blob) => blob.pathname === BANK_PATH)
      res.status(200).json({
        ok: true,
        uploaded: {
          pathname: uploaded.pathname,
          url: uploaded.url,
        },
        ...blobMeta(verified, parsed),
      })
      return
    }

    res.status(405).json({ error: 'method not allowed' })
  } catch (e: any) {
    res.status(500).json({ error: e?.message || '云端题库存储错误' })
  }
}
