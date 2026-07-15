# 文档资料阅读器 设计文档

**日期**: 2026-07-14
**状态**: 待实现(架构修订:存渲染产物而非源文件)
**分支**: dev

---

## 1. 目标与范围

为 QuizBox 题库系统新增一条**与题库完全独立**的「文档资料阅读」链路:

- 用户可在网页中上传 `.docx` / `.md` 文件(单文件 ≤ 4 MB)。
- **上传时在浏览器端一次性解析为 HTML 渲染产物**,云端只存「解析后的 HTML + 提取出的图片」,不存原始文件。
- 阅读时直接取回 HTML 字符串 → `v-html` 渲染(**零解析开销,秒开**)。
- 文档主存于 **Vercel Blob(云端,全局共享)**;本地 IndexedDB 可选缓存 HTML,加速二次打开。
- **不开放下载**(无下载按钮、不提供原文件外链)。
- 提供独立的「资料」入口(tabbar 新增 tab)+ 文档列表页 + 阅读页。

### 核心架构决策:存渲染产物而非源文件

**为什么不存源文件:**

- 阅读页打开**零解析开销** —— 直接显示 HTML,无需在浏览器重跑 mammoth/marked。
- 阅读页逻辑极简,不需要加载解析库、不需要 loading 等待解析。
- docx/md 解析只在「上传」时发生一次,失败可以提前拒绝(用户知道哪个文件传不上去)。

**代价(已接受):**

- 上传链路更重(客户端解析 + 图片提取 + 多次上传),但这是**一次性**成本。
- 原始文件不保留,无法「重新解析」或换渲染器(本期 YAGNI)。

### 不在本期范围内(YAGNI)

- ❌ 不做文档转题库(题库导入链路保持现状,不被本功能触碰)。
- ❌ 不做按设备/按用户隔离(全局共享,与现有题库同步的共享语义一致)。
- ❌ 不做文档分类、文件夹、标签、全文搜索(列表页只做按时间倒序 + 文件名展示)。
- ❌ 不做 Tauri 桌面端原生文件读写(两端能力等价,都走浏览器 `File` API)。
- ❌ 不做 PDF 支持(现有 pdf-parser 依赖远程 PaddleOCR,与「资料阅读」语义不符)。
- ❌ 不保留原始文件、不提供「重新解析」能力。

---

## 2. 关键决策记录

| 决策点       | 选择                                       | 理由                                                                        |
| ------------ | ------------------------------------------ | --------------------------------------------------------------------------- |
| 核心用途     | 纯资料阅读器                               | 与题库导入解耦,范围清晰                                                     |
| 文件上限     | **4 MB**(源文件)                           | 避开 Vercel serverless 4.5 MB 请求体硬限制;.md 几乎不超,docx 纯文本也基本够 |
| **存储内容** | **解析后的 HTML + 图片**                   | 阅读零开销、秒开;源文件不保留                                               |
| 上传编码     | **multipart/form-data** 直传二进制         | base64 膨胀 33% 会超限;multipart 无膨胀;HTML 文本走 JSON body               |
| 主存储       | Vercel Blob(云端)                          | 全局共享;云端为 source of truth,本地仅做读缓存                              |
| 图片存储     | **单独存为 Blob(public URL)+ HTML 内引用** | 避免 base64 内联导致 HTML 膨胀撞 4.5MB 墙;图片按内容 hash 去重              |
| 鉴权         | **写需 `BANK_KEY` token,读开放**           | 复用 `api/bank.ts` 的 `BANK_KEY`;防陌生人乱写,允许任何人查看                |
| 入口位置     | tabbar 新增「资料」tab                     | 作为核心功能,一级入口最易发现;tabbar 从 3 项变 4 项                         |
| docx 渲染    | 简洁语义化 HTML(复用 mammoth)              | 阅读体验干净统一;不做高保真还原(避免引入 docx-preview ~500 KB)              |
| 下载         | 不开放                                     | 用户明确要求                                                                |

---

## 3. 整体架构

