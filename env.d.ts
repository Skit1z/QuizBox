/// <reference types="vite/client" />

/** 由 vite.config.ts define 注入的构建期版本号 */
declare const __APP_VERSION__: string

declare module '*.vue' {
  import type { DefineComponent } from 'vue'
  const component: DefineComponent<{}, {}, any>
  export default component
}

declare module 'vue-virtual-scroller' {
  import type { DefineComponent } from 'vue'
  export const DynamicScroller: DefineComponent<any, any, any>
  export const DynamicScrollerItem: DefineComponent<any, any, any>
  export const RecycleScroller: DefineComponent<any, any, any>
}

declare module 'word-extractor' {
  class Document {
    getBody(options?: { filterUnicode?: boolean }): string;
    getFootnotes(options?: { filterUnicode?: boolean }): string;
    getEndnotes(options?: { filterUnicode?: boolean }): string;
    getHeaders(options?: { filterUnicode?: boolean; includeFooters?: boolean }): string;
    getFooters(options?: { filterUnicode?: boolean }): string;
    getAnnotations(options?: { filterUnicode?: boolean }): string;
    getTextboxes(options?: {
      filterUnicode?: boolean;
      includeHeadersAndFooters?: boolean;
      includeBody?: boolean;
    }): string;
  }

  class WordExtractor {
    constructor();
    extract(source: string | ArrayBuffer | Buffer): Promise<Document>;
  }

  export default WordExtractor;
}
