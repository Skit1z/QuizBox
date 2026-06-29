<div align="center">

<img src="public/favicon.svg" alt="题盒" width="96" height="96">

# 题盒 · QuizBox

**Word 题库导入 → 移动端刷题 → 错题自动间隔复习**

本地优先 · WebDAV / Vercel 云端跨设备同步

![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

</div>

---

## 简介

QuizBox 是一个离线优先的刷题应用，解决「有 Word 题库但没有好用的刷题工具」的问题。

1. 上传 `.docx` 文件，规则解析为主、AI 兜底，自动结构化为题目
2. 支持自测和限时考试两种刷题模式
3. 错题自动收录，基于 SM-2 间隔重复算法安排复习
4. 多设备同步：WebDAV（如坚果云），或部署到 Vercel 后一键开启**云端题库同步**——电脑导入、手机接着做

---

## 截图

### 移动端

<!-- 移动端截图，建议 3-4 张并排，宽度 200px -->
<p align="center">
  <img src="" alt="首页" width="200">
  &nbsp;&nbsp;
  <img src="" alt="刷题" width="200">
  &nbsp;&nbsp;
  <img src="" alt="错题本" width="200">
  &nbsp;&nbsp;
  <img src="" alt="考试结果" width="200">
</p>

### 桌面端

<!-- 桌面端截图，建议 1-2 张宽图 -->
<p align="center">
  <img src="" alt="桌面端题库" width="720">
</p>
<p align="center">
  <img src="" alt="桌面端刷题" width="720">
</p>

---

## 功能

**题库管理** — 支持单选、多选、判断、填空、简答、论述六种题型，题干支持 LaTeX 公式与图片附件，按科目分类管理。

**AI 导入** — 上传 Word 文档，由 AI 自动解析为结构化题目。支持 DeepSeek、智谱 GLM、通义千问、Kimi、OpenAI 等供应商，也可接入自定义的 OpenAI 兼容接口。低置信度的解析结果会标红提示，支持逐题编辑后入库。

**双模式刷题** — 自测模式逐题反馈，适合日常练习；考试模式支持限时交卷，并提供错题重做、随机抽查、薄弱点加权等组卷策略。完成后生成成绩详情与错题回顾。

**间隔复习** — 错题自动收录至错题本，通过 SM-2 算法动态调整复习间隔：答错缩短、答对延长，无需手动管理复习计划。

**主观题评分** — 客观题由系统自动判分；简答与论述题支持 AI 评分（0-100 分 + 评语）及自评打分。

**数据安全** — 全部数据存储于浏览器 IndexedDB，本地优先。API Key 与密码经 AES-GCM 加密后存储。

**跨设备同步** — 两种方式任选：① WebDAV（坚果云 / Nextcloud 等，免费额度即可）；② 部署到 Vercel 后开启**云端题库同步**——题库快照存入 Vercel Blob，电脑导入后手机打开同一网址自动拉取、接着做题。错题本与我的自测按浏览器本地保存，不跨设备覆盖。后者与网页同源，零 CORS、自动 HTTPS（详见 [docs/vercel-deploy.md](docs/vercel-deploy.md)）。

**界面设计** — 三套主题色可选（蓝灰 / 墨绿 / 橙），支持暗黑模式与跟随系统，移动端与桌面端自适应布局。

---

## 技术栈

| 层        | 技术                                                                   |
| --------- | ---------------------------------------------------------------------- |
| 框架      | Vue 3 + TypeScript（Composition API）                                  |
| 构建      | Vite 6                                                                 |
| UI        | Vant 4（移动优先，按需引入）                                           |
| 状态管理  | Pinia                                                                  |
| 本地存储  | Dexie.js（IndexedDB）                                                  |
| 同步      | WebDAV（坚果云 / Nextcloud），或 Vercel Serverless + Blob 云端题库同步 |
| Word 解析 | mammoth.js                                                             |
| 公式渲染  | KaTeX                                                                  |
| 桌面打包  | Tauri 2                                                                |

---

## 快速开始

```bash
# 安装依赖
npm install

# 启动开发服务器
npm run dev        # http://localhost:5173

# 生产构建
npm run build      # Web 版
npm run tauri build  # 桌面端（需要 Rust 环境）
```

| 命令                 | 说明                |
| -------------------- | ------------------- |
| `npm run type-check` | TypeScript 类型检查 |
| `npm run tauri dev`  | 桌面端开发调试      |
| `npm run preview`    | 预览生产构建产物    |

---

## 部署

### Web 端（推荐 Vercel）

通过 GitHub 仓库关联 Vercel 自动部署（构建命令 `npm run build`，输出目录 `dist`），或：

```bash
npm i -g vercel && vercel --prod
```

部署到 Vercel 还能一键开启**云端题库同步**（电脑导入、手机接着做），完整步骤见
**[docs/vercel-deploy.md](docs/vercel-deploy.md)**（含 Blob 存储与共享密钥配置）。

也可部署到任意静态托管（Cloudflare Pages 等），但 `/api/bank` 云同步函数仅在
支持 Serverless 的平台（Vercel / Netlify）生效；纯静态托管只能用 WebDAV 同步。

部署完成后，移动端浏览器访问并「添加到主屏幕」即可作为 PWA 使用。

### 桌面端（Tauri）

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`（macOS `.app` / Windows `.exe`）。桌面端默认使用本地存储，如需多端同步可在设置中启用 WebDAV。

---

## 配置

所有配置均通过应用内「设置」页面完成，无需修改代码。

**AI 接口** — 选择供应商后填写 API Key 即可。每个供应商均附有 Key 申请指引链接。

**WebDAV 同步** — 填写服务器地址、账号与密码。坚果云用户请使用「应用密码」而非登录密码。

**云端题库同步** — 部署到 Vercel 后可用。设置中启用并填共享密钥即可通过同源 `/api/bank` 跨设备共享题库。配置详见 [docs/vercel-deploy.md](docs/vercel-deploy.md)。

**外观** — 支持亮色 / 暗色 / 跟随系统三种主题模式，以及三套主题色切换。

---

## 项目结构

```
src/
├── views/         页面（首页 / 题库 / 自测 / 考试 / 错题本 / 导入 / 搜索 / 设置）
├── components/    组件（QuizRunner / QuestionCard / ExamResult / RichText）
├── stores/        Pinia 状态管理（settings / subjects / sync）
├── db/            数据库定义与仓储层
├── services/      AI / 同步 / 评分 / Word 解析 / 导入
├── utils/         工具函数（加密 / SM-2 / 洗牌 / KaTeX）
├── themes/        主题色 token
├── types/         类型定义
└── styles/        全局样式
api/               Vercel Serverless 函数（bank 云端题库 / webdav 代理）
src-tauri/         Tauri 桌面端配置
docs/              部署教程与设计文档
```

---

## 隐私

- 数据本地优先，存储于浏览器 IndexedDB
- AI 调用直连用户配置的供应商，不经过第三方中转
- 跨设备同步连接用户自有网盘（WebDAV）或自己部署的 Vercel 实例（云端题库同步），数据不经第三方
- API Key 与密码经 AES-GCM 加密存储于本地

---

## License

MIT
