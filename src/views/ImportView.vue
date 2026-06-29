<script setup lang="ts">
import { ref, reactive, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showFailToast, showSuccessToast } from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { useSettingsStore } from '@/stores/settings'
import { questionsRepo, type QuestionInput } from '@/db/questions'
import { sha256 } from '@/utils/hash'
import { parseFile, getFileExt, ACCEPT_EXTENSIONS } from '@/services/file-parser'
import { saveImages, type ParsedImage } from '@/services/docx-parser'
import { repairWithAI, generateAnswer, type ParsedQuestion } from '@/services/importer'
import { parseWithRulesHybrid } from '@/services/rule-parser'
import {
  isProfileResultBetter,
  parseWithDetectedProfile,
  shouldTryProfileParse,
} from '@/services/profile-parser'
import ThemedSelect from '@/components/ThemedSelect.vue'
import type { SelectOption } from '@/components/ThemedSelect.vue'
import AdminDialog from '@/components/AdminDialog.vue'
import { useAdminStore } from '@/stores/admin'
import { QUESTION_TYPE_LABELS, type QuestionType } from '@/types'

defineOptions({ name: 'ImportView' })

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()
const settingsStore = useSettingsStore()
const adminStore = useAdminStore()

const showAdminDialog = ref(false)

const step = ref<1 | 2 | 3>(1) // 1上传 2解析 3预览
const selectedSubjectId = ref((route.query.subjectId as string) || '')
const fileRef = ref<File | null>(null)
const parsing = ref(false)
const parseError = ref('')

const parsed = ref<ParsedQuestion[]>([])
const images: ParsedImage[] = []
const pdfProgress = ref('')
const editingIdx = ref<number | null>(null)
const repairing = ref(false)
const repairCount = ref(0)
const saving = ref(false)
const AUTO_REPAIR_LIMIT = 40

const types: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']

const steps = [
  { n: 1, label: '选择文档' },
  { n: 2, label: '解析配置' },
  { n: 3, label: '预览导入' },
]

const lowConfidenceCount = computed(
  () => parsed.value.filter((p) => (p.confidence ?? 1) < 0.6).length,
)

const subjectOptions = computed<SelectOption[]>(() =>
  subjectsStore.list.map((s) => ({ value: s.id, label: s.name })),
)
const typeOptions = computed<SelectOption[]>(() =>
  types.map((t) => ({ value: t, label: QUESTION_TYPE_LABELS[t] })),
)

/** 把编辑态答案字符串与数组互转 */
function editAnswer(p: ParsedQuestion, val: string) {
  if (p.type === 'multiple' || p.type === 'fill') {
    p.answer = val
      .split(/[、,，;;\n]/)
      .map((s) => s.trim())
      .filter(Boolean)
  } else {
    p.answer = val
  }
}
function answerInputVal(p: ParsedQuestion): string {
  return Array.isArray(p.answer) ? p.answer.join('、') : p.answer
}
function isChoiceQuestion(p: ParsedQuestion): boolean {
  return p.type === 'single' || p.type === 'multiple'
}
function isAnswerOptionSelected(p: ParsedQuestion, key: string): boolean {
  return Array.isArray(p.answer)
    ? p.answer.includes(key)
    : p.answer
        .split('')
        .map((s) => s.trim())
        .includes(key)
}
function toggleAnswerOption(p: ParsedQuestion, key: string) {
  if (p.type === 'single') {
    p.answer = key
    return
  }
  const selected = new Set(
    Array.isArray(p.answer)
      ? p.answer.map(String)
      : String(p.answer || '')
          .split('')
          .filter(Boolean),
  )
  if (selected.has(key)) selected.delete(key)
  else selected.add(key)
  p.answer = Array.from(selected).sort()
}
function pruneChoiceAnswer(p: ParsedQuestion) {
  if (!isChoiceQuestion(p)) return
  const allowed = new Set((p.options ?? []).map((_, i) => String.fromCharCode(65 + i)))
  const current = Array.isArray(p.answer)
    ? p.answer.map(String)
    : String(p.answer || '')
        .split('')
        .filter(Boolean)
  const valid = current.filter((key) => allowed.has(key))
  p.answer = p.type === 'single' ? valid[0] || '' : valid.sort()
}
function confirmEdit(p: ParsedQuestion) {
  pruneChoiceAnswer(p)
  editingIdx.value = null
}

