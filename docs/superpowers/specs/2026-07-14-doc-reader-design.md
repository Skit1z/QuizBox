# 文档资料阅读器 设计文档

**日期**: 2026-07-14
**状态**: 待实现
**分支**: dev

---

## 1. 目标与范围

为 QuizBox 题库系统新增一条**与题库完全独立**的「文档资料阅读」链路:

- 用户可在网页中上传 `.docx` / `.md` 文件(单文件 ≤ 4 MB)。
- 文档主存于 **Vercel Blob(云端,全局共享)**,用户每次打开时从云端取回原始文件并**在浏览器端解析渲染**为可读 HTML。
- 本地 IndexedDB 可选缓存原始文件,加速二次打开。
- **不开放下载**(无下载按钮、不提供原文件外链)。
- 提供独立的「资料」入口(tabbar 新增 tab)+ 文档列表页 + 阅读页。

### 不在本期范围内(YAGNI)

- ❌ 不做文档转题库(题库导入链路保持现状,不被本功能触碰)。
- ❌ 不做按设备/按用户隔离(全局共享,与现有题库同步的共享语义一致)。
- ❌ 不做文档分类、文件夹、标签、全文搜索(列表页只做按时间倒序 + 文件名展示)。
- ❌ 不做 Tauri 桌面端原生文件读写(两端能力等价,都走浏览器 `File` API)。
- ❌ 不做 PDF 支持(现有 pdf-parser 依赖远程 PaddleOCR,与「资料阅读」语义不符)。

---

## 2. 关键决策记录

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 核心用途 | 纯资料阅读器 | 与题库导入解耦,范围清晰 |
| 文件上限 | **4 MB** | 避开 Vercel serverless 4.5 MB 请求体硬限制;.md 几乎不超,docx 纯文本也基本够 |
| 上传编码 | **multipart/form-data** 直传二进制 | base64 会膨胀 33% 导致 4 MB → 5.3 MB 超限;multipart 无膨胀 |
| 主存储 | Vercel Blob(云端) | 用户指定:云端为 source of truth,本地仅做读缓存 |
| 鉴权 | **写需 `BANK_KEY` token,读开放** | 复用现有 `api/bank.ts` 的 `BANK_KEY` 机制;防陌生人乱写,但允许任何人查看(与题库默认开放查看一致) |
| 入口位置 | tabbar 新增「资料」tab | 作为核心功能,一级入口最易发现;tabbar 从 3 项变 4 项 |
| docx 渲染 | 简洁语义化 HTML(复用 mammoth) | 阅读体验干净统一,加载快;不做高保真还原(避免引入 docx-preview ~500 KB) |
| 多用户隔离 | 全局共享 | 与题库同步的共享语义一致 |
| 下载 | 不开放 | 用户明确要求 |

---

## 3. 整体架构

```
┌─────────────┐   选文件 + 客户端校验 ≤4MB
│  DocsView   │ ───────────────────────────────┐
│ (列表/上传)  │                                 │
└──────┬──────┘                                 ▼
       │ 列表       ┌──────────────────────────────────┐
       │            │  POST /api/docs  (multipart)      │
       │            │  Authorization: Bearer <BANK_KEY> │
       │            │  body: file 二进制 + meta JSON     │
       │            └──────────────┬───────────────────┘
       │                           ▼
       │            ┌──────────────────────────────────┐
       │            │  Vercel Blob                      │
       │            │  docs/manifest.json  (元数据清单)  │
       │            │  docs/<docId>.bin    (原始二进制)   │
       │            └──────────────┬───────────────────┘
       │                           │
       └──────── list ◀────────────┤  GET /api/docs (开放)
                                   │
┌──────────────────┐               │  GET /api/docs?id=xxx (开放)
│ DocReaderView    │ ──────────────┘
│ (阅读/渲染)       │
└────────┬─────────┘
         │ 取回原始 Blob
         ▼
┌──────────────────┐
│ doc-render.ts    │  .docx → mammoth.convertToHtml (简洁语义化)
│ (浏览器端解析)    │  .md   → marked (GFM + KaTeX)
└────────┬─────────┘
         │ 渲染出 HTML
         ▼
┌──────────────────┐
│ IndexedDB        │  docsCache 表:缓存 {id, blob, hash, cachedAt, meta}
│ (读缓存,可清理)   │  二次打开:命中缓存则跳过网络
└──────────────────┘
```

