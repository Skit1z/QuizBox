# 部署到 Vercel + 云端题库同步（跨设备）

本教程带你把「题盒 QuizBox」部署到 Vercel，并开启**云端题库同步**——在电脑导入题库后，
手机/平板打开同一网址即可接着做题。

> 为什么用 Vercel：自动 HTTPS、自带 `/api/*` serverless 函数、题库接口与网页**同源**（无 CORS、
> 无混合内容问题），跨设备同步零配置。

---

## 一、前置准备

- 一个 GitHub 账号，并把本项目 push 到你的仓库
- 一个 Vercel 账号（用 GitHub 登录即可，免费额度足够个人使用）

---

## 二、导入项目到 Vercel

1. Vercel 控制台 → **Add New… → Project** → 选择你的 GitHub 仓库 → **Import**。
2. 构建配置（一般会自动识别，确认即可）：
   - **Framework Preset**: Vite
   - **Build Command**: `npm run build`
   - **Output Directory**: `dist`
3. 先点 **Deploy** 部署一次（此时云端同步还没开，下一步配置存储）。

部署完成后你会得到一个网址，如 `https://quizbox-xxxx.vercel.app`。

---

## 三、创建 Blob 存储（云端题库存放处）

题库快照存在 Vercel Blob 里。

1. 进入该项目 → 顶部 **Storage** 标签 → **Create Database** → 选 **Blob** → 命名（如 `quizbox`）→ **Create**。
2. 创建后点 **Connect Project**，连接到本项目（选 Production 等环境）。
3. 连接后 Vercel 会自动为项目注入环境变量 **`BLOB_READ_WRITE_TOKEN`**，无需手动填。

### Blob Store 访问模式

Vercel Blob 创建时会让你选择 Store Access：

- **Private**：推荐。Blob URL 不能直接公开读取，必须通过服务端 token 访问。当前项目的 `/api/bank`
  已按 Private store 适配：写入使用 `access: 'private'`，读取也由服务端完成。
- **Public**：Blob URL 可公开读取，不建议用来放题库快照。

注意：Store Access 创建后不能修改。如果你看到错误：

```text
Vercel Blob: Cannot use public access on a private store.
```

说明代码或依赖版本还在按 Public 写入。请确认项目已更新到支持 Private Blob 的版本，并且
`@vercel/blob` 版本不低于 `2.x`。

---

## 四、设置共享密钥（强烈建议）

`BANK_KEY` 是应用层共享密钥，不是 Vercel Blob 的读写 token。

不设密钥的话，任何知道你网址的人都能通过 `/api/bank` 读取/覆盖你的题库。加一把"钥匙"
（这不是账号系统，只是一个固定口令）：

1. 项目 → **Settings → Environment Variables**。
2. 新增：
   - **Key**: `BANK_KEY`
   - **Value**: 自定义一个口令（如 `my-quizbox-2026`）
   - 环境勾选 **Production**（建议三个环境都勾）。
3. 保存。

如果你只是自己用，也可以先不设置 `BANK_KEY`，应用里的「共享密钥」就留空。

不要把 `BLOB_READ_WRITE_TOKEN` 填进应用的「共享密钥」输入框：

- `BLOB_READ_WRITE_TOKEN` 只属于 Vercel 服务端环境变量，用来让 `/api/bank` 读写 Blob。
- `BANK_KEY` 才是浏览器/手机端需要填写的共享口令。
- 把 `BLOB_READ_WRITE_TOKEN` 放到客户端会暴露写权限，也会导致排查方向错误。

---

## 五、重新部署使配置生效

改了存储 / 环境变量后必须重部署：

- 项目 → **Deployments** → 最新一条右侧 **⋯ → Redeploy**，
- 或本地 `git push` 触发自动部署。

部署完成后，`/api/bank` 接口即可用。

你可以直接打开以下地址做服务端自检：

```text
https://你的域名/api/bank?meta=1
```

正常但还没有同步过题库时会返回类似：

```json
{
  "ok": true,
  "exists": false,
  "pathname": "quizbox/bank.json",
  "size": 0
}
```

这表示接口能通，只是还没有写入题库快照。需要在应用里点「立即同步」后才会生成
`quizbox/bank.json`。

---

## 六、在应用里开启云端题库同步

### 电脑端（网页）
1. 打开你的 Vercel 网址 → **设置 → 云端题库同步**。
2. **启用** 打开；**接口地址留空**（留空即用同源 `/api/bank`，推荐）；
   **共享密钥**默认是 `skit1z`。如果你在第四步设置了其它 `BANK_KEY`，这里要改成同一个值。
3. **保存** → **检测接口**。
   - 显示「接口连通，但云端还没有题库快照」是正常的，说明还没上传过题库。
   - 显示已有记录数，说明云端已经存在快照。