```
┌─────────────┐   选文件 + 客户端校验 ≤4MB
│  DocsView   │ ───────────────────────────────┐
│ (列表/上传)  │                                 │
└──────┬──────┘                                 ▼
       │ 列表       ┌──────────────────────────────────────────┐
       │            │  客户端解析(上传前,一次性):              │
       │            │   .docx → mammoth.convertToHtml           │
       │            │          → 提取 base64 图片 → 转 Blob      │
       │            │   .md   → marked(GFM + KaTeX)             │
       │            └──────────────┬───────────────────────────┘
       │                           │
       │                           ▼  分步上传
       │            ┌──────────────────────────────────────────┐
       │            │  1. 先传图片: POST /api/docs/img          │
       │            │     → 每张图 → docs/img/<hash>.<ext>      │
       │            │     → 返回 public URL(图片需可公开读)     │
       │            │  2. HTML 里把 base64 替换为返回的 URL      │
       │            │  3. 再传文档: POST /api/docs (JSON)        │
       │            │     body: { meta, html } ≤4MB              │
       │            │     Authorization: Bearer <BANK_KEY>       │
       │            └──────────────┬───────────────────────────┘
       │                           ▼
       │            ┌──────────────────────────────────────────┐
       │            │  Vercel Blob                              │
       │            │  docs/manifest.json    (元数据清单)        │
       │            │  docs/doc_<id>.json    ({meta, html})      │
       │            │  docs/img/<hash>.<ext> (public 图片)       │
       │            └──────────────┬───────────────────────────┘
       │                           │
       └──────── list ◀────────────┤  GET /api/docs (开放,返回 manifest)
                                   │
┌──────────────────┐               │  GET /api/docs?id=xxx (开放,返回 {meta, html})
│ DocReaderView    │ ──────────────┘
│ (阅读/渲染)       │
└────────┬─────────┘
         │ 取回 {meta, html}
         │ (HTML 里图片 URL 浏览器自动加载,无需二次请求)
         ▼
┌──────────────────┐
│ IndexedDB        │  docsCache 表:缓存 {id, html, meta}
│ (读缓存,可清理)   │  二次打开:命中缓存则跳过网络,直接 v-html
└──────────────────┘
```

**三层职责分离:**

1. **客户端解析(上传时一次性)** — 复用 mammoth + 新增 marked;提取 docx 图片为 Blob。
2. **云端 (Vercel Blob)** — source of truth,存 HTML 主体 + 图片 + manifest。
3. **阅读页** — 极简,只做 `v-html` 渲染 + 本地缓存读写。

---

## 4. 云端存储设计

### 4.1 Blob 路径布局(独立命名空间,不碰现有 `quizbox/`)

```
docs/manifest.json        ← 文档元数据清单(DocMeta 数组,轻量 JSON)
docs/doc_<id>.json        ← 单个文档主体: { meta, html }
docs/img/<hash>.<ext>     ← 图片(public access,被 HTML 内 <img src> 引用)
```

`<id>` 用 `crypto.randomUUID()` 去横线生成,与 `src/db/index.ts:87` 的 `uid()` 风格一致。
`<hash>` 是图片内容的 sha256,**用于去重**(同一张图被多个文档引用只存一份)。

### 4.2 `docs/manifest.json` 结构

```ts
interface DocsManifest {
  updatedAt: number // 最后更新时间戳
  docs: DocMeta[]
}

interface DocMeta {
  id: string // uuid,同时是 doc_<id>.json 的 id
  name: string // 原始文件名,如 "复习笔记.docx"
  ext: 'docx' | 'md' // 类型(仅用于列表图标展示)
  uploadedAt: number // 上传时间戳
  htmlSize: number // HTML 字节数(用于列表展示大小)
  imageCount: number // 图片数量(用于列表展示)
}
```

### 4.3 新建 `api/docs.ts`(Vercel Serverless Function)

**两个路由前缀,合并在一个 function 内:**