function editOption(p: ParsedQuestion, i: number, val: string) {
  if (!p.options) p.options = []
  p.options[i] = val
}
function addOption(p: ParsedQuestion) {
  if (!p.options) p.options = []
  p.options.push('')
}
function removeOption(p: ParsedQuestion, i: number) {
  p.options?.splice(i, 1)
  pruneChoiceAnswer(p)
}

function prioritizeReviewQuestions(
  questions: ParsedQuestion[],
  aiCandidates = new WeakSet<ParsedQuestion>(),
): ParsedQuestion[] {
  return questions
    .map((q, i) => ({
      q,
      i,
      priority: aiCandidates.has(q) || (q.confidence ?? 1) < 0.6,
    }))
    .sort((a, b) => {
      if (a.priority !== b.priority) return a.priority ? -1 : 1
      return a.i - b.i
    })
    .map((item) => item.q)
}

function onFileRead(file: any) {
  const f: File = file.file || file
  const ext = getFileExt(f.name)
  if (!ext) {
    showFailToast('支持 .docx / .md / .pdf 格式')
    return
  }
  if (ext === 'pdf' && !settingsStore.ocr.token) {
    showFailToast('PDF 导入需先在设置中配置 PaddleOCR Token')
    return
  }
  fileRef.value = f
  step.value = 2
}

function reselectFile() {
  fileRef.value = null
  step.value = 1
}

async function doParse() {
  if (!fileRef.value) return
  if (!selectedSubjectId.value) {
    showFailToast('请先选择科目')
    return
  }
  parsing.value = true
  parseError.value = ''
  try {
    pdfProgress.value = ''
    const result = await parseFile(fileRef.value, {
      ocrToken: settingsStore.ocr.token,
      onPdfProgress: (p) => {
        if (p.state === 'pending') pdfProgress.value = 'OCR 排队中…'
        else if (p.state === 'running') {
          const pg =
            p.extractedPages && p.totalPages ? ` (${p.extractedPages}/${p.totalPages} 页)` : ''
          pdfProgress.value = `OCR 识别中${pg}`
        } else if (p.state === 'done') pdfProgress.value = 'OCR 完成，正在解析…'
      },
    })
    images.length = 0
    images.push(...result.images)

    // 统一管线：规则解析为主（零 AI 消耗），仅对低完整度块用 AI 判定
    // 注意：lowConfidenceIndices 是基于此数组的位置索引，回填/删除完成前不可过滤，
    // 否则索引会错位。空题干的过滤统一放在所有索引操作之后（见 finalizePreview）。
    let hybrid = parseWithRulesHybrid(result.text)
    if (settingsStore.ai.apiKey && shouldTryProfileParse(hybrid, result.text)) {
      try {
        const profiled = await parseWithDetectedProfile(result.text, (message) => {
          pdfProgress.value = message
        })
        if (isProfileResultBetter(hybrid, profiled)) {
          hybrid = profiled
        }
      } catch (e) {
        console.warn('[import] profile parse failed', e)
      }
    }
    let qs: ParsedQuestion[] = hybrid.questions

    const tooManyRepairBlocks = hybrid.lowConfidenceBlocks.length > AUTO_REPAIR_LIMIT

    // 有低完整度块 + 有 AI 配置 → AI 判定这些块（是题目则结构化，不是则丢弃）
    // 数量过大时不做逐题 AI 修复，避免一次导入把数百题全发给 AI。
    if (hybrid.lowConfidenceBlocks.length > 0 && settingsStore.ai.apiKey && !tooManyRepairBlocks) {
      parsed.value = qs
      const aiCandidates = new WeakSet<ParsedQuestion>()
      hybrid.lowConfidenceIndices.forEach((qIdx) => {
        const q = parsed.value[qIdx]
        if (q) aiCandidates.add(q)
      })
      step.value = 3
      repairing.value = true
      repairCount.value = hybrid.lowConfidenceBlocks.length
      try {
        const repairItems = hybrid.lowConfidenceBlocks.map((block, i) => ({
          block,
          candidate: hybrid.questions[hybrid.lowConfidenceIndices[i]],
        }))
        const fixes = await repairWithAI(repairItems, (done, total) => {
          pdfProgress.value = `AI 判定中（${done}/${total} 批）`
        })
        // AI 判定结果覆盖：修复的题替换，未返回的（判为非题目）标记待删
        const toDelete = new Set<number>()
        for (const [blockIdx, fixed] of fixes) {
          const qIdx = hybrid.lowConfidenceIndices[blockIdx]
          if (qIdx !== undefined && qIdx < parsed.value.length) {
            parsed.value[qIdx] = fixed
            aiCandidates.add(fixed)
          }
        }
        // 低置信度块中 AI 未返回的 → 判为非题目，删除占位
        hybrid.lowConfidenceIndices.forEach((qIdx, blockIdx) => {
          if (!fixes.has(blockIdx)) toDelete.add(qIdx)
        })
        if (toDelete.size > 0) {
          parsed.value = parsed.value.filter((_, i) => !toDelete.has(i))
        }
      } catch {
        // AI 判定失败不影响已有结果
      } finally {
        repairing.value = false
        // 所有索引操作已完成，此时安全过滤空题干，杜绝空白卡片
        parsed.value = prioritizeReviewQuestions(
          parsed.value.filter(isRenderableQuestion),
          aiCandidates,
        )
      }
      return
    }

    if (tooManyRepairBlocks) {
      console.warn(
        `[import] skip AI repair: ${hybrid.lowConfidenceBlocks.length} low-confidence blocks exceeds limit ${AUTO_REPAIR_LIMIT}`,
      )
      showFailToast(`低把握题过多，已跳过批量 AI 修复`)
    }

    const cleaned = prioritizeReviewQuestions(qs.filter(isRenderableQuestion))
    if (cleaned.length === 0) {
      parseError.value = settingsStore.ai.apiKey
        ? '未能识别出题目，请检查文档格式'
        : '未能识别出题目，配置 AI 接口可自动解析不确定的内容'
    } else {
      parsed.value = cleaned
      step.value = 3
    }
  } catch (e: any) {
    parseError.value = e?.message || '解析失败'
  } finally {
    parsing.value = false
  }
}

