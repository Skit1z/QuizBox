# 题库导入通用性增强设计（方案 B + C）

- 日期：2026-07-14
- 状态：待实现
- 范围：阶段一（方案 C：分块体检 + AI 补切）+ 阶段二（方案 B：方言 DSL 扩展）

## 背景与痛点

当前导入管线（[ImportView.vue](../../../src/views/ImportView.vue) `handleParse`）：

```
parseWithRulesHybrid(text)                          // 纯规则解析
  → shouldTryProfileParse → parseWithDetectedProfile // AI 推断 2 条正则重解析
  → repairWithAI(lowConfidenceBlocks)                // 低置信块逐块 AI 修复
```

BOSS 确认的两个通用性痛点：

1. **切题切错**：[`splitIntoBlocks`](../../../src/services/rule-parser.ts) 完全依赖「题号 / 题型标题 / 答案终止行」切块。题号缺失、编号不规范或排版被拍平时，会把几道题粘成一块或把一道题拆散，**且没有任何事后校验与补救**。
2. **怪格式方言**：[`RuleProfile`](../../../src/services/rule-parser.ts) 只能注入 `questionStart` + `optionStart` 两条正则。答案标记、解析标记等方言维度，引擎不支持覆盖。

## 设计原则

- **确定性优先，AI 兜底**：先用零成本的确定性检测定位问题，只把定位到的可疑片段交给 AI，且 AI 只做最小判定（返回行号 / 结构化正则），不整篇重写。
- **绝不更差**：任一 AI 环节失败或无 AI Key，完整回退到当前行为。方言字段逐个独立回退。
- **复用现有引擎**：补切后的子片段重新走 `parseWithRulesHybrid`，不新增第二套解析逻辑。

---

## 阶段一 · 方案 C：分块体检 + AI 补切

主攻「切题切错」。

### C1. 确定性分块体检 `assessBlockHealth`

新增纯函数，输入 `RawBlock[]`（或其文本），输出可疑块清单：

```ts
interface SuspiciousBlock {
  questionIndex: number  // 该块对应的题在 HybridResult.questions 中的位置
  text: string           // 该块原始文本
  reason: 'multi-question-num' | 'multi-option-group' | 'length-outlier'
}
```

**关键：块索引 ≠ 题目索引。** 分块后有的块被丢弃（垃圾/答案速查表），有的被材料题分组合并，一个块不总是一对一映射一道题。因此体检**只标记「一对一映射到单独一道题」的可疑块**，并由引擎在生成 `questions` 时解析出 `questionIndex`（引擎持有 block→entry→question 的映射）。被丢弃 / 被材料分组的块一律不标记，避免回填错位。

检测启发式（按精度从高到低）：

1. **块内多题号**（强信号）：块内 ≥2 行行首匹配 `RE_QUESTION_NUM` → 多题粘连。
2. **块内多选项组**（强信号）：块内出现 ≥2 处「选项字母重置到 A」（即多个独立的 A/B/C… 组）→ 多道选择题粘连。
3. **块长离群**（兜底，针对无题号文档）：块字符长度 > 全体中位数 × K 且 > 绝对下限（如中位数×3 且 >400 字）→ 疑似内含多题。

高精度信号（1、2）单独命中即标可疑；离群信号（3）作为无编号文档的兜底。

### C2. AI 补切 `reblockWithAI`

仅对 `SuspiciousBlock` 调 AI。AI 提示词只要求：给定一段文本（带行号），返回每道题的**起始行号数组**，不返回任何题目内容。

```
输入：带行号的可疑块文本
输出：{"starts": [0, 5, 11]}   // 每道题从第几行开始
```

Token 开销极小（输出仅数字）。返回后按行号切分该块文本为 N 段。

### C3. 重解析与回填

对每个被切开的可疑块（按 `questionIndex` 定位原题）：

1. 按 AI 返回的行号把块文本切成 N 段。
2. 每段单独走 `parseWithRulesHybrid(segment).questions`。
3. 用得到的 N 道题**替换**原 `hybrid.questions[questionIndex]` 那 1 道（沿用现有 repair 阶段的按索引回填模式）。多块回填时从后往前处理，避免前面的插入移动后续索引。

失败处理：AI 返回非法（`starts` 为空 / 越界 / 只有 1 段）→ 保留原块不动。

### C4. 编排接入

在 [ImportView.vue](../../../src/views/ImportView.vue) `handleParse` 中，位置在 `parseWithRulesHybrid` 之后、`repairWithAI` 之前：

