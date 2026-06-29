# 题库解析管线改进方案（交付 Codex 执行）

> 目标：提升解析泛用性、健壮性与 token 经济性。六个独立任务，建议按编号顺序执行；
> 每个任务都应**独立成一次提交**，并通过 `npm run type-check`（即 `vue-tsc --noEmit`）。
>
> 关键既有结构（执行前先读）：
> - `src/services/rule-parser.ts`：`parseWithRulesHybrid(text)` → `{ questions, lowConfidenceBlocks, lowConfidenceIndices }`；
>   内部 `splitIntoBlocks` / `parseBlock` / `detectType` / `normalizeAnswer` / `computeConfidence`。
> - `src/services/importer.ts`：`ParsedQuestion` 接口；`parseQuestionsWithAI(text, hint?)`（全文 AI）；
>   `repairWithAI(blocks)`（分批修复，返回 `Map<number, ParsedQuestion>`）。
> - `src/services/ai.ts`：`chat` / `chatJson<T>`（OpenAI 兼容，已支持 `response_format:json_object`）。
> - `src/views/ImportView.vue`：`doParse()` 编排两条路径。
> - `ParsedQuestion = { type, stem, options?, answer, analysis?, imagePlaceholders?, confidence? }`
> - `QuestionType = 'single'|'multiple'|'judge'|'fill'|'short'|'essay'`

---

## 任务 1：全文 AI 路径加分块（修复大文档必崩）

### 背景
`parseQuestionsWithAI` 当前把整篇文本一次性发给 AI。大文档（数百题）会让输出 JSON 撞模型 output 上限被截断，`chatJson` 的 `JSON.parse` 失败抛错，**整次解析全部丢失**。`repairWithAI` 已有分批模式，全文路径却没有。

### 涉及文件
- `src/services/importer.ts`
- `src/services/rule-parser.ts`（导出分块辅助）

### 实现步骤
1. 在 `rule-parser.ts` 导出一个**纯文本分块**辅助（不解析，只切边界），供 AI 路径复用题号/空行边界：
   ```ts
   // rule-parser.ts —— 导出，仅按题号/章节/空行切分原始文本块
   export function splitRawChunks(text: string): string[] {
     const lines = text.split(/\r?\n/)
     const expanded = expandInlineOptions(lines)
     const blocks = splitIntoBlocks(expanded)        // 复用既有逻辑
     return blocks.map(b => b.lines.join('\n').trim()).filter(Boolean)
   }
   ```
2. 在 `importer.ts` 改造 `parseQuestionsWithAI`：
   - 设阈值 `const SINGLE_CALL_LIMIT = 6000`。文本 ≤ 阈值 → 维持原单次调用。
   - 超过阈值 → 用 `splitRawChunks` 得到 blocks，再按 `MAX_BATCH_CHARS`（任务 5 调到 8000）打包成批，**并行** `Promise.allSettled` 发送，每批用同一 `SYSTEM_PROMPT`。
   - 合并各批 `questions`；按 `归一化 stem` 去重（消除分块接缝处可能的重复题）。
   - 单批 `JSON.parse` 失败不应拖垮整体：`allSettled` 已隔离；额外对单批做一次 JSON 修复重试（见下）。
3. 在 `ai.ts` 的 `chatJson` 增加**一次**容错重试：解析失败时，把原始返回再发一轮「仅修复为合法 JSON，不改内容」的请求（可选，低优先，先用 `allSettled` 隔离即可）。

### 代码骨架（importer.ts）
```ts
export async function parseQuestionsWithAI(text: string, hint?: string): Promise<ParsedQuestion[]> {
  if (text.length <= SINGLE_CALL_LIMIT) {
    return callOnce(text, hint)            // 抽出原逻辑
  }
  const chunks = splitRawChunks(text)
  const batches = packByChars(chunks, MAX_BATCH_CHARS)   // 复用 repairWithAI 的打包逻辑
  const settled = await Promise.allSettled(batches.map(b => callOnce(b, hint)))
  const all: ParsedQuestion[] = []
  for (const r of settled) if (r.status === 'fulfilled') all.push(...r.value)
  return dedupeByStem(all)
}
```
- 把 `repairWithAI` 里的「按 `MAX_BATCH_CHARS` 打包」抽成共享函数 `packByChars(items, limit)`，两处复用。
- `dedupeByStem`：`stem.trim().replace(/\s+/g,'')` 作 key，保留首个。