/** 把 AI 解析结果里的 [IMG_n] 占位符映射为图片 hash */
function placeholderToHash(): (ph: string) => string | undefined {
  return (ph: string) => {
    const m = ph.match(/IMG_(\d+)/)
    if (!m) return undefined
    const idx = Number(m[1])
    return images[idx]?.hash
  }
}

/** 题干非空且题型合法，才允许进入预览/导入（杜绝空白卡片） */
function isRenderableQuestion(q: ParsedQuestion): boolean {
  return !!q?.stem?.trim() && !!QUESTION_TYPE_LABELS[q.type]
}

function answerText(p: ParsedQuestion): string {
  return Array.isArray(p.answer) ? p.answer.join('、') : p.answer || ''
}

/** 按需 AI 生成/校对单题答案 + 解析 */
const aiGen = reactive<Record<number, boolean>>({})
async function genAnswer(p: ParsedQuestion, i: number) {
  if (aiGen[i]) return
  aiGen[i] = true
  try {
    const { answer, analysis } = await generateAnswer({
      type: p.type,
      stem: p.stem,
      options: p.options,
    })
    p.answer = answer
    if (analysis) p.analysis = analysis
    if (typeof p.confidence === 'number') p.confidence = Math.max(p.confidence, 0.7)
  } catch (e: any) {
    showFailToast(e?.message || 'AI 生成失败')
  } finally {
    aiGen[i] = false
  }
}

function removeParsed(i: number) {
  parsed.value.splice(i, 1)
}