| 操作         | 方法   | 路径               | 鉴权          | 入参                        | 出参                          |
| ------------ | ------ | ------------------ | ------------- | --------------------------- | ----------------------------- |
| 读清单       | GET    | `/api/docs`        | 开放          | —                           | `{ ok, manifest }`            |
| 读文档       | GET    | `/api/docs?id=xxx` | 开放          | `id`                        | `{ ok, doc: { meta, html } }` |
| 上传文档     | POST   | `/api/docs`        | 需 `BANK_KEY` | JSON body: `{ meta, html }` | `{ ok, doc: DocMeta }`        |
| 删除文档     | DELETE | `/api/docs?id=xxx` | 需 `BANK_KEY` | `id`                        | `{ ok }`                      |
| **上传图片** | POST   | `/api/docs/img`    | 需 `BANK_KEY` | multipart: `file`           | `{ ok, url, hash, existed }`  |

**为什么图片走 `/api/docs/img`、文档走 `/api/docs`:**

- 图片是二进制,必须 multipart;HTML 是文本,走 JSON 更简单且可复用 bank.ts 风格。
- 图片上传是「步骤 1」,文档上传是「步骤 2」,两步串行:先传图拿到 URL,再带着 URL 替换后的 HTML 传文档。

**鉴权细节:** 复用 `api/bank.ts:142-147` 的模式 —— 读 `process.env.BANK_KEY`,仅当环境变量存在时校验 `Authorization: Bearer <key>`。

- `/api/docs` GET(读)→ 跳过校验
- `/api/docs` POST/DELETE(写文档)→ 强制校验
- `/api/docs/img` POST(写图片)→ 强制校验
- 未配 `BANK_KEY` 的部署 → 写也开放(与 bank.ts 行为一致)

**图片访问:** 图片 Blob 必须 `access: 'public'`(与 bank.ts 的 `private` 不同),因为浏览器 `<img src>` 直接加载 public URL,不经 serverless 中转。文档主体 Blob 保持 `access: 'private'`(经 serverless 读取)。

**大小约束:**

- 图片单张上限:2 MB(`MAX_IMAGE_BYTES`,防止超大图;正常文档插图远小于此)。
- 文档 HTML body 上限:4 MB(`MAX_REQUEST_BYTES`,与 bank.ts 一致)。
- 整个 multipart 请求体上限:4.5 MB(serverless 硬限制,在收集 body 前拦截)。

**multipart 解析(仅 `/api/docs/img` 用到):** 手写最小 parser,只提取 `file` 字段(单个二进制 + boundary 切分,~40 行)。文档上传走 JSON 不需要 multipart。若实现时发现边界情况复杂(中文文件名编码等),退而引入 `busboy`。

**图片去重:** `/api/docs/img` 收到图片后先算 sha256,若 `docs/img/<hash>.<ext>` 已存在则跳过写入直接返回 `{ existed: true }`。这样新文档引用已有图片时不重复存储。

**并发处理:** manifest 的读-改-写存在竞态(与 `api/bank.ts:259-281` 同类问题)。文档场景并发上传概率极低,采用 **last-write-wins** 客户端重试:上传前先拉 manifest,上传主体成功后重拉最新 manifest → 追加本条 → 回写。若回写期间 manifest 变了,客户端重拉再合并(最多重试 2 次)。

**CORS:** 与 `api/bank.ts:128-132` 一致,同源部署,不开放跨域。

---

## 5. 客户端模块设计

遵循仓库约定:数据访问走 repo、跨组件状态走 store、类型集中放 `types/index.ts`。

### 5.1 新增类型 (`src/types/index.ts` 追加)

```ts
/** 云端文档元数据(manifest 条目) */
export interface DocMeta {
  id: string
  name: string
  ext: 'docx' | 'md'
  uploadedAt: number
  htmlSize: number
  imageCount: number
}

export interface DocsManifest {
  updatedAt: number
  docs: DocMeta[]
}

/** 云端文档主体(GET /api/docs?id=xxx 的响应) */
export interface DocRecord {
  meta: DocMeta
  html: string
}

/** IndexedDB docsCache 表记录 */
export interface DocCacheRecord {
  id: string // 主键,等于 DocMeta.id
  html: string // 渲染好的 HTML(直接可 v-html)
  meta: DocMeta // 快照,便于离线展示列表项
  cachedAt: number
}
```