### 验收标准
- 构造一个 >200 题、>30k 字符的文档，AI 解析不再报错、题数合理（与单次小文档解析的单题质量一致）。
- 小文档行为不变（仍单次调用）。
- `npm run type-check` 通过。

### 风险
- 接缝处可能把一道题切成两半 → 靠 `splitRawChunks` 的题号边界规避；去重兜底。无题号文档接缝丢题可接受（属任务 6 范畴）。

---

## 任务 2：文末答案回填（补最大适配盲区）

### 背景
国内题库最常见排版之一：题目区不带答案，所有答案集中在文末（`参考答案：1.A 2.B…` 或 `1-5 ABCDA`）。当前 `splitIntoBlocks` 只认题号边界，文末答案会被当成一道乱题，且题目全部缺答案。

### 涉及文件
- `src/services/rule-parser.ts`

### 实现步骤
1. **保留题号**：当前 `parseBlock` 用 `RE_QUESTION_NUM` 把题号 strip 掉了。改为先捕获题号数字，存入返回结构。
   - 给 `ParsedQuestion` 增加可选内部字段不合适（它是对外结构）；改为在 `parseWithRulesHybrid` 内部维护一个并行数组 `seqs: (number|undefined)[]`，或给 `RawBlock` 增加 `seq?: number` 并在 `parseBlock` 返回时一并带出（推荐：`parseBlock` 返回 `{ q, seq }`）。
2. **识别答案区**：新增 `extractAnswerKey(blocks): { answerMap: Map<number,string>, keyBlockIdx: Set<number> }`。
   - 判定一个 block 为答案区：其有效行中 ≥60% 命中
     `/^[\s　]*[(（]?(\d{1,3})[)）]?\s*[.、:：)]\s*(答案[:：]?\s*)?([A-Ha-h]+|[√✓×✗]|对|错|正确|错误|[TF])\b/`
     或整块命中「`参考答案`/`答案`」标题。
   - 解析两类格式写入 `answerMap`：
     - 逐条：`(\d+)\s*[.、):：]\s*([A-Ha-h]+|[√×]|对|错|T|F)`（全局匹配，一行可多条）。
     - 区间：`(\d+)\s*[-~—]\s*(\d+)\s*[:：]?\s*([A-Ha-h]+)` → 把字母逐个分配到区间内题号（长度需匹配，不匹配则跳过该段）。
3. **回填**：在 `parseWithRulesHybrid` 主循环后，对每道 `answerRaw` 为空（即 `q.answer` 为空串/空数组）的题，按其 `seq` 查 `answerMap`；命中则：
   - 重新走 `detectType(stem, options, 命中答案, sectionType)` 与 `normalizeAnswer`，覆盖 `q.type` / `q.answer`；
   - 重算 `computeConfidence`（任务 3 后会自动升为高置信）。
4. **剔除答案区块**：`keyBlockIdx` 对应的 block 不得作为题目进入 `questions`。

### 代码骨架
```ts
function extractAnswerKey(blocks: RawBlock[]): { answerMap: Map<number,string>; keyIdx: Set<number> } {
  const answerMap = new Map<number, string>()
  const keyIdx = new Set<number>()
  blocks.forEach((b, i) => {
    const t = b.lines.join('\n')
    if (!looksLikeAnswerKey(t)) return
    keyIdx.add(i)
    for (const m of t.matchAll(/(\d{1,3})\s*[.、):：]\s*([A-Ha-h]+|[√✓×✗]|对|错|正确|错误|[TF])/g)) {
      answerMap.set(Number(m[1]), m[2])
    }
    for (const m of t.matchAll(/(\d{1,3})\s*[-~—]\s*(\d{1,3})\s*[:：]?\s*([A-Ha-h]+)/g)) {
      const [s,e,letters] = [Number(m[1]), Number(m[2]), m[3]]
      if (e - s + 1 === letters.length) for (let n=s;n<=e;n++) answerMap.set(n, letters[n-s])
    }
  })
  return { answerMap, keyIdx }
}
```