async function saveAll() {
  if (saving.value) return
  if (parsed.value.length === 0) {
    showFailToast('没有可导入的题目')
    return
  }
  saving.value = true
  try {
    await doSave()
  } catch (e: any) {
    console.error('[import] save failed', e)
    showFailToast(getErrorMessage(e, '导入失败，请重试'))
  } finally {
    saving.value = false
  }
}

function getErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message.trim()) return error.message
  if (typeof error === 'string' && error.trim()) return error
  if (error && typeof error === 'object') {
    const value = (error as { message?: unknown; name?: unknown }).message
    if (typeof value === 'string' && value.trim()) return value
    const name = (error as { name?: unknown }).name
    if (typeof name === 'string' && name.trim()) return `${fallback}：${name}`
  }
  return fallback
}

function plainAnswer(answer: ParsedQuestion['answer']): string | string[] {
  return Array.isArray(answer) ? answer.map(String).filter(Boolean) : String(answer || '')
}

async function doSave() {
  const subjectId = selectedSubjectId.value
  const toHash = placeholderToHash()
  let imported = 0
  let skipped = 0

  await saveImages(images)

  const candidates: QuestionInput[] = []
  const candidateHashes: string[] = []
  const seenInFile = new Set<string>()

  for (const p of parsed.value) {
    pruneChoiceAnswer(p)
    const stem = p.stem?.trim()
    if (!stem) {
      skipped++
      continue
    }

    const answer = plainAnswer(p.answer)
    const options = p.options?.map((option) => String(option).trim()).filter(Boolean)
    const hash = await sha256(stem + '|' + JSON.stringify(answer))
    if (seenInFile.has(hash)) {
      skipped++
      continue
    }
    seenInFile.add(hash)

    const attachments = (p.imagePlaceholders || []).map(toHash).filter((h): h is string => !!h)

    const input: QuestionInput = {
      subjectId,
      type: p.type,
      stem,
      options,
      answer,
      analysis: p.analysis ? String(p.analysis) : undefined,
      attachments,
      sourceHash: hash,
    }
    candidates.push(input)
    candidateHashes.push(hash)
  }

  const duplicates = await questionsRepo.findDuplicateHashes(subjectId, candidateHashes)
  const inputs = candidates.filter((input) => {
    if (input.sourceHash && duplicates.has(input.sourceHash)) {
      skipped++
      return false
    }
    return true
  })

  if (inputs.length > 0) {
    const created = await questionsRepo.createBulk(inputs)
    imported = created.length
  }

  if (imported === 0) {
    throw new Error(skipped > 0 ? '没有新题可导入，可能已全部存在或为空' : '没有可导入的题目')
  }

  showSuccessToast(`已导入 ${imported} 题${skipped ? `，跳过 ${skipped} 题` : ''}`)
  router.replace({ name: 'subject-detail', params: { subjectId } })
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB'
  return (bytes / 1024 / 1024).toFixed(1) + ' MB'
}

onMounted(async () => {
  await adminStore.load()
  // 未通过管理员验证时弹出密码弹窗
  if (!adminStore.canOperate()) {
    showAdminDialog.value = true
  }
  await subjectsStore.load()
  if (!selectedSubjectId.value && subjectsStore.list.length === 1) {
    selectedSubjectId.value = subjectsStore.list[0].id
  }
})

function onAdminVerified() {
  // 验证成功，继续正常流程
}

function onAdminDialogClose() {
  // 未验证就关闭弹窗 → 返回上一页
  if (!adminStore.canOperate()) {
    router.back()
  }
}
</script>

