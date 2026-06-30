# QuizBox 开发规范

本文件是面向 AI 协作者（Claude / Codex / Gemini 等）与人类开发者的统一规范。
**AI 在修改本仓库前必须先通读本文件，并严格遵守。**

---

## 0. 不可违反的硬规则

- **永远不要添加任何测试**（单元测试、集成测试、e2e 测试、快照测试均禁止）。
  不创建 `*.test.*` / `*.spec.*` / `__tests__/`，不安装 `vitest`/`jest`/`playwright` 等测试框架，
  不为已有代码补测试。验收靠 `npm run type-check` + `npm run build` + `npm run lint`，不靠测试。
- 不要手工维护 `components.d.ts`；它由 `unplugin-vue-components` 自动生成。若新增实际使用的自动注册组件导致该文件同步更新，可随代码一起提交。
- 不要直接修改 `dist/` 产物。
- 不要在 `main` 分支直接开发；功能开发走 `dev` 分支或 feature 分支。

---

## 1. 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Vue 3.5（`<script setup lang="ts">`） |
| 构建 | Vite 6 |
| UI 库 | Vant 4（按需自动注册，见 `vite.config.ts` 的 `VantResolver`） |
| 状态 | Pinia（Options 风格 store） |
| 路由 | Vue Router 4 |
| 存储 | Dexie 4（IndexedDB，`src/db/index.ts`） |
| 桌面端 | Tauri 2（可选，`src-tauri/`） |
| 部署 | Vercel（serverless functions 在 `api/`） |
| PWA | `vite-plugin-pwa` |

**包管理器：npm**（不要引入 yarn/pnpm，保持 `package-lock.json` 一致）。

---

## 2. 目录结构

```
api/                  Vercel serverless functions（云端题库存储等）
src/
  components/         可复用组件（QuestionCard / ThemedSelect / AdminDialog ...）
  db/                 Dexie 数据库定义 + 各表的 repo（questions/wrongbook/attempts ...）
  services/           业务服务（sync / ai / importer / grading ...）
  stores/             Pinia stores（subjects / settings / sync / admin ...）
  views/              页面级组件（路由对应）
  router/             路由配置
  themes/             主题 token（CSS 变量）
  types/              TypeScript 类型定义
  utils/              工具函数（hash / crypto / debounce / sm2 ...）
scripts/              构建/版本脚本
src-tauri/            Tauri 桌面端配置
```

### 约定
- **数据访问一律走 repo**（`src/db/*.ts`），不要在组件里直接 `db.questions.xxx`。新增表要在 `src/db/index.ts` 加 version + 索引。
- **跨组件状态走 store**；纯组件内部状态用 `ref`/`computed`。
- **类型集中放 `src/types/index.ts`**，避免分散定义导致循环依赖。
- **serverless 函数**放 `api/`，文件名即路由（`api/bank.ts` → `/api/bank`）。

---

## 3. 代码风格

- **TypeScript 严格模式**：所有 `.ts`/`.vue` 必须通过 `vue-tsc --noEmit`。
- **Prettier**：提交前跑 `npm run format`；CI 校验 `npm run format:check`。
- **ESLint**：`npm run lint` 必须 0 error（warning 视情况）。
- **命名**：
  - 组件文件 PascalCase（`QuestionCard.vue`）
  - 组件内 `defineOptions({ name: 'XxxView' })` 显式命名（keep-alive 依赖）
  - 函数/变量 camelCase
  - 类型/接口 PascalCase
  - 常量全大写下划线（`SYNC_TABLES`）
- **Vue 组件结构**：`<script setup>` → `<template>` → `<style scoped>`（顺序固定）。
- **样式**：优先用 CSS 变量（`var(--brand)` / `var(--sp-3)` / `var(--r-md)`，见 `themes/tokens.ts`），
  不要硬编码颜色/间距。所有页面组件 `<style scoped>`。
- **注释**：中文，解释「为什么」而非「是什么」。公共函数加 JSDoc。

---

## 4. 同步架构（重要）

有两套独立同步机制，不要混淆：