**三层职责分离:**
1. **云端 (Vercel Blob)** — 唯一 source of truth,存原始文件 + 清单。
2. **客户端解析 (`doc-render.ts`)** — 复用已有 mammoth,新增 marked 做 markdown 渲染。
3. **本地缓存 (IndexedDB `docsCache` 表)** — 只读缓存,可随时清空重建,非持久化义务。

---

## 4. 云端存储设计

### 4.1 Blob 路径布局(独立命名空间,不碰现有 `quizbox/`)

```
docs/manifest.json     ← 文档元数据清单(DocMeta 数组,轻量 JSON,无大小问题)
docs/<docId>.bin       ← 原始文件二进制(docx 或 md)
```

`<docId>` 用 `crypto.randomUUID()` 去横线生成,与 `src/db/index.ts:87` 的 `uid()` 风格一致。

### 4.2 `docs/manifest.json` 结构

```ts
interface DocsManifest {
  updatedAt: number        // 最后更新时间戳,用于客户端增量判断
  docs: DocMeta[]
}

interface DocMeta {
  id: string               // uuid,同时是 blob 文件名
  name: string             // 原始文件名,如 "复习笔记.docx"
  ext: 'docx' | 'md'       // 类型(用于分发渲染器)
  size: number             // 原始字节数
  contentHash: string      // sha256(原始文件),用于本地缓存校验
  uploadedAt: number       // 上传时间戳
}
```

### 4.3 新建 `api/docs.ts`(Vercel Serverless Function)

**关键约束:** Vercel serverless 请求体默认上限 4.5 MB,与我们的 4 MB 文件上限 + multipart 编码兼容(multipart 边界开销可忽略)。

**端点设计:**

| 操作 | 方法 | 鉴权 | 入参 | 出参 |
|------|------|------|------|------|
| 读清单 | `GET /api/docs` | 开放 | — | `{ ok, manifest }` |
| 读单文档 | `GET /api/docs?id=xxx` | 开放 | `id` | 二进制流(`Content-Type` 按 ext 设置) |
| 上传文档 | `POST /api/docs` | 需 `BANK_KEY` | multipart: `file` + `meta`(JSON 字段) | `{ ok, doc: DocMeta }` |
| 删除文档 | `DELETE /api/docs?id=xxx` | 需 `BANK_KEY` | `id` | `{ ok }` |

**鉴权细节:** 复用 `api/bank.ts:142-147` 的模式 —— 读取 `process.env.BANK_KEY`,仅当环境变量存在时校验 `Authorization: Bearer <key>`。写操作(POST/DELETE)强制校验,读操作(GET)跳过。这样:
- 未配 `BANK_KEY` 的部署 → 写也开放(与 bank.ts 行为一致)
- 配了 `BANK_KEY` → 写受保护、读开放(符合用户决策)

**multipart 解析:** serverless 默认不解析 multipart。方案:在 `api/docs.ts` 内用 `await new Promise(resolve => { let data=''; req.on('data',c=>data+=c); req.on('end',resolve)})` 收集原始 body,再按 boundary 手工切分(或引入轻量库 `@fastify/multipart` 的解析逻辑 —— 但为避免新增依赖,**优先手写一个最小 multipart parser**,因为只需要提取一个 `file` 字段和一个 `meta` 字段)。`MAX_REQUEST_BYTES = 4 * 1024 * 1024` 在收集前拦截。

**并发处理:** manifest 的读-改-写存在竞态(与 `api/bank.ts:259-281` 同类问题)。文档场景并发上传概率极低,采用 **last-write-wins** 客户端重试:上传前先拉 manifest,上传文件成功后重拉最新 manifest → 追加本条 → 回写。若回写期间 manifest 变了,客户端重拉再合并(最多重试 2 次)。

