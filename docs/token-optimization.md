# 送 AI 题目的 Token 优化方案（交付 Codex 执行）

> 目标：在不降低解析质量的前提下，大幅降低「规则解析不确定、需送 AI 修复」这条路径的
> token 消耗。实测背景：单次导入 17,388 tokens 中**输出占 12,182（70%）**，所以核心杠杆
> 是**砍 AI 的输出量**，而非输入。
>
> 执行前先读这些既有结构（`src/services/importer.ts`）：
> - `ParsedQuestion = { type, stem, options?, answer, analysis?, imagePlaceholders?, confidence? }`
> - `repairWithAI(blocks: string[], onProgress?): Promise<Map<number, ParsedQuestion>>`
>   —— 入参是低置信块的原始文本数组，返回 `块索引 → 解析题` 映射。
> - `callParseBatch(batchText, hint?, systemPrompt): Promise<Map<number, ParsedQuestion>>`
>   —— 内部用 `chatJson`，按 `block_N` 解析 blockId，并对结果调 `sanitizeParsed`。
> - `packByChars(items: {idx,text}[], limit)` —— 打包，条目格式 `--- blockId: block_${idx} ---\n${text}\n`
> - `sanitizeParsed(q)`、`detectType`、`normalizeAnswer`、`JUDGE_SYSTEM`、`CACHE_VERSION`、`parseCache` 表
> - 调用方 `src/views/ImportView.vue` `doParse()`：
>   `repairWithAI(hybrid.lowConfidenceBlocks, …)` → 用 `hybrid.lowConfidenceIndices[blockIdx]` 回填。
> - `src/services/ai.ts`：`chat(messages, {jsonMode?, temperature?})` / `chatJson<T>(messages, {temperature?})`
>
> 每个任务独立成一次提交，均须通过 `npm run type-check`。**改了 AI 协议/提示词后必须改 `CACHE_VERSION`**，
> 否则旧缓存命中导致结果不一致。

---

## 任务 A：差量修复协议（最大头，输出 ↓约 60–70%）

### 现状问题
`repairWithAI` 走 `JUDGE_SYSTEM`，让 AI 把每道题的**题干 + 选项整段重新吐一遍**。但规则解析
**早已正确提取**了题干和选项，AI 真正需要做的通常只是：判定「这是不是题目」+ 给出「题型 / 答案」。
重吐长题干 = 纯浪费输出 token。

### 核心思路
把**规则解析的候选结构**一并发给 AI，让它**只返回差量字段**：
- 默认只回 `{blockId, isValid, type, answer}`，**不重吐 stem/options/analysis**
- 仅当规则的题干/选项确实有误（如多题合并、乱码残留）时，才**额外**返回 `stem` / `options`
- 合并时以「规则候选」为基底，叠加 AI 返回的字段

### 涉及文件
- `src/services/importer.ts`
- `src/views/ImportView.vue`（构造候选）

### 实现步骤

1. **改 `repairWithAI` 入参**，携带候选：
   ```ts
   export interface RepairItem { block: string; candidate: ParsedQuestion }
   export async function repairWithAI(
     items: RepairItem[],
     onProgress?: (done: number, total: number) => void,
   ): Promise<Map<number, ParsedQuestion>>
   ```
   返回值语义不变（`items 索引 → 题`）。缓存键改为 `sha256(CACHE_VERSION\0 block)`（block 仍是原始文本，候选不进 key）。

2. **`ImportView.vue` 调用处**构造候选（索引对应关系已有）：
   ```ts
   const items = hybrid.lowConfidenceBlocks.map((block, i) => ({
     block,
     candidate: hybrid.questions[hybrid.lowConfidenceIndices[i]],
   }))
   const fixes = await repairWithAI(items, (done, total) => { … })
   ```
   后续 `for (const [blockIdx, fixed] of fixes)` → `hybrid.lowConfidenceIndices[blockIdx]` 回填逻辑**保持不变**。

3. **新提示词 `REPAIR_DIFF_SYSTEM`**（替换 repair 用的 `JUDGE_SYSTEM`）：
   ```
   你是题库校对助手。每个块给你「规则解析结果」和「原文」。请判定并最小化输出：
   1. 若该块不是有效题目（标题/说明/目录/乱码）→ 输出 {"blockId","isValid":false}
   2. 若是题目：
      - 总是给出 type（single/multiple/judge/fill/short/essay）与 answer
        · 单选 answer 用单字母；多选用多字母如 "AC"；判断用 "T"/"F"；填空用字符串数组
      - 仅当「规则解析」的题干或选项有明显错误/残缺时，才额外返回修正后的 stem / options
        （题干选项正确时绝对不要重复输出它们）
   3. 不要输出 analysis 字段。
   严格 JSON：{"results":[{"blockId":"block_0","isValid":true,"type":"...","answer":...}]}
   blockId 必须原样使用输入标注，不要重新编号。
   ```

4. **输入块格式**（`packByChars` 的 text 用紧凑候选 + 原文）：
   ```
   --- blockId: block_3 ---
   [规则解析] 题型:multiple | 题干:中心化协调模式…变化。 | 选项:A.xx|B.xx|C.xx|D.xx | 答案:(空)
   [原文]
   <折叠空行后的原始块文本>
   ```
   候选渲染辅助函数：
   ```ts
   function renderCandidate(q: ParsedQuestion): string {
     const opts = q.options?.length
       ? q.options.map((o,i)=>`${String.fromCharCode(65+i)}.${o}`).join('|') : '(无)'
     const ans = Array.isArray(q.answer) ? q.answer.join('') : (q.answer || '(空)')
     return `题型:${q.type} | 题干:${q.stem} | 选项:${opts} | 答案:${ans}`
   }
   ```