4. 点 **立即同步**，把当前已导入的题库推送到云端。
   > 之后再导入新题会自动上传，无需手动。

### 手机 / 平板（网页）
1. 打开**同一个** Vercel 网址 → 设置 → 云端题库同步。
2. **启用** + 填**相同的**共享密钥 → 保存 → **立即同步**（或直接刷新页面，启动会自动拉取）。
3. 题库出现，接着做题即可。

> 想当 App 用：手机浏览器「添加到主屏幕」，即以 PWA 全屏运行。

---

## 七、它同步了什么 / 没同步什么

- ✅ 同步：题目、章节、科目（逐条 last-write-wins 合并，多端改动不互相覆盖整库）
- ❌ 不同步：错题本、我的自测/考试记录、题目图片附件

错题本和我的自测是**浏览器本地状态**：每个浏览器、每台设备各自保存一份，不会跨设备覆盖。

适用于**文本题库**（绝大多数题库都是纯文本）。

---

## 八、常见问题

**Q：检测接口报 401？**
密钥不匹配。确认应用设置里的密钥与 Vercel 的 `BANK_KEY` 完全一致，且改完环境变量已重部署。

**Q：我没有设置 `BANK_KEY`，共享密钥留空还是无法同步？**
留空只表示不做应用层密钥校验，不代表 Blob 一定能写入。继续看页面里的具体错误：

- `Cannot use public access on a private store`：Blob Store 是 Private，但代码/依赖还按 Public 写入。
  更新到支持 Private Blob 的版本后重新部署。
- `Blob store not found` / 缺 token：没有把 Blob store 连接到当前 Vercel 项目，或环境变量没有勾选
  Production。
- `401`：服务端配置了 `BANK_KEY`，但客户端没填或填错。当前应用默认共享密钥是 `skit1z`。

**Q：检测接口报 500 / "云端题库存储错误"？**
多半是没创建/连接 Blob 存储（缺 `BLOB_READ_WRITE_TOKEN`）。回到第三步创建并连接，再重部署。

**Q：提示 "接口连通，但云端还没有题库快照" 是不是没存进去？**
不是。这个提示只说明 GET 能通，但 Blob 里还没有 `quizbox/bank.json`。电脑端导入题库后点
「立即同步」，成功后页面会显示写入的记录数、路径和大小。

**Q：手机拉到的是旧题库？**
接口已加时间戳绕过 CDN 缓存；若仍旧，确认电脑端已点过「立即同步」把最新快照推上去。

**Q：桌面端（Tauri）能用吗？**
能，但桌面端不是网页同源，需在「接口地址」里填部署站点的完整域名
（如 `https://quizbox-xxxx.vercel.app`），密钥同填。

**Q：安全性？**
题库快照存在你自己的 Vercel Blob；接口由 `BANK_KEY` 校验。题库内容本身敏感度低，
如需更强隔离可改用私有数据库（见 `docs/` 后续方案）。

**Q：免费额度够吗？**
个人题库快照通常几百 KB ~ 数 MB，Vercel Blob / 函数调用的免费额度绰绰有余。

---

## 九、（可选）自定义域名

项目 → **Settings → Domains** 添加你的域名并按提示配置 DNS，Vercel 自动签发 HTTPS 证书。
之后两端都用这个域名访问即可，云端同步无需改动。

如果你用 Cloudflare 代理到 Vercel：

- DNS 记录一般使用 `CNAME` 指向 Vercel 分配的域名。
- 该域名必须同时在 Vercel 项目 **Settings → Domains** 中添加，并连接到 Production。
- 出现 `404: DEPLOYMENT_NOT_FOUND` 时，通常是域名还没有绑定到当前 Vercel 项目，或 DNS 指向了错误项目。
- 绑定完成后建议使用 `https://你的域名`，不要只测 `http://`。

---

## 十、（可选）部署记录与版本自动部署

每次 push 到 `main`，Vercel 都会自动创建一次新的 Production Deployment；GitHub 的
**Deployments** 页面也会记录一次。这是正常的部署历史，不代表有多个生产版本同时覆盖你的域名。
生产域名只会指向最新成功的 Production Deployment。

如果你只是想减少历史记录：

1. Vercel 项目 → **Settings → Deployment Retention**，把 Production / Preview 的保留时间调短。
   Vercel 是按时间保留，不是严格只保留一条。
2. GitHub 的 Deployments 列表不会自动只显示最新一条。旧记录需要通过 GitHub Deployments API
   标记为 `inactive` 后删除；当前 active 的 deployment 不能直接删除。
3. 如果要自动清理，可以写 GitHub Actions 定时任务或 push 后延迟清理，保留最新 active deployment，
   删除旧 inactive deployment。清理 GitHub 记录不会影响 Vercel 最新生产站点访问。