<template>
  <div class="page">
    <!-- 头部 -->
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">导入题库</h1>
      </div>
    </div>

    <!-- 步骤指示器（自定义，不用 van-steps） -->
    <div class="stepper">
      <template v-for="(s, i) in steps" :key="s.n">
        <div
          :class="[
            'stepper__node',
            step >= s.n && 'stepper__node--active',
            step === s.n && 'stepper__node--current',
          ]"
        >
          <van-icon v-if="step > s.n" name="success" size="14" />
          <span v-else>{{ s.n }}</span>
        </div>
        <span :class="['stepper__label', step >= s.n && 'stepper__label--active']">{{
          s.label
        }}</span>
        <div
          v-if="i < steps.length - 1"
          :class="['stepper__line', step > s.n && 'stepper__line--done']"
        ></div>
      </template>
    </div>

    <!-- ===== 步骤 1：选择文档 + 科目 ===== -->
    <div v-if="step === 1" class="step-body">
      <div class="card">
        <div class="field">
          <label class="field__label">导入到科目</label>
          <ThemedSelect
            v-model="selectedSubjectId"
            :options="subjectOptions"
            placeholder="选择科目"
          />
          <p v-if="!selectedSubjectId" class="field__hint">还未选择科目，可在「题库」页新建</p>
        </div>
      </div>

      <!-- 拖拽上传区 -->
      <div class="upload-zone">
        <van-uploader :after-read="onFileRead" :accept="ACCEPT_EXTENSIONS" :max-count="1">
          <div class="upload-zone__inner">
            <div class="upload-zone__icon">
              <van-icon name="description" size="32" />
            </div>
            <div class="upload-zone__title">选择文档</div>
            <div class="upload-zone__desc">支持 .docx / .md / .pdf，自动解析题型与答案</div>
          </div>
        </van-uploader>
      </div>
    </div>

    <!-- ===== 步骤 2：解析配置 ===== -->
    <div v-else-if="step === 2" class="step-body">
      <!-- 已选文件展示 -->
      <div class="card file-card">
        <div class="file-card__icon">
          <van-icon name="description" size="22" />
        </div>
        <div class="file-card__info">
          <div class="file-card__name">{{ fileRef?.name }}</div>
          <div class="file-card__size" v-if="fileRef">{{ fmtSize(fileRef.size) }}</div>
        </div>
        <van-icon name="cross" size="16" color="var(--text-3)" @click="reselectFile" />
      </div>

      <!-- 解析说明 -->
      <div class="card">
        <div class="parse-info">
          <van-icon name="records" size="18" color="var(--brand)" />
          <div>
            <div class="parse-info__title">智能解析</div>
            <div class="parse-info__desc">
              优先本地规则匹配题号、选项、答案{{
                settingsStore.ai.apiKey
                  ? '，低置信度题目自动 AI 修复'
                  : '。配置 AI 后可自动修复低置信度题目，提升准确率'
              }}
            </div>
          </div>
        </div>
      </div>

      <!-- 解析按钮 -->
      <div class="btn-center">
        <van-button
          type="primary"
          round
          block
          :loading="parsing"
          :loading-text="pdfProgress || '解析中…'"
          @click="doParse"
        >
          开始解析
        </van-button>
        <transition name="page-fade">
          <div v-if="parseError" class="parse-error">
            <van-icon name="warning-o" />
            <span>{{ parseError }}</span>
          </div>
        </transition>
      </div>
    </div>

    <!-- ===== 步骤 3：预览确认 ===== -->
    <div v-else class="step-body">
      <!-- 统计栏 -->
      <div class="preview-bar">
        <div class="preview-bar__stats">
          <span class="preview-bar__num">{{ parsed.length }}</span> 题
          <template v-if="images.length">
            <span class="preview-bar__sep">·</span>
            <span class="preview-bar__num">{{ images.length }}</span> 图
          </template>
        </div>
        <div v-if="repairing" class="preview-bar__repair">
          <van-loading size="13" />
          AI 修复 {{ repairCount }} 题中…
        </div>
        <div v-else-if="lowConfidenceCount > 0" class="preview-bar__warn">
          <van-icon name="warning-o" size="13" />
          {{ lowConfidenceCount }} 题把握低
        </div>
      </div>

      <!-- 题目列表 -->
      <div class="preview-list">
        <van-swipe-cell
          v-for="(p, i) in parsed"
          :key="i"
          class="swipe-card"
          :class="{ 'swipe-card--low': (p.confidence ?? 1) < 0.6 }"
        >
          <div class="q-item">
            <div class="q-item__head">
              <span class="chip">{{ QUESTION_TYPE_LABELS[p.type] }}</span>
              <span v-if="(p.confidence ?? 1) < 0.6" class="chip chip--danger">把握低</span>
              <span class="q-item__idx">#{{ i + 1 }}</span>
              <button
                :class="['q-item__edit', editingIdx === i && 'q-item__edit--active']"
                @click="editingIdx = editingIdx === i ? null : i"
              >
                <van-icon :name="editingIdx === i ? 'cross' : 'edit'" size="14" />
              </button>
            </div>

            <!-- 浏览态 -->
            <template v-if="editingIdx !== i">
              <div class="q-item__stem">{{ p.stem }}</div>
              <div v-if="p.options?.length" class="q-item__options">
                <div v-for="(opt, oi) in p.options" :key="oi">
                  <span class="q-item__opt-key">{{ String.fromCharCode(65 + oi) }}</span>
                  <span>{{ opt }}</span>
                </div>
              </div>
              <div class="q-item__answer">
                <van-icon name="success" size="13" />
                <span v-if="answerText(p)">{{ answerText(p) }}</span>
                <span v-else class="q-item__answer-empty">缺答案</span>
                <button
                  v-if="settingsStore.ai.apiKey"
                  class="ai-gen-btn"
                  :disabled="aiGen[i]"
                  @click="genAnswer(p, i)"
                >
                  <van-loading v-if="aiGen[i]" size="12" />
                  <template v-else><van-icon name="bulb-o" size="12" /> AI
                    {{ answerText(p) ? '校对' : '补答案' }}</template>
                </button>
              </div>
              <div v-if="p.analysis" class="q-item__analysis">
                <span class="q-item__analysis-label">解析</span>{{ p.analysis }}
              </div>
            </template>

            <!-- 编辑态 -->
            <template v-else>
              <div class="edit-form">
                <div class="edit-row">
                  <label class="edit-row__label">题型</label>
                  <ThemedSelect v-model="p.type" :options="typeOptions" placeholder="选择题型" />
                </div>
                <div class="edit-row">
                  <label class="edit-row__label">题干</label>
                  <textarea v-model="p.stem" class="edit-row__textarea" rows="2"></textarea>
                </div>
                <template v-if="p.type === 'single' || p.type === 'multiple'">
                  <div class="edit-row edit-row--opt" v-for="(opt, oi) in p.options" :key="oi">
                    <span class="edit-row__optkey">{{ String.fromCharCode(65 + oi) }}</span>
                    <input
                      class="edit-row__input"
                      :value="opt"
                      @input="(e) => editOption(p, oi, (e.target as HTMLInputElement).value)"
                    />
                    <van-icon
                      name="cross"
                      size="14"
                      color="var(--danger)"
                      @click="removeOption(p, oi)"
                    />
                  </div>
                  <button class="add-opt-btn" @click="addOption(p)">
                    <van-icon name="plus" size="13" /> 添加选项
                  </button>
                </template>
                <div v-if="isChoiceQuestion(p)" class="edit-row">
                  <label class="edit-row__label">选项</label>
                  <div class="answer-choice-group">
                    <button
                      v-for="(_, oi) in p.options"
                      :key="oi"
                      type="button"
                      :class="[
                        'answer-choice',
                        isAnswerOptionSelected(p, String.fromCharCode(65 + oi)) &&
                          'answer-choice--selected',
                      ]"
                      @click="toggleAnswerOption(p, String.fromCharCode(65 + oi))"
                    >
                      {{ String.fromCharCode(65 + oi) }}
                    </button>
                  </div>
                </div>
                <div v-else class="edit-row">
                  <label class="edit-row__label">答案</label>
                  <input
                    class="edit-row__input"
                    :value="answerInputVal(p)"
                    @input="(e) => editAnswer(p, (e.target as HTMLInputElement).value)"
                    :placeholder="
                      p.type === 'multiple' || p.type === 'fill' ? '多个答案用、分隔' : ''
                    "
                  />
                </div>
                <div class="edit-row">
                  <label class="edit-row__label">解析</label>
                  <textarea v-model="p.analysis" class="edit-row__textarea" rows="2"></textarea>
                </div>
                <div class="edit-actions">
                  <button type="button" class="edit-confirm-btn" @click="confirmEdit(p)">
                    确定
                  </button>
                </div>
              </div>
            </template>
          </div>
          <template #right>
            <van-button
              square
              type="danger"
              text="移除"
              style="height: 100%"
              @click="removeParsed(i)"
            />
          </template>
        </van-swipe-cell>
      </div>

      <!-- 底部操作 -->
      <div class="bottom-actions">
        <van-button round :disabled="saving" @click="step = 2">返回重试</van-button>
        <van-button type="primary" round :loading="saving" loading-text="导入中…" @click="saveAll">导入 {{ parsed.length }} 题</van-button>
      </div>
    </div>

    <AdminDialog
      v-model:show="showAdminDialog"
      @verified="onAdminVerified"
      @update:show="
        (v) => {
          if (!v) onAdminDialogClose()
        }
      "
    />
  </div>