5. **合并逻辑**（关键：以候选为基底叠加差量，再 `sanitizeParsed`）：
   ```ts
   function mergeRepair(candidate: ParsedQuestion, ai: {
     isValid?: boolean; type?: QuestionType; answer?: string|string[]; stem?: string; options?: string[]
   }): ParsedQuestion | null {
     if (ai.isValid === false) return null
     const merged: ParsedQuestion = {
       ...candidate,
       type: ai.type ?? candidate.type,
       stem: ai.stem ?? candidate.stem,
       options: ai.options ?? candidate.options,
       answer: ai.answer ?? candidate.answer,
       // analysis 保留规则已有的（如判断改错的「错：…」），不靠 AI 重生成
       confidence: Math.max(candidate.confidence ?? 0.5, 0.7),
     }
     return sanitizeParsed(merged)
   }
   ```
   解析 AI 返回时按 `blockId → idx` 找到 `items[idx].candidate` 做 merge，写回 `repaired` 和 `parseCache`。
   > 注意：这里**不要**直接复用 `callParseBatch`（它内部直接 `sanitizeParsed` 且不做 merge）。
   > 为 repair 单独写一个解析+merge 流程，或给 `callParseBatch` 增加「返回原始字段、不 sanitize」的模式。

6. **`parseQuestionsWithAI`（全文 AI，无候选）维持全量输出**——它没有规则候选可叠加，差量不适用。

### 验收标准
- 同一文档，repair 阶段**输出 token 显著下降**（题干选项正确的块，AI 只回 type+answer）。
- 多题合并 / 题干残缺的块，AI 仍能返回修正后的 stem/options，结果正确。
- `isValid:false` 的块被丢弃（非题目不入库）。
- 改了协议 → `CACHE_VERSION` 已 bump。

### 风险
- AI 偶尔在题干正确时仍重吐 stem → 无害（merge 用 AI 的也对），只是省得少；提示词已明确约束。

---

## 任务 B：修复阶段不生成解析（输出再 ↓一截）

### 说明
analysis 是最长的输出字段。修复阶段不需要它（判断改错题的「错：…」规则已提取并保留）。
- 已并入任务 A 的 `REPAIR_DIFF_SYSTEM`（「不要输出 analysis」）。
- `mergeRepair` 不接受 AI 的 analysis，保留候选已有的 analysis。
- 用户若想要解析 → 用预览页已有的「AI 校对 / 补答案」按钮（`generateAnswer`）按需单题生成。

### 验收
- repair 返回的题 analysis 来自规则（或为空），AI 不再输出 analysis。

---

## 任务 C：max_tokens 上限 + 输入压缩

### 涉及文件
- `src/services/ai.ts`、`src/services/importer.ts`

### 实现步骤
1. **`ai.ts` 支持 `maxTokens`**：
   ```ts
   export async function chat(messages, opts: { jsonMode?: boolean; temperature?: number; maxTokens?: number } = {})
   // body 中：if (opts.maxTokens) body.max_tokens = opts.maxTokens
   export async function chatJson<T>(messages, opts: { temperature?: number; maxTokens?: number } = {})
   // 透传 maxTokens
   ```
2. **修复 / 答案生成传上限**：
   - repair（`callParseBatch`/repair 流程）：`maxTokens: 1500`（差量输出短，足够一批）
   - `generateAnswer`：`maxTokens: 400`
   - 全文 `parseQuestionsWithAI`：`maxTokens: 4000`（需重吐结构，给足）
   > 这些是防尾部爆量的安全网，不是常规截断点；按实际批量微调。
3. **输入压缩**：发送前对每个块文本折叠多余空行
   ```ts
   const compact = (s: string) => s.replace(/[ \t]+\n/g, '\n').replace(/\n{2,}/g, '\n').trim()
   ```
   在打包进 batch 前对 block / 原文应用（docx 提取常带大量空行）。

### 验收
- 设置 max_tokens 后正常题不被截断；异常长输出被封顶。
- 压缩后输入 token 下降，解析结果不变。

---

## 任务 D（可选）：批次与缓存增强

- `MAX_BATCH_CHARS` 已为 8000；差量后单块输入更小，可在 `MAX_BATCH_BLOCKS`（现 15）上适当加大，
  减少批次数 → system 前缀重复发送次数下降 → 上下文缓存命中率上升（DeepSeek 对相同前缀自动半价缓存）。
- 确认每批 messages 第一条恒为完全相同的 `REPAIR_DIFF_SYSTEM`（不要把可变内容混进 system 段），
  以最大化缓存命中。
- `parseCache` 可加「createdAt 超 30 天清理」（低优先）。

---

## 执行顺序
**A（含 B）→ C → D**。A 是主杠杆且改了协议必须 bump `CACHE_VERSION`；C 是独立安全网；D 是锦上添花。

## 全局验收
- 每个任务后 `npm run type-check` 通过。
- 用「文末无答案 / 判断改错 / 多题合并」混合文档回归：题数、题型、答案正确，
  且 repair 阶段输出 token 较改造前明显下降（对比 console 或接口用量）。
