<div align="center">

<img src="public/favicon.svg" alt="题盒" width="96" height="96">

# QuizBox

**离线优先的个人刷题工具：导入题库、移动端练习、考试自测、错题复习。**

本地优先 · 可选 WebDAV 同步 · 可部署到 Vercel 开启云端题库同步

![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

[![Deploy with Vercel](https://vercel.com/button)](https://vercel.com/new/clone?repository-url=https://github.com/Skit1z/QuizBox)

</div>

---

## 简介

QuizBox 面向个人题库使用场景：把已有 Word / Markdown / PDF 题库整理成可刷题的数据，主要数据保存在浏览器 IndexedDB 中，不依赖账号系统，也不强制上云。

典型使用方式：

1. 在电脑端导入题库，按科目管理题目。
2. 在手机或电脑上进行自测、考试和错题复习。
3. 需要跨设备共享题库时，选择 WebDAV 或部署到 Vercel 后启用云端题库同步。

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

**题库管理** — 支持科目、章节、题目管理；题型包含单选、多选、判断、填空、简答、论述；题干支持 LaTeX 和图片附件。

**题库导入** — 支持 `.docx`、`.md`、`.pdf` 导入。规则解析为主，低置信度内容可用 AI 辅助修复，导入前可逐题校对。

**自测与考试** — 自测模式即时反馈；考试模式支持限时交卷，并按题库中实际存在的题型设置抽题数量。

**错题本** — 客观题答错后自动进入错题本，支持按科目筛选、多选后重新自测。错题本仅保存在当前浏览器本地。

**我的自测** — 自测和考试会保存未完成记录，退出后可以继续。记录仅保存在当前浏览器本地。

**主观题评分** — 客观题自动判分；简答、论述支持 AI 评分和自评。

**跨设备题库同步** — 可选择 WebDAV，或部署到 Vercel 后使用 `/api/bank` + Vercel Blob 同步题库快照。错题本和我的自测不参与云端题库同步。

**外观** — 支持亮色、暗色、跟随系统，以及多套主题色。

---

## 技术栈

- Vue 3 + TypeScript + Vite
- Vant 4 + Pinia + Vue Router
- Dexie / IndexedDB 本地存储
- Vercel Serverless Functions + Vercel Blob 云端题库同步
- WebDAV 可选同步
- Tauri 2 桌面端打包

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
| `npm run build`      | 生产构建            |
| `npm run lint`       | ESLint 检查         |
| `npm run format`     | 格式化代码          |
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

也可部署到任意静态托管，但 `/api/bank` 云同步依赖 serverless 函数和 Blob 存储；纯静态托管只能使用 WebDAV 或本地数据。

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

**外观** — 支持亮色 / 暗色 / 跟随系统三种主题模式，以及多套主题色切换。

---

## CI

仓库提供 GitHub Actions CI，覆盖：

- `npm ci`
- `npm run format:check`
- `npm run type-check`
- `npm run build`
- `npm run lint`

CI 不运行测试，也不会引入测试框架；当前项目验收以类型检查、构建、格式和 lint 为准。

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