**CORS:** 与 `api/bank.ts:128-132` 一致,同源部署,不开放跨域。

### 4.4 文件大小校验(双重)

- **客户端**(`DocsView.vue`):`<van-uploader :max-size="4 * 1024 * 1024" @oversize="...">`,超限直接 Toast,不发请求。
- **服务端**(`api/docs.ts`):`Buffer.byteLength(body) > MAX_REQUEST_BYTES` → 413。

---

## 5. 客户端模块设计

遵循仓库约定:数据访问走 repo、跨组件状态走 store、类型集中放 `types/index.ts`。

### 5.1 新增类型 (`src/types/index.ts` 追加)

```ts
export interface DocMeta {
  id: string
  name: string
  ext: 'docx' | 'md'
  size: number
  contentHash: string
  uploadedAt: number
}

export interface DocsManifest {
  updatedAt: number
  docs: DocMeta[]
}

/** IndexedDB docsCache 表记录 */
export interface DocCacheRecord {
  id: string            // 主键,等于 DocMeta.id
  blob: Blob            // 原始文件二进制(未解析)
  contentHash: string   // 用于校验缓存是否过期
  cachedAt: number
  meta: DocMeta         // 快照,便于离线展示列表项
}
```

### 5.2 数据库升级 (`src/db/index.ts`)

bump 到 **version 7**,新增 `docsCache` 表:

```ts
this.version(7).stores({
  docsCache: 'id, contentHash, cachedAt',
})
```

并在 `QADatabase` 类增加 `docsCache!: Table<DocCacheRecord, string>`(`src/db/index.ts:17`)。

### 5.3 文档缓存 repo (`src/db/docs.ts` 新建)

```ts
// 仅本地读缓存,不参与任何同步
getCache(id): Promise<DocCacheRecord | undefined>
putCache(record): Promise<void>          // 缓存原始 Blob
isCacheFresh(id, contentHash): Promise<boolean>
clearCache(id?): Promise<void>           // 清单页提供「清理缓存」入口
```

### 5.4 云端文档 API 客户端 (`src/services/docs-api.ts` 新建)

```ts
const PREFIX = '/api/docs'

/** 上传:multipart 直传,带 BANK_KEY */
async function uploadDoc(file: File): Promise<DocMeta>
//   - 用 utils/hash.ts 的 sha256 算 contentHash
//   - FormData: { file, meta: JSON.stringify({...}) }
//   - Authorization: Bearer <BANK_KEY>  (BANK_KEY 从 syncMeta 表读取,复用 sync.ts 的读取逻辑)

async function listDocs(): Promise<DocsManifest>          // GET /api/docs
async function fetchDocBlob(id: string): Promise<Blob>    // GET /api/docs?id=xxx → response.blob()
async function deleteDoc(id: string): Promise<void>       // DELETE,带 BANK_KEY
```

**BANK_KEY 来源:** 复用 `src/stores/sync.ts` 中已有的从 `syncMeta` 表读取同步配置的机制(避免重复实现)。若未配置 `BANK_KEY`,上传按钮禁用并提示「请在设置页配置同步密钥」。

### 5.5 文档渲染器 (`src/services/doc-render.ts` 新建)

```ts
interface RenderResult {
  html: string        // 可直接 v-html 渲染的 HTML
  title: string       // 从内容提取的标题(md 取首个 # ;docx 取首个 h1/h2,无则用文件名)
}

async function renderDoc(file: Blob, ext: 'docx' | 'md'): Promise<RenderResult>
```

**.docx 分支:**
- 复用 `mammoth.convertToHtml({ arrayBuffer })`(已在 `docx-parser.ts:19` 验证可用)。
- 与题库导入版的差异:**保留完整 HTML**(不把图片替换成 `[IMG_n]` 占位、不做 `htmlToText` 净化),因为目标是阅读而非切题。图片 base64 直接内联保留。
- mammoth 输出的是简洁语义化 HTML(h1-h6 / p / ul / ol / table / strong / em),阅读体验干净。