1. **WebDAV 同步**（`src/services/sync.ts` 的 `sync()`）：全量 `sync.json`，本地优先 + 逐条 last-write-wins 合并。
2. **云端题库分片同步**（`src/services/sync.ts` 的 `syncBank()`）：按科目分片 + SHA-256 哈希增量。
   - 存储布局：`quizbox/manifest.json` + `meta.json` + `shard_sub_*.json`（详见 `api/bank.ts` 顶部注释）
   - meta 分片含 subjects/chapters + 管理员密码哈希（`adminPwdHash`，跨设备共享）
   - 单分片上限 250KB，题目按 `updatedAt` 升序排列以保持旧分片哈希稳定

**同步原则**：
- 任何写操作后调用 `autoSync()`（防抖 30s）或 `useSyncStore().notifyChange()`。
- 合并永远是**逐条 last-write-wins**（按 `updatedAt`），不要整片覆盖，避免多设备丢数据。
- `syncMeta` 表存本地缓存（lastSyncAt / lastBankSyncAt / manifest / 密码哈希），不参与 WebDAV 同步。

---

## 5. 管理员权限

- 密码哈希（SHA-256）存 IndexedDB `syncMeta.admin_password_hash`，**同时随 meta 分片同步到云端**。
- 服务端可选 `BANK_KEY` 环境变量做共享密钥（防陌生人），但管理员密码是**客户端验证**（`useAdminStore.canOperate()`）。
- 受保护操作（删除/编辑/导入）调用 `guardedAction(fn)`：未验证则弹 `AdminDialog`。

---

## 6. 提交规范

- **分支**：
  - `main`（稳定，只通过 PR 合并）
  - `dev`（开发主线 A）
  - `dev-next`（开发主线 B，与 `dev` 平行）
  - `feat-xxx`（功能）/ `fix-xxx`（修复）
- **禁止删除的分支**：`main`、`dev`、`dev-next` 为受保护分支，**任何情况下都不得删除**（不执行 `git push origin --delete` / `git branch -D` 针对这三个分支，PR 合并时也禁止 `--delete-branch`）。
- **Commit message**：中文，`<type>: <描述>`，type ∈ {feat, fix, chore, refactor, docs, style}。
  - 例：`feat: 题库卡片增加编辑菜单`
  - 例：`fix: 修复下拉菜单滑动秒关`
- **不要在 commit 里加 `Generated with Claude` / `Co-Authored-By` 等 AI 署名**。
- 提交前必须本地通过：`npm run type-check && npm run build && npm run lint`。
- **每次创建 PR 后必须补齐 PR 元数据**：
  - 请求 Copilot review（GitHub CLI 使用 `--add-reviewer @copilot`）。
  - 将 PR assign 给 `Skit1z`。
  - 根据变更性质添加对应 label；功能/体验增强默认使用 `enhancement`。

---

## 7. 版本号规范（语义化版本）

格式：`MAJOR.MINOR.PATCH`（如 `1.6.0`），遵循 https://semver.org/lang/zh-CN/

- **PATCH**（`1.6.0 → 1.6.1`）：bug 修复，向下兼容
- **MINOR**（`1.6.1 → 1.7.0`）：新功能，向下兼容
- **MAJOR**（`1.7.0 → 2.0.0`）：不兼容变更

**bump 命令**（同步更新 package.json / package-lock.json / src-tauri/tauri.conf.json / src-tauri/Cargo.toml）：
```bash
npm run bump:patch   # 默认，修 bug 后用
npm run bump:minor   # 加功能后用
npm run bump:major   # 破坏性变更后用
npm run bump -- 1.8.3   # 显式指定
```
**不要手改版本号**，一律走脚本。

---

## 8. 验收清单（AI 完成任务前必须跑）

```bash
npm run type-check   # exit 0，无类型错误
npm run build        # exit 0，构建通过
npm run lint         # 0 error
```
报告结果时必须附真实输出，不许「应该没问题」式的断言。

<claude-mem-context>
# Memory Context

# claude-mem status

This project has no memory yet. The current session will seed it; subsequent sessions will receive auto-injected context for relevant past work.

Memory injection starts on your second session in a project.

`/learn-codebase` is available if the user wants to front-load the entire repo into memory in a single pass (~5 minutes on a typical repo, optional). Otherwise memory builds passively as work happens.

Live activity: http://localhost:37701
How it works: `/how-it-works`

This message disappears once the first observation lands.
</claude-mem-context>
