import { db } from '@/db'

export interface ParsedImage {
  hash: string
  blob: Blob
}

/** 保存解析出的图片到 attachments 表（按 hash 去重，批量写入） */
export async function saveImages(images: ParsedImage[]): Promise<void> {
  if (!images.length) return
  const hashes = images.map((i) => i.hash)
  // 一次批量查已存在项
  const existing = await db.attachments.bulkGet(hashes)
  const toAdd = images
    .filter((img, i) => !existing[i])
    .map((img) => ({
      hash: img.hash,
      blob: img.blob,
      size: img.blob.size,
      synced: false,
    }))
  if (toAdd.length) await db.attachments.bulkPut(toAdd)
}
