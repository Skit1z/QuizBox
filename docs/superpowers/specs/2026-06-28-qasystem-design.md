# 刷题系统 (QAsystem) — 设计文档

- 日期：2026-06-28
- 状态：已批准

## 一、项目定位

跨端一致的刷题应用：

- **Mac / Windows**：Tauri 打包桌面端，默认纯本地，可开 WebDAV 同步
- **移动端**：Vercel 部署网页访问，必须先配 WebDAV 才能使用
- 统一一套 Vue 3 代码，数据存本地 IndexedDB，通过 WebDAV 多端同步

## 二、技术栈

| 层 | 选型 |
|----|------|
| 框架 | Vue 3 + TypeScript + Vite |
| UI | Vant 4（移动优先）+ 响应式 CSS（桌面双栏） |
| 路由/状态 | Vue Router + Pinia |
| 本地库 | Dexie.js (IndexedDB) |
| 同步 | webdav (npm 包) |
| Word 解析 | mammoth.js |
| AI | fetch 直调 OpenAI 兼容协议（用户自填 Base URL + Key） |
| 公式 | KaTeX |
| 列表性能 | vue-virtual-scroller |
| PC 打包 | Tauri 2 |

## 三、架构

```
       统一 Vue 3 + TS 代码库（响应式：移动单栏 / 桌面双栏）
                ┌────────┴────────┐
        【PC: Tauri打包】     【移动: Vercel部署】
        .app / .exe            手机浏览器访问
        默认纯本地              必须先配 WebDAV
        可开 WebDAV 同步 ↓        ↓
                └─── WebDAV 服务器（坚果云等）───┘
```

- 数据始终读写本地 IndexedDB，WebDAV 仅做同步搬运
- 移动端首次启动引导填 WebDAV；PC 默认纯本地，设置里可开同步

## 四、数据模型（Dexie 表）

- **subjects** 科目：id, name, order, updatedAt, deletedAt
- **chapters** 章节：id, subjectId, parentId, name, order
- **questions** 题库主表：id, subjectId, chapterId, type(单选/多选/判断/填空/简答/论述), stem(富文本JSON+LaTeX), options[], answer, analysis, attachments[](图片哈希), difficulty, tags[], sourceHash(去重), updatedAt, deletedAt, revision
  - 复合索引：(subjectId, chapterId, type, difficulty)
- **attempts** 做题记录：id, questionId, mode(考试/自测), userAnswer, isCorrect(客观), aiScore/aiFeedback(主观AI), selfRating(主观自评), createdAt
- **wrongBook** 错题本：id, questionId, reason, status(待复习/已掌握), reviewCount, lastReviewAt, nextReviewAt(SM-2), updatedAt, deletedAt
- **examSessions** 考试场次：id, config(题量/时长/科目/模式), questionIds[], startTime, endTime, answers{}, score, status
- **attachments** 图片缓存：hash, blob(Blob), size, synced
- **syncMeta** 同步元数据：lastSyncAt, deviceName

## 五、功能模块

1. **题库导入（AI 解析 Word）**：上传 .docx → mammoth.js 提取文本+图片 → 选题型模板（首次配置后保存）→ AI（JSON Mode）结构化为题目数组 → 预览/纠错/确认 → 写入 IndexedDB + 图片存 attachments → 自动同步。解析失败单题标红手改。
2. **自测模式**：按科目/章节/难度筛选；即时反馈；顺序/随机练习；错题自动入错题本，SM-2 间隔重复安排复习。
3. **考试模式（传统+子模式）**：传统=设定题量/时长/范围→做完交卷出分；子模式=错题重做、随机抽查、乱序练习、薄弱点加权抽题。
4. **错题本**：自动收录+手动加入；标注原因；SM-2 复习提醒；主观题可重做对比参考答案。
5. **主观题评分**：客观题自动判分（填空支持精确/包含/正则）；主观题每题可选"自评打分"或"AI 评分"（AI 返回 0-100 分+评语+得分点）。
6. **WebDAV 同步**：设置填地址/账密；自动同步（写操作后防抖 5s + 启动拉取）；记录级增量 last-write-wins；图片单独上传 /attachments/ 按哈希去重；不可达静默降级纯本地。
7. **响应式布局**：>768px 桌面双栏（左侧导航+右侧内容），<768px 移动单栏。
8. **AI 设置**：用户自填 Base URL + API Key + 模型名，兼容 OpenAI/GLM/DeepSeek 等所有兼容接口。

## 六、项目结构

```
QAsystem/
├── src/
│   ├── main.ts · App.vue · router/
│   ├── views/         首页/题库/自测/考试/错题本/导入/设置
│   ├── components/    QuestionCard/OptionList/FormulaRender等
│   ├── stores/        settings/subjects/sync
│   ├── db/            Dexie 表定义 + 仓储层
│   ├── services/
│   │   ├── ai.ts          AI 调用（解析+评分）
│   │   ├── docx-parser.ts mammoth 封装
│   │   ├── sync.ts        WebDAV 同步引擎
│   │   └── grading.ts     客观判分+主观评分调度
│   ├── utils/         SM-2/去重/公式渲染
│   └── types/         TS 类型
├── src-tauri/         Tauri 配置（PC 打包）
├── public/
├── vite.config.ts · package.json
```

## 七、实现步骤

1. **阶段 1：项目骨架** — Vite+Vue3+TS 脚手架；接入 Vant4/Pinia/Router/Dexie；Dexie 表与索引；响应式布局壳 + 路由
2. **阶段 2：核心数据与展示** — 题库 CRUD；题目渲染组件（题型适配 + KaTeX + 图片懒加载 + 虚拟滚动）
3. **阶段 3：AI 导入** — mammoth.js 解析；AI 结构化（JSON Mode）+ 预览纠错 + sourceHash 去重
4. **阶段 4：做题模式** — 自测（筛选/即时反馈）；考试（传统+子模式）+ 判分引擎
5. **阶段 5：错题本与主观题** — 错题本（SM-2）+ 主观题 AI 评分/自评
6. **阶段 6：WebDAV 同步** — 增量合并 + 图片去重 + 自动同步 + PC 同步开关 + 移动端首启引导
7. **阶段 7：打包与部署** — Tauri 2 配置 + Vercel 部署

## 八、关键决策汇总

1. PC 默认纯本地，可开 WebDAV；移动端必须先配 WebDAV
2. 数据永远在本地 IndexedDB，WebDAV 仅同步
3. AI 前端直调，用户自填 Key（兼容多提供商）
4. 自动同步（防抖 5s + 启动拉取），图片单独存按哈希去重
5. UI = Vant 4 + 响应式，桌面双栏 / 移动单栏
6. 主观题：自评 + AI 都支持
