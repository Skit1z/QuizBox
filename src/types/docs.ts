/**
 * 文档资料阅读器相关类型。
 * 独立文件,避免 types/index.ts 膨胀;由 types/index.ts re-export。
 */

/** 云端文档元数据(docs/manifest.json 的条目) */
export interface DocMeta {
  /** uuid,同时是 doc_<id>.json 的 id */
  id: string
  /** 原始文件名,如 "复习笔记.docx" */
  name: string
  /** 文档类型(仅用于列表图标展示;解析后统一为 HTML) */
  ext: 'docx' | 'md'
  /** 上传时间戳(ms) */
  uploadedAt: number
  /** 渲染产物 HTML 的字节数(用于列表展示大小) */
  htmlSize: number
  /** 图片数量(用于列表展示) */
  imageCount: number
}

/** docs/manifest.json 结构 */
export interface DocsManifest {
  updatedAt: number
  docs: DocMeta[]
}

/** GET /api/docs?id=xxx 返回的文档主体 */
export interface DocRecord {
  meta: DocMeta
  /** 已解析的 HTML(图片 URL 已替换为云端 public URL) */
  html: string
}

/** IndexedDB docsCache 表记录(本地读缓存) */
export interface DocCacheRecord {
  /** 主键,等于 DocMeta.id */
  id: string
  /** 渲染好的 HTML,直接可 v-html */
  html: string
  /** meta 快照,便于离线展示列表项 */
  meta: DocMeta
  /** 缓存写入时间戳(ms) */
  cachedAt: number
}