### 5.2 数据库升级 (`src/db/index.ts`)

bump 到 **version 7**,新增 `docsCache` 表:

```ts
this.version(7).stores({
  docsCache: 'id, cachedAt',
})
```

并在 `QADatabase` 类(`src/db/index.ts:17`)增加 `docsCache!: Table<DocCacheRecord, string>`。

### 5.3 文档缓存 repo (`src/db/docs.ts` 新建)

```ts
// 仅本地读缓存,不参与任何同步
getCache(id): Promise<DocCacheRecord | undefined>
putCache(record): Promise<void>          // 缓存已渲染 HTML
clearCache(id?): Promise<void>           // 清单页提供「清理缓存」入口
```

### 5.4 云端文档 API 客户端 (`src/services/docs-api.ts` 新建)

```ts
/** 上传单张图片,返回 public URL(图片按 hash 去重) */
async function uploadImage(img: Blob): Promise<{ url: string; hash: string }>

/** 上传文档主体:HTML + meta,带 BANK_KEY */
async function uploadDoc(meta: DocMeta, html: string): Promise<DocMeta>

async function listDocs(): Promise<DocsManifest> // GET /api/docs
async function fetchDoc(id: string): Promise<DocRecord> // GET /api/docs?id=xxx
async function deleteDoc(id: string): Promise<void> // DELETE,带 BANK_KEY
```

**BANK_KEY 来源:** 复用 `src/stores/sync.ts` 中已有的从 `syncMeta` 表读取同步配置的机制(避免重复实现)。若未配置 `BANK_KEY`,上传按钮禁用并提示「请在设置页配置同步密钥」。

### 5.5 文档渲染器 (`src/services/doc-render.ts` 新建)—— 仅上传时调用

```ts
interface RenderInput {
  file: File
  /** 图片上传进度回调(用于上传 UI) */
  onImageProgress?: (done: number, total: number) => void
}

interface RenderResult {
  html: string // 图片 URL 已替换完毕,可直接上传/渲染
  meta: {
    // 供构造 DocMeta 用
    imageCount: number
    htmlSize: number
  }
}

/**
 * 解析文档并把图片上传到云端,返回 URL 已替换的 HTML。
 * 仅在上传流调用一次;阅读页不再需要此模块。
 */
async function renderAndUpload(file: File): Promise<RenderResult>
```

**.docx 分支:**

- 复用 `mammoth.convertToHtml({ arrayBuffer })`(已在 `docx-parser.ts:19` 验证可用)。
- mammoth 输出的 HTML 里图片是 `data:image/...;base64,...` 内联形式。
- 用正则提取所有 base64 图片 → 每张转 Blob → `docs-api.uploadImage(blob)` 拿到 public URL → 把 HTML 里的 base64 替换成 URL。
- 与题库导入版(`docx-parser.ts:38-41`)的差异:**保留图片**(题库导入把图片替换成 `[IMG_n]` 占位,这里保留为真实 `<img src>`),且**上传到云端**。

**.md 分支(新增能力):**

- 新增依赖 **`marked`**(轻量 GFM,~30 KB gzip)。
- `marked.parse(text, { gfm: true, breaks: true })`。
- 数学公式:复用项目已有的 KaTeX 能力(题库 RichText.vue 已用),对 `$...$` / `$$...$$` 做后处理渲染。
- md 通常无内联图片;若有 `![](data:...)` 内联图片,同样走上传替换流程(罕见,但仍处理)。
- md 引用的本地图片路径(`./xxx.png`)无法解析(源文件不在),保持原样或提示 —— 本期不处理,属于已知限制。

**错误处理:** 解析失败(mammoth 抛错 / md 语法错)直接抛出,DocsView 捕获后 Toast「文档格式无法解析」,**不进入上传流程**。这比「存源文件后阅读时才发现损坏」体验更好。

### 5.6 Pinia store (`src/stores/docs.ts` 新建,Options 风格)