</template>

<style scoped>
/* ===== 页面头部 ===== */
.page-head--row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--sp-3);
}
.page-head__left {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  cursor: pointer;
}
.page-title--sm {
  font-size: 18px;
  margin: 0;
}

/* ===== 步骤指示器 ===== */
.stepper {
  display: flex;
  align-items: center;
  margin-bottom: var(--sp-5);
  padding: var(--sp-2) var(--sp-1);
}
.stepper__node {
  width: 26px;
  height: 26px;
  border-radius: 50%;
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 13px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  transition: all 0.2s;
}
.stepper__node--active {
  background: var(--brand-soft);
  color: var(--brand);
}
.stepper__node--current {
  background: var(--brand);
  color: #fff;
}
.stepper__label {
  font-size: 13px;
  color: var(--text-3);
  margin: 0 var(--sp-2);
  transition: color 0.2s;
}
.stepper__label--active {
  color: var(--text);
  font-weight: 500;
}
.stepper__line {
  flex: 1;
  height: 2px;
  background: var(--border-strong);
  transition: background 0.2s;
}
.stepper__line--done {
  background: var(--brand);
}

/* ===== 步骤内容容器 ===== */
.step-body {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}

/* ===== 表单字段（统一风格，与设置页一致） ===== */
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field__label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-2);
}
.field__hint {
  font-size: 12px;
  color: var(--warning);
  margin: 0;
}
.field__select {
  width: 100%;
  height: 42px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  outline: none;
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%2386909c' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  padding-right: 32px;
}
.field__select:focus {
  border-color: var(--brand);
}
.field__textarea {
  width: 100%;
  padding: 10px 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-md);
  background: var(--surface-2);
  color: var(--text);
  font-size: 14px;
  line-height: 1.6;
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.field__textarea:focus {
  border-color: var(--brand);
}