### 验收标准
- 文档形如「题目区无答案 + 文末 `参考答案：1.A 2.B 3.AC`」→ 每题答案正确回填，文末答案块不出现在题列表。
- 区间格式 `1-5 ABCDA` 正确展开。
- 既有「逐题自带答案」文档行为不变（answerMap 为空时不触发任何回填）。

### 风险
- 题号重复（多大题各自从 1 编号）会让 `answerMap` 后者覆盖前者 → MVP 接受；如需精确，后续按「大题分段 + 段内题号」改造（记为 TODO，不在本任务范围）。

---

## 任务 3：置信度改硬证据制（省 token + 减误判）

### 背景
`computeConfidence` 现为「起步 0.5 的粗加法」，导致：完好但缺答案的题被误判低置信→白送 AI；高置信垃圾块漏修。阈值 `CONFIDENCE_THRESHOLD = 0.6`。

### 涉及文件
- `src/services/rule-parser.ts`

### 实现步骤
重写 `computeConfidence(type, stem, options, answer)` 为证据驱动：
```ts
function computeConfidence(type, stem, options, answer): number {
  if (!stem || stem.length < 3) return 0.2
  const garbled = options.filter(isGarbledLine).length > 0 || isGarbledLine(stem)
  let score: number

  if ((type === 'single' || type === 'multiple') && options.length >= 2 && /[A-Ha-h]/.test(answer)) {
    score = 0.95                              // 选项+字母答案：规则绝对可靠，锁定不送 AI
  } else if (type === 'judge' && /^(对|错|正确|错误|[√✓×✗TF])/.test(answer.trim())) {
    score = 0.95
  } else if (type === 'fill' && RE_BLANK.test(stem) && answer) {
    score = 0.9
  } else if (answer && stem.length > 5) {
    score = 0.7                               // 主观题有题干有答案
  } else if (!answer) {
    score = 0.4                               // 缺答案 → 交给 AI（含文末答案回填失败的情况）
  } else {
    score = 0.55
  }

  if (garbled) score -= 0.4
  if (stem.length > 200 && (stem.match(RE_CN_PUNCT) || []).length < 2) score -= 0.2
  return Math.max(0, Math.min(score, 1))
}
```
> 注意：本任务须在**任务 2 之后**生效顺序上跑——即先回填文末答案，再算置信度，避免「本可回填却因缺答案被判低置信送 AI」。在 `parseWithRulesHybrid` 中保证：回填 → 重算 confidence → 再筛 lowConfidence。

### 验收标准
- 一道「四选项 + 答案 A」的单选，`confidence ≥ 0.9`，不进入 `lowConfidenceBlocks`。
- 一道缺答案的简答，`confidence < 0.6`，进入低置信送 AI。
- 含乱码选项的块置信明显下降。

### 风险
- 阈值调整可能改变送 AI 的题量；用真实文档回归一次，确认 token 调用数下降且无明显漏修。

---

## 任务 4：AI 结果复用 normalizeAnswer 做校验（入库质量）

### 背景
AI 可能返回 `type:'single'` 却 `answer:'AB'`、`multiple` 缺 options、judge 答案非 T/F，目前直接入库。规则侧已有 `normalizeAnswer` / `detectType` 可复用。

### 涉及文件
- `src/services/rule-parser.ts`（导出 `normalizeAnswer`、`detectType`）
- `src/services/importer.ts`（新增 `sanitizeParsed` 并在两条 AI 路径出口调用）

