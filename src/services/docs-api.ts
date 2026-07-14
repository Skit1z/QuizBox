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
