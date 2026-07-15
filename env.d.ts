/// <reference types="vite/client" />

/** 由 vite.config.ts define 注入的构建期版本号 */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'virtual:pwa-register' {
  export function registerSW(options?: {
    immediate?: boolean
    onNeedRefresh?: () => void
    onOfflineReady?: () => void
    onRegisteredSW?: (
      swScriptUrl: string,
      registration: ServiceWorkerRegistration | undefined,
    ) => void
  }): (reloadPage?: boolean) => Promise<void>
}

declare module 'vue-virtual-scroller' {
  // 第三方组件无官方类型;vue-tsc 3 下 DefineComponent<any,any,any> 的 slots 会解析为 {},
  // 导致 #default 作用域插槽报错。用 any 关闭该组件的类型/插槽检查(逃生舱)。
  export const DynamicScroller: any
  export const DynamicScrollerItem: any
  export const RecycleScroller: any
}

declare module 'word-extractor' {
  class Document {
    getBody(options?: { filterUnicode?: boolean }): string
    getFootnotes(options?: { filterUnicode?: boolean }): string
    getEndnotes(options?: { filterUnicode?: boolean }): string
    getHeaders(options?: { filterUnicode?: boolean; includeFooters?: boolean }): string
    getFooters(options?: { filterUnicode?: boolean }): string
    getAnnotations(options?: { filterUnicode?: boolean }): string
    getTextboxes(options?: {
      filterUnicode?: boolean
      includeHeadersAndFooters?: boolean
      includeBody?: boolean
    }): string
  }

  class WordExtractor {
    constructor()
    extract(source: string | ArrayBuffer | Buffer): Promise<Document>
  }

  export default WordExtractor
}