```
hybrid = parseWithRulesHybrid(text)
[新增] if (AI Key && suspicious = assessBlockHealth(...); suspicious.length):
          hybrid = await reblockWithAI(hybrid, suspicious)   // 重切+重解析+回填
if (shouldTryProfileParse) → profile 重解析
→ repairWithAI(...)
```

体检需要访问 blocks，`HybridResult` 增加可选字段 `suspiciousBlocks?: SuspiciousBlock[]`，由 `parseHybridInternal` 在分块后填充（体检本身是同步纯函数，AI 补切在 ImportView 异步编排）。

---

## 阶段二 · 方案 B：方言 DSL 扩展

主攻「怪格式方言」。

### B1. `RuleProfile` 扩展

```ts
export interface RuleProfile {
  questionStart?: string   // 已有
  optionStart?: string     // 已有
  answerMarker?: string    // 新增：覆盖 RE_ANSWER（答案标记，如「参考答案」「答」）
  analysisMarker?: string  // 新增：覆盖 RE_ANALYSIS（解析标记，如「详解」「分析」）
}
```

**判断题写法（√×/对错/TF/AB）本轮不做**——现有 `RE_JUDGE_*` 有 5 处、互相耦合，改造成本高、频率低，列为后续。本轮方言覆盖聚焦「四个结构标记」：题号头、选项头、答案标记、解析标记。

### B2. 引擎注入机制

沿用现有 `RE_QUESTION_NUM` / `RE_OPTION_HEAD` 的 `let` + save/restore 模式：

- 把 `RE_ANSWER`、`RE_ANALYSIS` 从 `const` 改为 `let`。
- 在 [`parseWithRulesHybrid`](../../../src/services/rule-parser.ts) 里按 `profile.answerMarker` / `profile.analysisMarker` 临时覆盖，`finally` 还原。
- 每个注入正则用 `safeRegExp` 校验，非法则保留默认（**逐字段独立回退**，互不影响）。

### B3. AI 推断扩展

- [`ParseProfile`](../../../src/services/profile-parser.ts) 接口、`DEFAULT_PROFILE`、`PROFILE_SYSTEM` 提示词均增加 `answerMarker` / `analysisMarker` 两字段，AI 一次推断四字段。
- `parseWithDetectedProfile` 把四字段透传给 `RuleProfile`。
- `isProfileResultBetter` / `profileParseScore` 现有采纳门槛不变——方言字段只会提升 profiled 结果质量，门槛自动保护不回退。

---

## 组件边界与数据流

```
rule-parser.ts
  ├─ assessBlockHealth(blocks): SuspiciousBlock[]        [C1, 新增, 纯同步]
  ├─ parseHybridInternal → HybridResult{+suspiciousBlocks} [C 填充]
  ├─ RuleProfile{+answerMarker,+analysisMarker}          [B1]
  └─ parseWithRulesHybrid 注入 answer/analysis 正则       [B2]

importer.ts / 新模块
  └─ reblockWithAI(hybrid, suspicious): Promise<HybridResult>  [C2,C3, AI]

profile-parser.ts
  └─ ParseProfile / PROFILE_SYSTEM / detectProfile 扩四字段  [B3]

ImportView.vue handleParse
  └─ 规则解析 → [C 补切] → [B profile 重解析] → AI 修复      [C4 编排]
```

## 错误处理

| 场景 | 行为 |
|------|------|
| 无 AI Key | 跳过 C 补切与 B profile，纯规则解析（当前行为） |
| C AI 调用失败/超时 | 保留原分块，继续后续流程 |
| C AI 返回非法边界 | 该块保留不动 |
| B 某字段正则非法 | 该字段回退默认，其余字段仍生效 |
| B profiled 结果更差 | `isProfileResultBetter` 拒绝采纳，保留原结果 |

## 测试策略

- **C1 `assessBlockHealth`**：单元测试三类信号——多题号粘连块、多选项组粘连块、长度离群块，各造正/负样例。
- **C2/C3 补切回填**：mock AI 返回行号，验证 1 块 →N 题的替换与索引回填正确；非法返回时原块不变。
- **B2 注入**：给定自定义 `answerMarker`/`analysisMarker` 的 profile，验证引擎按新标记解析；非法正则验证回退默认。
- **B3 推断**：mock `chatJson` 返回四字段，验证透传与 `DEFAULT_PROFILE` 兜底。
- **回归**：现有 rule-parser 测试全绿（若无则先补关键路径快照）。

## 非目标（YAGNI）

- 判断题写法方言注入（`RE_JUDGE_*` 改造）——后续。
- 方案 D：profile 按来源缓存——后续快赢，非本轮。
- 方案 A：整篇 AI 解析开关——非本轮。
- 扫描件/排版感知（方案 E）——待实际需求。
