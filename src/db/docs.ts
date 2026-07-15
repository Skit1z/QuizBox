import { db } from './index'
import type { DocCacheRecord } from '@/types'

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
