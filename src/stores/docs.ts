import { defineStore } from 'pinia'
import { uid } from '@/db'
import { docsRepo } from '@/db/docs'
import { uploadDoc, listDocs, fetchDoc, deleteDoc } from '@/services/docs-api'
import { renderDoc, type RenderProgress } from '@/services/doc-render'
import type { DocMeta, DocRecord } from '@/types'

/**
 * 文档资料阅读器 store。
 * 职责:拉取云端清单、上传(解析+图片+主体)、删除、打开(取 HTML+缓存)。
 */
export const useDocsStore = defineStore('docs', {
  state: () => ({
    /** 云端文档清单(按 uploadedAt 降序) */
    list: [] as DocMeta[],
    loading: false,
    /** 当前打开的文档(阅读页用) */
    current: null as DocRecord | null,
    currentLoading: false,
  }),
  actions: {
    /** 拉取云端清单;失败时保留旧值 */
    async loadList() {
      this.loading = true
      try {
        const manifest = await listDocs()
        this.list = [...manifest.docs].sort((a, b) => b.uploadedAt - a.uploadedAt)
      } finally {
        this.loading = false
      }
    },

    /**
     * 上传文档:解析 → 图片上传 → 主体上传 → 本地缓存 → 刷新清单
     * @throws 任一步骤失败时抛出,UI 层捕获提示
     */
    async upload(file: File, onProgress?: RenderProgress): Promise<void> {
      const { html, meta: renderMeta } = await renderDoc(file, onProgress)
      const docMeta: DocMeta = {
        id: uid('doc_'),
        name: file.name,
        ext: file.name.split('.').pop()?.toLowerCase() === 'docx' ? 'docx' : 'md',
        uploadedAt: Date.now(),
        htmlSize: renderMeta.htmlSize,
        imageCount: renderMeta.imageCount,
      }
      await uploadDoc(docMeta, html)
      // 顺手缓存,二次打开命中本地
      await docsRepo.put({
        id: docMeta.id,
        html,
        meta: docMeta,
        cachedAt: Date.now(),
      })
      await this.loadList()
    },

    /** 删除文档(不删图片,可能被其他文档引用) */
    async remove(id: string) {
      await deleteDoc(id)
      await docsRepo.clear(id)
      // 若当前阅读的就是被删文档,清空
      if (this.current?.meta.id === id) this.current = null
      await this.loadList()
    },

    /**
     * 打开文档:优先本地缓存,否则拉云端并缓存
     * @throws 网络失败且无缓存时抛出
     */
    async open(id: string) {
      this.currentLoading = true
      try {
        // 1. 查缓存
        const cached = await docsRepo.get(id)
        if (cached) {
          this.current = { meta: cached.meta, html: cached.html }
          return
        }
        // 2. 拉云端
        const doc = await fetchDoc(id)
        this.current = doc
        await docsRepo.put({
          id: doc.meta.id,
          html: doc.html,
          meta: doc.meta,
          cachedAt: Date.now(),
        })
      } finally {
        this.currentLoading = false
      }
    },

    /** 清空当前文档(离开阅读页时调用) */
    clearCurrent() {
      this.current = null
    },
  },
})