```ts
export const useDocsStore = defineStore('docs', {
  state: () => ({
    list: [] as DocMeta[],
    loading: false,
    current: null as DocRecord | null,
  }),
  actions: {
    async loadList()                 // 拉云端 manifest → 写 state.list
    async upload(file: File)         // renderAndUpload → uploadDoc → putCache → loadList
    async remove(id: string)         // deleteDoc → 删本地缓存 → loadList
    async open(id: string)           // fetchDoc(或命中缓存) → 写 current
    async clearCache(id?: string)    // 清本地缓存
  },
})
```

---

## 6. UI 设计

### 6.1 `src/views/DocsView.vue` — 文档列表页

- `defineOptions({ name: 'DocsView' })`(keep-alive 依赖)。
- 路由 `/docs`,`meta: { title: '资料', tabbar: true }`。
- 顶部:`<van-uploader :after-read="onUpload" :max-size="4*1024*1024" accept=".docx,.md" :max-count="1">` + `@oversize` Toast「文件超过 4 MB 限制」。
- 上传过程 UI:由于上传需「解析 + 传图片 + 传文档」多步,展示 `<van-loading>` + 进度文案(「解析中…」「上传图片 3/5…」「保存中…」),复用 `onImageProgress` 回调。
- 列表:`<van-swipe-cell>` + `<van-cell>`,每项展示文件名 / 类型图标(`description-o` for md,`description` for docx)/ HTML 大小(fmtSize)/ 图片数 / 上传时间。
- 左滑删除:调用 `guardedAction(() => store.remove(id))`(复用 `useAdminStore` 的管理员校验,与题库删除语义一致)。
- 下拉刷新 `<van-pull-refresh>`:重新 `loadList()`。
- 空态:`<van-empty description="还没有资料,点击上方上传你的第一份文档">`。

### 6.2 `src/views/DocReaderView.vue` — 阅读页

- `defineOptions({ name: 'DocReaderView' })`。
- 路由 `/docs/:id`(无 `tabbar: true`,阅读时隐藏 tabbar)。
- 顶部 `<van-nav-bar :title="meta.name" left-arrow @click-left="router.back()">`。
- 内容区:`<div class="doc-prose" v-html="current.html">`,样式复用题库 `RichText.vue` 的 prose 排版 + KaTeX。
- 加载态:`<van-loading>`(只等待网络取 HTML,通常 < 200ms;命中缓存则无等待)。
- **无下载按钮**(符合「不开放下载」要求)。
- HTML 里图片通过 public URL 加载,浏览器自动并行请求,无需额外逻辑。

### 6.3 tabbar 集成 (`src/App.vue:29`)

`navItems` 从 3 项扩为 4 项:

```ts
const navItems = [
  { name: 'home', label: '首页', icon: 'wap-home-o' },
  { name: 'library', label: '题库', icon: 'bookmark-o' },
  { name: 'docs', label: '资料', icon: 'description-o' }, // 新增
  { name: 'settings', label: '设置', icon: 'setting-o' },
]
```

桌面端侧边栏 `src/App.vue:96` 同步增加一项。

---

## 7. 数据流详解

### 7.1 上传流(核心,多步)

```
用户选文件(≤4MB)
  → DocsView.onUpload(file)
  → 客户端校验 size(oversize 已拦)
  → store.upload(file):
      1. doc-render.renderAndUpload(file):
         a. 解析(.docx → mammoth / .md → marked)
         b. 提取内联 base64 图片 → 转 Blob
         c. 逐张 docs-api.uploadImage(blob):
            - POST /api/docs/img (multipart, Bearer BANK_KEY)
            - 服务端算 hash,若 docs/img/<hash>.<ext> 已存在则跳过(去重)
            - 返回 public URL
         d. HTML 里把 base64 替换为返回的 URL
         e. 返回 { html, meta: { imageCount, htmlSize } }
      2. 构造完整 DocMeta = { id: uid(), name, ext, uploadedAt: Date.now(), ...meta }
      3. docs-api.uploadDoc(meta, html):
         - POST /api/docs (JSON: { meta, html }, Bearer BANK_KEY)
         - 服务端:校验 body ≤4MB → put(docs/doc_<id>.json) → 读 manifest → 追加 → 写 manifest
      4. docs.putCache({ id, html, meta, cachedAt })  // 顺手缓存
      5. store.loadList() 刷新列表
```