### 实现步骤
1. `rule-parser.ts` 导出 `normalizeAnswer` 和 `detectType`。
2. `importer.ts` 新增：
   ```ts
   import { detectType, normalizeAnswer } from './rule-parser'

   export function sanitizeParsed(q: ParsedQuestion): ParsedQuestion | null {
     const stem = (q.stem || '').trim()
     if (!stem) return null
     const options = q.options?.map(o => (o ?? '').toString()) ?? []
     const rawAnswer = Array.isArray(q.answer) ? q.answer.join('') : (q.answer ?? '').toString()
     // 证据校正题型（选项/答案字母数优先于 AI 自报 type）
     const type = detectType(stem, options, rawAnswer)   // 不传 sectionType
     const answer = normalizeAnswer(type, rawAnswer, options)
     return {
       ...q,
       type,
       stem,
       options: options.length ? options : undefined,
       answer,
       confidence: Math.max(0, Math.min(q.confidence ?? 0.8, 1)),
     }
   }
   ```
   > 注意 `detectType` 对 multiple 的判定依赖「答案含多个字母」。若 AI 已正确给出 `['A','C']`，`rawAnswer='AC'` 会被正确判为 multiple——逻辑自洽。但要避免对填空/主观题误判：`detectType` 末尾已按长度回退 short/essay，可接受；如发现主观题被误判，给 `sanitizeParsed` 加一条「AI 原 type 为 short/essay 且无选项无字母答案时保留原 type」的短路。
3. 在 `parseQuestionsWithAI` 返回前、`repairWithAI` 写入 Map 前，逐条 `sanitizeParsed`，`null` 则丢弃。

### 验收标准
- 喂入「AI 返回 single 但答案 AB」→ 入库为 multiple、答案 `['A','B']`。
- judge 答案「正确」→ 归一为 `'T'`。
- 空 stem 项被丢弃。

### 风险
- 主观题误判题型：按上述短路规则兜底；用含简答/论述的文档回归。

---

## 任务 5：AI 结果按块缓存 + 调大批次（长期省 token）

### 背景
`repairWithAI` 每次导入都重发；`MAX_BATCH_CHARS=3000` 过小导致 system prompt 重复发送 N 次。

### 涉及文件
- `src/db/index.ts`（新增缓存表）
- `src/services/importer.ts`

### 实现步骤
1. **缓存表**：`db/index.ts` 升 `version(3)`，新增
   ```ts
   parseCache!: Table<{ hash: string; value: string; createdAt: number }, string>
   // version(3).stores({ parseCache: 'hash, createdAt' })   // 其余表沿用 version(2) 定义
   ```
   > Dexie 升版只需声明变化表；未变表无需重复（但保留既有声明不报错）。务必保留 version(1)(2) 定义不动，仅追加 version(3)。
2. **缓存键**：`hash = sha256(CACHE_VERSION + ' ' + blockText)`，`CACHE_VERSION` 为常量字符串，**每次改 REPAIR_SYSTEM 提示词就改它**以失效旧缓存。用 `src/utils/hash.ts` 的 `sha256`。
3. **改造 `repairWithAI`**：
   - 先批量查缓存：命中的 block 直接还原 `ParsedQuestion`，不进 AI。
   - 仅未命中的 block 打包（`MAX_BATCH_CHARS` 调到 **8000**）发送。
   - 收到结果后 `sanitizeParsed`（任务 4）→ 写回缓存 → 合并。
   - 返回的 `Map<number, ParsedQuestion>` 的 key 仍是「`blocks` 数组的原始下标」，缓存命中项也要按原下标填回（注意保持下标映射正确，别用批内局部下标）。
4. **上下文缓存友好**：确保每批 messages 第一条恒为完全相同的 `REPAIR_SYSTEM`（DeepSeek 等对相同前缀自动命中上下文缓存，命中价约 1/10）。不要把可变内容混进 system 段。

### 代码骨架
```ts
const CACHE_VERSION = 'repair-v1'
async function blockHash(b: string) { return sha256(CACHE_VERSION + ' ' + b) }

export async function repairWithAI(blocks: string[]): Promise<Map<number, ParsedQuestion>> {
  const out = new Map<number, ParsedQuestion>()
  const misses: { idx: number; hash: string; text: string }[] = []
  await Promise.all(blocks.map(async (text, idx) => {
    const hash = await blockHash(text)
    const hit = await db.parseCache.get(hash)
    if (hit) { const q = JSON.parse(hit.value); if (q) out.set(idx, q) }
    else misses.push({ idx, hash, text })
  }))
  // 仅对 misses 打包 + 调用 AI（沿用现有并行批次逻辑，MAX_BATCH_CHARS=8000）
  // 每条结果 sanitizeParsed 后：out.set(miss.idx, q) 且 db.parseCache.put({hash, value:JSON.stringify(q), createdAt:Date.now()})
  return out
}
```