**.md 分支(新增能力):**
- 新增依赖 **`marked`**(轻量、零配置 GFM,~30 KB gzip)。
- 渲染管线:`marked.parse(text, { gfm: true, breaks: true })`。
- 数学公式:复用项目已有的 KaTeX 能力(题库 RichText.vue 已用),对 `$...$` / `$$...$$` 做后处理渲染。
- **不引入** `markdown-it`(marked 更轻、API 更简、够用)。

### 5.6 Pinia store (`src/stores/docs.ts` 新建,Options 风格)

```ts
export const useDocsStore = defineStore('docs', {
  state: () => ({
    list: [] as DocMeta[],
    loading: false,
    current: null as { meta: DocMeta; html: string; title: string } | null,
  }),
  actions: {
    async loadList()                 // 拉云端 manifest → 写 state.list
    async upload(file: File)         // sha256 → uploadDoc → putCache → loadList 刷新
    async remove(id: string)         // deleteDoc → 删本地缓存 → loadList
    async open(id: string)           // fetchDocBlob(或命中缓存) → renderDoc → 写 current
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
- 列表:`<van-swipe-cell>` + `<van-cell>`,每项展示文件名 / 类型图标(`description-o` for md,`description` for docx)/ 大小(fmtSize 复用 ImportView 的实现)/ 上传时间。
- 左滑删除:调用 `guardedAction(() => store.remove(id))`(复用 `useAdminStore` 的管理员校验,与题库删除语义一致)。
- 下拉刷新 `<van-pull-refresh>`:重新 `loadList()`。
- 空态:`<van-empty description="还没有资料,点击上方上传你的第一份文档">`。

### 6.2 `src/views/DocReaderView.vue` — 阅读页

- `defineOptions({ name: 'DocReaderView' })`。
- 路由 `/docs/:id`(无 `tabbar: true`,阅读时隐藏 tabbar)。
- 顶部 `<van-nav-bar :title="meta.name" left-arrow @click-left="router.back()">`。
- 内容区:`<div class="doc-prose" v-html="current.html">`,样式复用题库 `RichText.vue` 的 prose 排版 + KaTeX。
- 加载态:`<van-loading>`(解析 docx 需要数百 ms,大文件可能更久)。
- **无下载按钮**(符合「不开放下载」要求)。
- 解析失败 catch → `<van-empty description="文档格式无法解析">`。

### 6.3 tabbar 集成 (`src/App.vue:29`)

`navItems` 从 3 项扩为 4 项:

```ts
const navItems = [
  { name: 'home', label: '首页', icon: 'wap-home-o' },
  { name: 'library', label: '题库', icon: 'bookmark-o' },
  { name: 'docs', label: '资料', icon: 'description-o' },   // 新增
  { name: 'settings', label: '设置', icon: 'setting-o' },
]
```

桌面端侧边栏 `src/App.vue:96` 同步增加一项。

---

## 7. 数据流详解

### 7.1 上传流

```
用户选文件
  → DocsView.onUpload(file)
  → 客户端校验 size ≤ 4MB(oversize 已拦)
  → docs-api.uploadDoc(file):
      1. sha256(file) → contentHash
      2. 构造 meta = { id: uid(), name, ext, size, contentHash, uploadedAt: Date.now() }
      3. POST /api/docs (multipart: file + meta, Bearer BANK_KEY)
      4. 服务端:校验 size → put(docs/<id>.bin) → 读 manifest → 追加 → 写 manifest
  → docs.putCache({ id, blob: file, contentHash, cachedAt, meta })  // 顺手缓存
  → store.loadList() 刷新列表
```

### 7.2 打开阅读流

```
用户点列表项 → router.push('/docs/<id>')
  → DocReaderView.onMounted
  → store.open(id):
      1. cacheRepo.getCache(id) → 命中且 contentHash 匹配? 用缓存 blob
         否则 fetchDocBlob(id) → 写缓存
      2. renderDoc(blob, ext) → { html, title }
      3. state.current = { meta, html, title }
  → 渲染