**关键时序:** 图片必须**先于**文档上传,因为文档 HTML 里要包含图片的最终 URL。若某张图片上传失败,整个上传流中止,已上传的图片成为孤儿(无引用)—— 这是可接受的(图片去重机制下,孤儿图片不占额外空间语义,定期清理可选,本期 YAGNI)。

### 7.2 打开阅读流(极简)

```
用户点列表项 → router.push('/docs/<id>')
  → DocReaderView.onMounted
  → store.open(id):
      1. cacheRepo.getCache(id) → 命中? 直接用缓存 html
         否则 docs-api.fetchDoc(id) → 写缓存
      2. state.current = { meta, html }
  → v-html 渲染(浏览器自动加载 <img src> 指向的图片)
```

**与旧架构对比:** 旧架构(存源文件)阅读时需 `fetchDocBlob → renderDoc → 缓存`,有解析延迟;新架构阅读只有 `fetchDoc → 缓存`,零解析。

### 7.3 删除流

```
用户左滑删除 → guardedAction(管理员校验)
  → store.remove(id):
      1. docs-api.deleteDoc(id) (Bearer BANK_KEY)
         服务端:del(docs/doc_<id>.json) → 读 manifest → 移除条目 → 写 manifest
      2. cacheRepo.clearCache(id)
      3. store.loadList() 刷新
```

**注意:** 删除文档**不删图片**。图片按 hash 去重,可能被多个文档引用,贸然删会导致其他文档图片失效。孤儿图片清理属于未来增强(本期 YAGNI)。

---

## 8. 错误处理矩阵

| 场景                          | 客户端表现                                      | 备注                                  |
| ----------------------------- | ----------------------------------------------- | ------------------------------------- |
| 文件 > 4 MB                   | Toast「文件超过 4 MB 限制」,不发请求            | `van-uploader` `@oversize`            |
| BANK_KEY 未配置               | 上传按钮置灰 + 提示「请在设置页配置同步密钥」   | 与同步功能前置条件一致                |
| 解析失败(mammoth/marked 抛错) | Toast「文档格式无法解析」,不进入上传            | 上传时即暴露问题,优于阅读时才发现     |
| 单张图片 > 2 MB               | 该图片上传被服务端拒(413)→ 整个上传中止 + Toast | 防止超大图;正常插图远小于此           |
| 文档 HTML body > 4 MB         | 上传被服务端拒(413)→ Toast「渲染产物过大」      | 极少见;.md 几乎不可能,docx 纯文本也够 |
| 图片上传部分失败              | 整个上传中止 + Toast「图片上传失败」            | 已传图片成孤儿(可接受,见 §7.1)        |
| 上传 401(密钥错)              | Toast「同步密钥不正确」                         |                                       |
| 上传 500 / 网络错             | Toast「上传失败,请重试」                        |                                       |
| 拉清单失败                    | 列表展示上次缓存(若有)+ 下拉刷新提示            | store.list 失败不清空旧值             |
| 打开文档 - 取 HTML 失败       | Toast「无法获取文档,请检查网络」                | 命中本地缓存则不受影响                |
| manifest 并发冲突             | 客户端重拉合并重试(最多 2 次)                   | last-write-wins                       |

---

## 9. 依赖变更

**新增 (package.json):**

- `marked` — Markdown → HTML 渲染(~30 KB gzip,GFM + breaks)

**复用已有(无需新增):**

- `mammoth` ^1.8.0 — docx 解析(已在 `package.json`)
- `@vercel/blob` — 服务端存储(已在 `package.json`)
- `dexie` ^4 — IndexedDB ORM(已在 `package.json`)
- KaTeX — 数学公式(题库已集成,复用配置)
- `src/utils/hash.ts` 的 `sha256`

**不引入:**

- ❌ `markdown-it`(marked 更轻够用)
- ❌ `docx-preview`(不做高保真还原)
- ❌ 任何测试框架(遵循 AGENTS.md §0 硬规则)