/* ===== 上传区 ===== */
.upload-zone {
  background: var(--surface);
  border: 2px dashed var(--border-strong);
  border-radius: var(--r-lg);
  padding: var(--sp-2);
  transition: border-color 0.2s;
}
.upload-zone:hover {
  border-color: var(--brand);
}
.upload-zone :deep(.van-uploader),
.upload-zone :deep(.van-uploader__wrapper),
.upload-zone :deep(.van-uploader__input-wrapper) {
  width: 100%;
}
.upload-zone__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: var(--sp-8) var(--sp-4);
}
.upload-zone__icon {
  width: 56px;
  height: 56px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: var(--sp-3);
}
.upload-zone__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.upload-zone__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 4px;
  line-height: 1.5;
}

/* ===== 解析说明 ===== */
.parse-info {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.parse-info__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.parse-info__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
  line-height: 1.5;
}

/* ===== 文件卡片 ===== */
.file-card {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.file-card__icon {
  width: 40px;
  height: 40px;
  border-radius: var(--r-sm);
  background: var(--brand-soft);
  color: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.file-card__info {
  flex: 1;
  min-width: 0;
}
.file-card__name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-card__size {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}

/* ===== 提示条 ===== */
.tip {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin-top: var(--sp-3);
  font-size: 12px;
  color: var(--text-2);
  line-height: 1.5;
}

/* ===== 居中按钮 ===== */
.btn-center {
  margin-top: var(--sp-2);
}
.parse-error {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: var(--sp-3);
  color: var(--danger);
  font-size: 13px;
}

/* ===== 预览统计栏 ===== */
.preview-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 var(--sp-1);
}
.preview-bar__stats {
  font-size: 13px;
  color: var(--text-3);
}
.preview-bar__num {
  font-size: 16px;
  font-weight: 700;
  color: var(--text);
}
.preview-bar__sep {
  margin: 0 4px;
}
.preview-bar__warn {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--danger);
}
.preview-bar__repair {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--brand);
  font-weight: 500;
}

