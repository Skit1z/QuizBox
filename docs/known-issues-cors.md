# 待解决：OCR 跨域(CORS)失败

> 状态：**待处理**（已定位根因，未修复）
> 现象：设置页测试 OCR 时报「网络连接失败」。
> 影响环境：桌面端 (Tauri) 与 网页端 都受影响。

---

## 根因

PaddleOCR 服务**不支持浏览器跨域 (CORS)**，实测（带 Origin 头 curl）：

| 服务                                   | 预检 (OPTIONS) | `Access-Control-Allow-Origin` |
| -------------------------------------- | -------------- | ----------------------------- |
| PaddleOCR `paddleocr.aistudio-app.com` | 403 Forbidden  | **无**                        |

所以浏览器 / WebView 里的 `fetch()` 直连必被 CORS 拦截抛错。

- **OCR「网络连接失败」**：OCR **完全没有代理**，`src/services/pdf-parser.ts` 与设置页测试都是直连
  paddleocr → 任何浏览器/WebView 都被 CORS 拦死 → `fetch` 抛错 → catch 归类为「网络连接失败」。

---

## 修复路线（覆盖两端）

### 桌面端 (Tauri) —— 推荐，最干净

用 `@tauri-apps/plugin-http` 在 Rust 侧发请求，**天然无 CORS**，OCR + 结果/图片下载一次解决。

1. 加 JS `@tauri-apps/plugin-http` + Rust `tauri-plugin-http`；在 capabilities 允许
   `paddleocr.aistudio-app.com`（及 OCR 结果/图片所在域）。
2. 抽 `appFetch(url, opts)`：是 Tauri → 用插件 `fetch`；否则原生 `fetch` + 代理。
3. `pdf-parser.ts`（提交 job / 轮询 / 下载 JSONL / 下载图片）改用 `appFetch`。

### 网页端 —— 补代理

- **新增 OCR 代理 `/api/ocr`**：需代理整条链——提交 job、轮询状态、下载结果 JSONL、下载图片。
- 若坚持挂 **aliyun 静态 nginx**：serverless 跑不了，需用 nginx `proxy_pass` 反代上述域并注入
  CORS 头（运维配置，非前端代码）。

### 现实建议

OCR 在网页端本质很麻烦（要代理整条下载链）。最省力组合：

- **PDF/OCR 导入只在桌面端做**（plugin-http 直连，零成本）；
- 网页端若需 OCR，部署 Vercel 后补 `/api/ocr` 代理。

---

## 涉及文件

- `src/services/pdf-parser.ts`（OCR 全链路 fetch）
- `src/views/SettingsView.vue`（错误文案）
- `src-tauri/tauri.conf.json`、`src-tauri/Cargo.toml`（plugin-http 依赖与 capabilities）