```

### 7.3 删除流

```
用户左滑删除 → guardedAction(管理员校验)
  → store.remove(id):
      1. docs-api.deleteDoc(id) (Bearer BANK_KEY)
         服务端:del(docs/<id>.bin) → 读 manifest → 移除条目 → 写 manifest
      2. cacheRepo.clearCache(id)
      3. store.loadList() 刷新
```

---

## 8. 错误处理矩阵

| 场景 | 客户端表现 | 备注 |
|------|-----------|------|
| 文件 > 4 MB | Toast「文件超过 4 MB 限制」,不发请求 | `van-uploader` `@oversize` |
| BANK_KEY 未配置 | 上传按钮置灰 + 提示「请在设置页配置同步密钥」 | 与同步功能前置条件一致 |
| 上传 401(密钥错) | Toast「同步密钥不正确」 | |
| 上传 413 | Toast「文件超过服务端限制」 | 双重校验兜底 |
| 上传 500 / 网络错 | Toast「上传失败,请重试」,保留已缓存内容 | |
| 拉清单失败 | 列表展示上次缓存(若有)+ 下拉刷新提示 | store.list 失败不清空旧值 |
| 打开文档 - 取文件失败 | Toast「无法获取文档,请检查网络」 | |
| 打开文档 - 解析失败 | 展示 `<van-empty>`「文档格式无法解析」 | catch mammoth/marked 异常 |
| manifest 并发冲突 | 客户端重拉合并重试(最多 2 次) | last-write-wins |

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
| 文件 | 职责 |
|------|------|
| `api/docs.ts` | Vercel serverless:文档 CRUD + multipart 解析 |
| `src/db/docs.ts` | docsCache 表 repo |
| `src/services/docs-api.ts` | 云端文档 API 客户端 |
| `src/services/doc-render.ts` | docx/md → HTML 渲染器 |
| `src/stores/docs.ts` | Pinia store |
| `src/views/DocsView.vue` | 文档列表页 |
| `src/views/DocReaderView.vue` | 阅读页 |

### 修改(4 个)
| 文件 | 改动 |
|------|------|
| `src/db/index.ts` | bump version 7 + `docsCache` 表 + 类字段 |
| `src/types/index.ts` | 追加 `DocMeta` / `DocsManifest` / `DocCacheRecord` |
| `src/router/index.ts` | 新增 `/docs`、`/docs/:id` 路由 |
| `src/App.vue` | `navItems` 增加 docs 项(移动端 tabbar + 桌面端侧边栏) |

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
1. 在「资料」tab 上传一个 < 4 MB 的 .md → 列表出现该文档。
2. 上传一个 > 4 MB 文件 → 被拦截,提示超限。
3. 点开 .md 文档 → 正确渲染 GFM(标题/列表/代码块/表格)+ KaTeX 公式。
4. 点开 .docx 文档 → 正确渲染语义化 HTML(标题/段落/表格/加粗)。
5. 二次打开同一文档 → 走缓存,秒开(断网也能打开)。
6. 左滑删除(需管理员密码)→ 列表移除,本地缓存清除。
7. 未配 BANK_KEY 时上传 → 按钮置灰 + 引导提示。

---

## 12. 风险与遗留

- **Vercel Blob 免费档容量**:免费档有存储容量与带宽限制。若用户大量上传大 docx 可能触发额度。当前不设服务端配额,后续可在 manifest 加 `totalSize` 统计并在设置页展示。
- **multipart 手写解析的健壮性**:优先手写最小 parser(只取 file + meta 两字段);若边界情况多(中文文件名编码等),可退而引入 `busboy`(Node 标准 multipart parser,~无依赖)。实现时根据实际复杂度二选一。
- **manifest 并发**:last-write-wins + 客户端重试,文档场景足够。若未来文档量爆发再考虑服务端乐观锁(类似 bank.ts 的 baseManifestUpdatedAt)。