/* ===== 题目卡片 ===== */
.preview-list {
  margin-top: var(--sp-4);
}
.swipe-card--low {
  border-left: 4px solid var(--danger);
}
.q-item {
  padding: var(--sp-4) var(--sp-4);
}
.q-item__head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.chip--danger {
  background: rgba(245, 63, 63, 0.1);
  color: var(--danger);
}
.q-item__idx {
  font-size: 12px;
  color: var(--text-3);
}
.q-item__edit {
  margin-left: auto;
  width: 28px;
  height: 28px;
  border-radius: var(--r-sm);
  border: none;
  background: var(--surface-2);
  color: var(--text-2);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}
.q-item__edit--active {
  background: var(--brand-soft);
  color: var(--brand);
}
.q-item__stem {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text);
}
.q-item__options {
  margin-top: var(--sp-2);
  font-size: 13px;
  color: var(--text-2);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.q-item__opt-key {
  font-weight: 600;
  margin-right: 6px;
}
.q-item__answer {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px dashed var(--border-strong);
  font-size: 13px;
  color: var(--success);
}
.q-item__answer-empty {
  color: var(--danger);
}
.ai-gen-btn {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  border: 1px solid var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 99px;
  cursor: pointer;
}
.ai-gen-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.q-item__analysis {
  margin-top: var(--sp-2);
  font-size: 12px;
  line-height: 1.5;
  color: var(--text-2);
}
.q-item__analysis-label {
  display: inline-block;
  margin-right: 6px;
  padding: 0 6px;
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text-3);
  font-size: 11px;
}

/* ===== 编辑表单 ===== */
.edit-form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  margin-top: var(--sp-2);
}
.edit-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.edit-row__label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-3);
}
.edit-row__select,
.edit-row__input {
  width: 100%;
  height: 36px;
  padding: 0 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font-size: 13px;
  outline: none;
}
.edit-row__select {
  appearance: none;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 12 12'%3E%3Cpath fill='%2386909c' d='M6 8L2 4h8z'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 10px center;
  padding-right: 28px;
}
.edit-row__textarea {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border-strong);
  border-radius: var(--r-sm);
  background: var(--surface-2);
  color: var(--text);
  font-size: 13px;
  line-height: 1.5;
  outline: none;
  resize: vertical;
  font-family: inherit;
}
.edit-row__input:focus,
.edit-row__select:focus,
.edit-row__textarea:focus {
  border-color: var(--brand);
}
.edit-row--opt {
  flex-direction: row;
  align-items: center;
  gap: var(--sp-2);
}
.edit-row__optkey {
  width: 20px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-2);
  flex-shrink: 0;
}
.answer-choice-group {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.answer-choice {
  width: 36px;
  height: 36px;
  border-radius: var(--r-sm);
  border: 1px solid var(--border-strong);
  background: var(--surface-2);
  color: var(--text-2);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.answer-choice--selected {
  border-color: var(--brand);
  background: var(--brand-soft);
  color: var(--brand);
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
}
.edit-confirm-btn {
  min-width: 88px;
  height: 36px;
  border: none;
  border-radius: var(--r-sm);
  background: var(--brand);
  color: #fff;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.add-opt-btn {
  align-self: flex-start;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: none;
  background: none;
  color: var(--brand);
  font-size: 12px;
  cursor: pointer;
  padding: 4px 0;
}

/* ===== 底部操作 ===== */
.bottom-actions {
  display: flex;
  gap: var(--sp-3);
  margin-top: var(--sp-4);
}
.bottom-actions :deep(.van-button) {
  flex: 1;
}
</style>