---

## 10. 受影响文件清单

### 新建(7 个)

| 文件                          | 职责                                                    |
| ----------------------------- | ------------------------------------------------------- |
| `api/docs.ts`                 | Vercel serverless:文档 CRUD + 图片上传 + multipart 解析 |
| `src/db/docs.ts`              | docsCache 表 repo                                       |
| `src/services/docs-api.ts`    | 云端文档/图片 API 客户端                                |
| `src/services/doc-render.ts`  | 上传时的「解析 + 图片上传 + URL 替换」一体化渲染器      |
| `src/stores/docs.ts`          | Pinia store                                             |
| `src/views/DocsView.vue`      | 文档列表页                                              |
| `src/views/DocReaderView.vue` | 阅读页                                                  |

### 修改(4 个)

| 文件                  | 改动                                                             |
| --------------------- | ---------------------------------------------------------------- |
| `src/db/index.ts`     | bump version 7 + `docsCache` 表 + 类字段                         |
| `src/types/index.ts`  | 追加 `DocMeta` / `DocsManifest` / `DocRecord` / `DocCacheRecord` |
| `src/router/index.ts` | 新增 `/docs`、`/docs/:id` 路由                                   |
| `src/App.vue`         | `navItems` 增加 docs 项(移动端 tabbar + 桌面端侧边栏)            |

### 不触碰

- `src/services/sync.ts`、`api/bank.ts`、`src/services/file-parser.ts`、`src/services/docx-parser.ts`、`ImportView.vue` — **题库链路完全不动**。

---

## 11. 验收标准

遵循 AGENTS.md §8,实现完成后必须通过:

```bash
npm run type-check   # exit 0
npm run build        # exit 0
npm run lint         # 0 error
```

功能验收(手动):

1. 在「资料」tab 上传一个 < 4 MB 的 .md → 列表出现该文档,imageCount=0。
2. 上传一个带图片的 .docx → 图片单独上传到 `docs/img/`,HTML 内 `<img src>` 指向 public URL,阅读时图片正常显示。
3. 上传一个 > 4 MB 文件 → 被拦截,提示超限。
4. 点开 .md 文档 → 正确渲染 GFM(标题/列表/代码块/表格)+ KaTeX 公式。
5. 点开 .docx 文档 → 正确渲染语义化 HTML(标题/段落/表格/加粗)+ 图片。
6. 二次打开同一文档 → 走缓存,无网络请求,瞬间显示。
7. 左滑删除(需管理员密码)→ 列表移除,本地缓存清除(图片不删)。
8. 未配 BANK_KEY 时上传 → 按钮置灰 + 引导提示。
9. 上传一个损坏的 docx → 上传时即提示「文档格式无法解析」,不进入上传流程。

---

## 12. 风险与遗留

- **Vercel Blob 免费档容量**:免费档有存储容量与带宽限制。图片 + HTML 累积可能触发额度。当前不设服务端配额,后续可在 manifest 加 `totalSize` 统计并在设置页展示。
- **孤儿图片**:上传失败 / 文档删除时,已上传的图片不会被清理。图片按 hash 去重降低了空间浪费,但长期累积可能需要清理脚本(本期 YAGNI)。
- **multipart 手写解析的健壮性**:`/api/docs/img` 手写最小 parser;若边界情况多(中文文件名编码等),退而引入 `busboy`。实现时根据实际复杂度二选一。
- **md 本地图片引用**:`![](./local.png)` 这类本地路径无法解析(源文件不在),保持原样显示为破图。属已知限制,本期不处理。
- **manifest 并发**:last-write-wins + 客户端重试,文档场景足够。若未来文档量爆发再考虑服务端乐观锁(类似 bank.ts 的 baseManifestUpdatedAt)。
- **图片 public URL 可被外链**:图片 Blob 是 public access,理论上知道 URL 的人可直接访问。这与「不开放下载」的语义略有张力 —— 但图片不是完整文档,且 URL 含 hash 难以遍历,风险可接受。若需严格私密,需改用 serverless 中转读图(代价是阅读页每张图都要经 serverless,性能下降)。
