# 刷题系统 (QAsystem)

跨端一致的刷题应用：Mac / Windows 桌面端 + 移动端网页，一套代码，数据本地存储，WebDAV 多端同步。

## 功能

- 📚 **题库管理**：按科目/章节分类，支持单选、多选、判断、填空、简答、论述六种题型
- 🤖 **AI 导入**：上传 Word (.docx)，AI 自动解析结构化为题库（兼容 OpenAI / GLM / DeepSeek）
- ✍️ **自测模式**：即时反馈，按章节/难度/题型筛选，错题自动收录
- 📝 **考试模式**：传统限时 + 错题重做/随机抽查/乱序/薄弱点加权等子模式
- ❌ **错题本**：SM-2 间隔重复算法安排复习，支持错误原因标注
- 🎯 **主观题评分**：AI 评分（0-100 分 + 评语）与自评打分
- ☁️ **WebDAV 同步**：记录级增量合并，图片按哈希去重，自动同步
- 📱 **跨端一致**：桌面双栏 / 移动单栏响应式布局

## 技术栈

Vue 3 + TypeScript + Vite + Vant 4 + Pinia + Dexie.js (IndexedDB) + Tauri 2

## 开发

```bash
npm install
npm run dev          # 本地开发
npm run build        # 类型检查 + 生产构建
```

## 部署

### 移动端（Vercel 网页）

```bash
# 方式一：CLI
npm i -g vercel
vercel --prod

# 方式二：连接 GitHub 仓库，Vercel 自动部署
# 构建命令：npm run build:dev，输出目录：dist
```

手机访问部署地址，浏览器"添加到主屏幕"即可当 App 使用。
首次启动需配置 WebDAV（坚果云/Nextcloud 等）。

### PC 桌面端（Tauri 打包）

前置：安装 [Rust](https://rustup.rs) 与 Tauri 2 系统依赖。

```bash
npm run tauri dev    # 桌面端调试
npm run tauri build  # 打包 .app (Mac) / .exe (Windows)
```

打包产物位于 `src-tauri/target/release/bundle/`。

## 配置

在 App 内「设置」页填写：

- **AI 接口**：Base URL + API Key + 模型名（默认 GLM）
- **WebDAV 同步**：服务器地址 + 账号 + 应用密码

## 数据存储

所有数据存于浏览器 IndexedDB（`QAsystemDB`），WebDAV 仅作多端同步搬运，离线可正常使用。

## 设计文档

见 `docs/superpowers/specs/2026-06-28-qasystem-design.md`。
