<div align="center">

<img src="public/favicon.svg" alt="题盒图标" width="96" height="96">

# 题盒 · QuizBox

**一套代码，四端一致的刷题应用**

Mac · Windows 桌面端 / 移动端网页 · 数据本地存储 · WebDAV 多端同步

![CI](https://github.com/Skit1z/QuizBox/actions/workflows/ci.yml/badge.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)

</div>

---

## ✨ 功能特性

### 📚 题库管理
- 支持六大题型：**单选 · 多选 · 判断 · 填空 · 简答 · 论述**
- 按科目 / 章节分层组织，富文本题干支持 LaTeX 公式与图片
- 大题量场景下虚拟滚动，浏览丝滑

### 🤖 AI 一键导入
- 上传 Word（.docx），AI 自动解析结构化为题库
- 兼容主流国产大模型：**DeepSeek · 智谱 GLM · 硅基流动 · 通义千问 · Kimi** 及 OpenAI
- 低置信度解析结果自动标红，支持逐题编辑校正后入库

### ✍️ 双模式刷题
- **自测模式**：即时反馈，按章节/难度/题型筛选，错题自动收录
- **考试模式**：限时交卷、倒计时，含错题重做 / 随机抽查 / 乱序 / 薄弱点加权等子模式
- 完成后生成成绩详情页：正确率、用时、错题回顾

### ❌ 智能错题本
- 自动收录做错的题，支持错误原因标注
- **SM-2 间隔重复算法**安排复习，越临近掌握复习间隔越长
- 一键复习全部到期错题

### 🎯 主观题评分
- 客观题系统自动判分（填空支持精确 / 包含 / 正则匹配）
- 主观题支持**自评打分**与 **AI 评分**（0-100 分 + 评语 + 得分点）

### ☁️ WebDAV 多端同步
- 接入坚果云、Nextcloud 等标准 WebDAV 服务
- 记录级增量合并，图片按哈希去重，写操作后自动同步
- PC 默认纯本地，可一键开启同步；移动端首启引导配置

### 🎨 现代化设计
- 留白卡片流风格，三套主题色（蓝灰 / 墨绿 / 橙）可在设置切换
- 完整暗黑模式支持，跟随系统或手动切换

---

## 🏗 技术栈

| 层 | 技术 | 说明 |
|----|------|------|
| 框架 | **Vue 3 + TypeScript** | 组合式 API，全量类型检查 |
| 构建 | **Vite 6** | 极速 HMR 与构建 |
| UI | **Vant 4** | 移动优先，按需引入 |
| 状态 | **Pinia** | Vue 官方推荐 |
| 本地库 | **Dexie.js (IndexedDB)** | 浏览器原生事务型数据库 |
| 同步 | **WebDAV** | 无后端多端同步 |
| Word 解析 | **mammoth.js** | 浏览器内解析 .docx |
| 公式 | **KaTeX** | 高性能 LaTeX 渲染 |
| 桌面打包 | **Tauri 2** | 小体积原生应用 |
| 部署 | **Vercel / Cloudflare Pages** | 纯静态托管，免费 |

---

## 🚀 快速开始

### 环境要求
- Node.js ≥ 20（见 `.nvmrc`）
- 桌面端打包另需 [Rust](https://rustup.rs) 与 Tauri 2 系统依赖

### 安装与开发

```bash
npm install      # 安装依赖
npm run dev      # 启动开发服务器 (http://localhost:5173)
```

### 常用命令

| 命令 | 作用 |
|------|------|
| `npm run dev` | 本地开发（建议开移动端调试模式） |
| `npm run build` | 类型检查 + 生产构建 |
| `npm run type-check` | 仅类型检查 |
| `npm run tauri dev` | 桌面端调试 |
| `npm run tauri build` | 打包 `.app` (Mac) / `.exe` (Windows) |

---

## 📦 部署

### 移动端（Vercel 网页）

纯静态站点，零后端。两种方式任选：

**方式一：CLI 部署**
```bash
npm i -g vercel
vercel --prod
```

**方式二：关联 GitHub 仓库**
- 构建命令：`npm run build`
- 输出目录：`dist`

部署后手机访问域名，浏览器「添加到主屏幕」即可当 App 使用。首次启动会引导填写 WebDAV 配置。

### PC 桌面端（Tauri 打包）

```bash
npm run tauri build
```

产物位于 `src-tauri/target/release/bundle/`。PC 端默认纯本地使用，无需配置 WebDAV；需要多端同步时在设置中开启。

---

## ⚙️ 配置

应用内「设置」页可视化配置，无需改代码：

**AI 接口** — 选择供应商后只需填 API Key：
- DeepSeek / 智谱 GLM / 硅基流动 / 通义千问 / Kimi / OpenAI / 自定义兼容接口
- 每个供应商附「如何获取 Key」指引链接

**WebDAV 同步** — 多端数据同步：
- 服务器地址、账号、应用密码、远端目录
- 支持坚果云（用「应用密码」而非登录密码）、Nextcloud 等

**外观** — 主题模式（跟随系统 / 亮色 / 暗色）+ 主题色（蓝灰 / 墨绿 / 橙）

---

## 🗂 数据存储

所有数据存储于浏览器 IndexedDB（库名 `QuizBoxDB`），WebDAV 仅作多端同步搬运。完全离线可用，你的数据始终在自己设备上。敏感信息（API Key、WebDAV 密码）经 AES-GCM 加密存储。

---

## 📐 架构

```
              统一 Vue 3 + TS 代码库
        （响应式：移动单栏 / 桌面双栏）
                    │
        ┌───────────┴───────────┐
        ▼                       ▼
  【PC: Tauri 打包】        【移动: Vercel 部署】
   .app / .exe               手机浏览器访问
   默认纯本地                 必须先配 WebDAV
   可开 WebDAV 同步 ↓           ↓
        └──── WebDAV 服务器（坚果云等）────┘
```

数据始终读写本地 IndexedDB，WebDAV 仅同步。无后端服务器，AI 在前端直调。

---

## 📁 项目结构

```
src/
├── views/         页面：首页/题库/自测/考试/错题本/导入/搜索/设置
├── components/    QuestionCard · QuizRunner · ExamResult · RichText 等
├── stores/        Pinia：settings · subjects · sync
├── db/            Dexie 表定义 + 仓储层（questions/attempts/wrongbook/examSessions）
├── services/      ai · ai-providers · docx-parser · importer · grading · sync
├── utils/         katex · crypto · sm2 · shuffle · hash
├── themes/        主题色 token
├── types/         TypeScript 类型定义
└── styles/        设计系统（global.css）
src-tauri/         Tauri 2 打包配置
```

---

## 🔒 隐私

- 数据 100% 本地存储，不上传到任何服务器
- AI 调用仅在使用时直连你配置的供应商
- WebDAV 同步走你自己的网盘，不经第三方
- 敏感凭据加密存储

---

## 📄 License

MIT
