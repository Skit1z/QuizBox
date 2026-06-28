<div align="center">

<img src="public/favicon.svg" alt="题盒" width="96" height="96">

# 题盒 · QuizBox

**把 Word 题库丢进去，手机上刷题，错题自己复习自己。**

数据全在你手里 · 不需要后端 · 坚果云同步就够了

![Vue](https://img.shields.io/badge/Vue-3-42b883.svg)
![Tauri](https://img.shields.io/badge/Tauri-2-FFC131.svg)
![License](https://img.shields.io/badge/license-MIT-blue.svg)

</div>

---

## 这东西能干嘛

简单说：**你有一堆 Word 格式的题库，想在手机上刷题，还想自动整理错题帮你复习。**

1. 把 `.docx` 扔进来，AI 帮你拆成一道道结构化的题目
2. 手机上随时刷——自测、模拟考、错题重做，怎么来都行
3. 做错的题自动收录，按遗忘曲线安排复习，不用你操心
4. 电脑和手机之间用坚果云 WebDAV 同步，不花一分钱

---

## 截图预览

### 移动端

<!-- 把移动端截图放在这里，建议 3-4 张并排，宽度 200px 左右 -->
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

<!-- 把 PC 端截图放在这里，建议 1-2 张宽图 -->
<p align="center">
  <img src="" alt="桌面端题库" width="720">
</p>
<p align="center">
  <img src="" alt="桌面端刷题" width="720">
</p>

---

## 有什么特点

**题库管理** — 六种题型全覆盖（单选 / 多选 / 判断 / 填空 / 简答 / 论述），支持 LaTeX 公式和图片，按科目分类管理。

**AI 导入** — 不用手动录题。上传 Word 文档，选一个 AI 供应商（DeepSeek、智谱、通义千问之类的都行），自动解析成题目。解析拿不准的会标红，你确认一下再入库。

**两种刷题模式** — 自测模式答一题出一题结果，适合日常练习；考试模式限时交卷出分，还能按错题重做、随机抽查、薄弱点加权来组卷。

**错题本会自己安排复习** — 做错的题自动进错题本，用 SM-2 间隔重复算法安排什么时候该复习。刚错的题隔一天再看，答对了拉长间隔，答错了缩回来。不用你记"上次什么时候看的"。

**主观题也能打分** — 客观题系统判，简答论述可以让 AI 打分（0-100 + 评语），也可以对着参考答案自评。

**数据是你自己的** — 全存在浏览器 IndexedDB 里，没有后端服务器。多设备同步走 WebDAV（坚果云免费就够用）。API Key 之类的敏感信息在本地加密存储。

**长得还行** — 三套主题色随便换，暗黑模式，移动端和桌面端自适应布局。

---

## 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Vue 3 + TypeScript（Composition API） |
| 构建 | Vite 6 |
| UI | Vant 4（移动优先，按需引入） |
| 状态管理 | Pinia |
| 本地存储 | Dexie.js（IndexedDB） |
| 同步 | WebDAV（坚果云 / Nextcloud 等） |
| Word 解析 | mammoth.js |
| 公式渲染 | KaTeX |
| 桌面打包 | Tauri 2 |

---

## 跑起来

```bash
# 装依赖
npm install

# 开发模式
npm run dev        # http://localhost:5173

# 打包
npm run build      # 网页版
npm run tauri build  # 桌面端（需要 Rust）
```

其他命令：

| 命令 | 干啥的 |
|------|--------|
| `npm run type-check` | 跑一遍 TypeScript 类型检查 |
| `npm run tauri dev` | 桌面端开发调试 |
| `npm run preview` | 预览构建产物 |

---

## 部署

### 手机端 → Vercel / Cloudflare Pages

纯静态站，随便找个免费托管就行。

```bash
npm i -g vercel && vercel --prod
```

或者 GitHub 仓库关联 Vercel，构建命令 `npm run build`，输出目录 `dist`。

部署好之后手机打开，浏览器"添加到主屏幕"就是个 App 了。第一次打开会引导你配 WebDAV。

### 电脑端 → Tauri 打包

```bash
npm run tauri build
```

产物在 `src-tauri/target/release/bundle/`，Mac 是 `.app`，Windows 是 `.exe`。电脑端默认本地用，不配 WebDAV 也能用，需要同步的时候在设置里开。

---

## 配置

全在应用里的"设置"页面操作，不用改代码。

**AI 接口** — 选供应商 → 填 API Key → 完事。支持 DeepSeek / 智谱 GLM / 硅基流动 / 通义千问 / Kimi / OpenAI，也可以填自定义的 OpenAI 兼容接口。每个供应商都附了"怎么申请 Key"的链接。

**WebDAV 同步** — 填服务器地址、账号、密码。坚果云的话记得用"应用密码"不是登录密码。

**外观** — 亮色 / 暗色 / 跟随系统，三套主题色随便切。

---

## 项目结构

```
src/
├── views/         页面（首页/题库/自测/考试/错题本/导入/搜索/设置）
├── components/    组件（QuizRunner / QuestionCard / ExamResult / RichText）
├── stores/        Pinia 状态（settings / subjects / sync）
├── db/            数据库定义 + 仓储层
├── services/      AI / 同步 / 评分 / Word 解析 / 导入
├── utils/         工具函数（加密 / SM-2 / 洗牌 / KaTeX）
├── themes/        主题色 token
├── types/         类型定义
└── styles/        全局样式
src-tauri/         Tauri 桌面端配置
```

---

## 隐私

- 没有后端，数据全在你本地
- AI 调用直连你填的供应商，不经过我们
- WebDAV 走你自己的网盘
- API Key 和密码在本地 AES-GCM 加密存储

---

## License

MIT
