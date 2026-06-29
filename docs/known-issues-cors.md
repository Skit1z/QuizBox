# 待解决：OCR / WebDAV 跨域(CORS)失败

> 状态：**待处理**（已定位根因，未修复）
> 现象：设置页测试时——OCR 报「网络连接失败」，WebDAV 报「地址不存在：请检查服务器地址」。
> 影响环境：桌面端 (Tauri) 与 网页端 都受影响。

---

## 根因

两个第三方服务都**不支持浏览器跨域 (CORS)**，实测（带 Origin 头 curl）：

| 服务 | 预检 (OPTIONS) | `Access-Control-Allow-Origin` |
|---|---|---|
| PaddleOCR `paddleocr.aistudio-app.com` | 403 Forbidden | **无** |
| 坚果云 WebDAV `dav.jianguoyun.com` | 401 | **无** |

所以浏览器 / WebView 里的 `fetch()` 直连必被 CORS 拦截抛错。

- **WebDAV「地址不存在」**：代码本有绕过 CORS 的代理 `/api/webdav`（`src/services/sync.ts` → `resolveWebdavEndpoint`），
  但它是 **Vercel serverless 函数**（`api/webdav/[...path].ts`）。报 404 说明请求打到 `/api/webdav`
  却没有这个函数 → 当前未跑在 Vercel（桌面端 / 自部署静态站都没有该路由）。
  404 被 `src/views/SettingsView.vue:114` 归类为「地址不存在」。
- **OCR「网络连接失败」**：OCR **完全没有代理**，`src/services/pdf-parser.ts` 与设置页测试都是直连
  paddleocr → 任何浏览器/WebView 都被 CORS 拦死 → `fetch` 抛错 → `SettingsView.vue:166` catch。

## 隐藏 bug：Tauri v2 环境误判（必先修）

`src/services/sync.ts:29` 的 `isWebEnv()` 用 `window.__TAURI__` 判断环境，但 **Tauri v2 默认不注入
该全局**（`tauri.conf.json` 未设 `app.withGlobalTauri: true`）。
→ 即使跑桌面端，`isWebEnv()` 也误判为网页 → WebDAV 硬走 `/api/webdav` → 桌面端无此路由 → 404。
**不修这条，桌面端永远走错分支。**

修法二选一：
- `isWebEnv()` 改为检测 `(window as any).__TAURI_INTERNALS__`（v2 全局），或
- `tauri.conf.json` 加 `"app": { "withGlobalTauri": true }` 让 `window.__TAURI__` 恢复存在。

---

## 修复路线（覆盖两端）

### 桌面端 (Tauri) —— 推荐，最干净
用 `@tauri-apps/plugin-http` 在 Rust 侧发请求，**天然无 CORS**，OCR + WebDAV + 结果/图片下载一次解决。
1. 加 JS `@tauri-apps/plugin-http` + Rust `tauri-plugin-http`；在 capabilities 允许
   `paddleocr.aistudio-app.com`、`dav.jianguoyun.com`（及 OCR 结果/图片所在域）。
2. 抽 `appFetch(url, opts)`：是 Tauri → 用插件 `fetch`；否则原生 `fetch` + 代理。
3. `pdf-parser.ts`（提交 job / 轮询 / 下载 JSONL / 下载图片）与 `sync.ts` 改用 `appFetch`。

### 网页端 —— 补代理（OCR 目前完全没有代理）
- WebDAV 代理 `/api/webdav` 已存在，但**必须部署在 serverless 平台**（Vercel/Netlify）才生效。
- **新增 OCR 代理 `/api/ocr`**：需代理整条链——提交 job、轮询状态、下载结果 JSONL、下载图片。
- 若坚持挂 **aliyun 静态 nginx**：serverless 跑不了，需用 nginx `proxy_pass` 反代上述两个域并注入
  CORS 头（运维配置，非前端代码）。

### 现实建议
OCR 在网页端本质很麻烦（要代理整条下载链）。最省力组合：
- **PDF/OCR 导入只在桌面端做**（plugin-http 直连，零成本）；
- 网页端把 WebDAV 代理部署到位（Vercel，或 aliyun 配 nginx 反代）即可。

---

## 顺带（非本问题，但相关）
`api/webdav/[...path].ts` 的 `isAllowed()` 结尾有 `|| true`，使域名白名单形同虚设（开放代理/SSRF
风险）。修 CORS 时一并收紧。

## 涉及文件
- `src/services/sync.ts`（isWebEnv、resolveWebdavEndpoint）
- `src/services/pdf-parser.ts`（OCR 全链路 fetch）
- `src/views/SettingsView.vue`（错误文案 114 / 166）
- `api/webdav/[...path].ts`（代理 + 白名单 bug）
- `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（plugin-http 依赖与 capabilities）