### 验收标准
- 同一文档连续导入两次：第二次 `repairWithAI` 不产生网络请求（全命中缓存）。
- 改 `CACHE_VERSION` 后缓存失效、重新请求。
- 批次数随 `MAX_BATCH_CHARS` 增大而下降。

### 风险
- Dexie 升版需测试既有用户数据迁移无碍（只加表，零迁移风险）。
- 缓存表无限增长 → 可加「`createdAt` 早于 30 天的清理」为可选 TODO。

---

## 任务 6：材料题 / 题组支持（MVP，无 schema 改动）

### 背景
材料题（一段共享材料 + 多个小问）当前被拆成独立题，材料丢失。完整方案需给 `Question` 加 `material` 字段（动 types/db/QuestionCard 渲染），本任务先做**不动数据模型**的 MVP：把材料文本前置拼进每个小问的 stem。

### 涉及文件
- `src/services/rule-parser.ts`

### 实现步骤
1. **识别题组引导块**：一个 block 满足
   - 无选项、无答案，且
   - 命中引导词：`/(阅读(下列)?材料|案例分析|根据(以下|下列|下面)(材料|资料|案例|图表)|材料[一二三四：:]|^[（(][一二三四五][）)])/`，或以冒号结尾且其后紧跟以 `(1)/（1）/1)/①` 起头的小问序列。
2. **识别小问**：紧随引导块、以 `/^[\s　]*[(（]?[\d①-⑩]+[)）.、]/` 起头的连续块。
   > 注意：小问序号常用 `(1)(2)` 或 `①②`，与大题题号 `1.` 不同；`splitIntoBlocks` 已按 `RE_QUESTION_NUM` 切到独立 block，本任务在 `parseWithRulesHybrid` 拿到 `questions`/`blocks` 后做**后处理归组**。
3. **归组拼接**：对识别出的题组，取材料文本 `material`，对每个小问 `q`：
   ```ts
   q.stem = `【材料】${material}\n\n${q.stem}`
   ```
   并从 `questions` 移除独立的「材料引导块」对应项（它不该作为题）。
4. 设计为**后处理函数** `groupMaterialQuestions(questions, blocks)`，在主流程末尾调用；无材料题时完全不改动结果。

### 验收标准
- 「阅读材料：xxx\n（1）问A（2）问B」→ 输出 2 题，各自 stem 前含 `【材料】xxx`，无多余「材料」题。
- 普通题库不受影响。

### 风险
- 误归组（把普通题前的说明文字当材料）→ 引导词正则保持收紧；MVP 可接受偶发漏归组（退化为独立题，不影响可用性）。
- 材料在多题间重复存储 → 已知取舍；完整方案（加 `material` 字段）记为后续任务。

---

## 执行顺序与依赖

```
任务 2（文末答案回填） ─┐
任务 3（硬证据置信度） ─┴─▶ 必须 2 在 3 之前（先回填再算置信度）
任务 4（AI 结果校验）  ──▶ 导出 normalizeAnswer/detectType，任务 1/5 出口都应调用
任务 1（全文 AI 分块） ──▶ 依赖 splitRawChunks；可复用任务 5 的 packByChars
任务 5（缓存+批次）    ──▶ 依赖任务 4 的 sanitizeParsed
任务 6（材料题 MVP）   ──▶ 独立，可最后做
```

建议提交顺序：**4 → 2 → 3 → 1 → 5 → 6**（先把校验/导出底座铺好，再叠功能）。

## 全局验收
- 每个任务后 `npm run type-check` 必须通过。
- 用 3 份真实题库回归：①逐题带答案 ②文末集中答案 ③材料题；确认题数、题型、答案正确，AI 调用次数较改造前下降。
