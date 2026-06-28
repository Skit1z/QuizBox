<script setup lang="ts">
import { ref, onMounted, computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import {
  showFailToast,
  showSuccessToast,
  showToast,
  showConfirmDialog,
} from 'vant'
import { useSubjectsStore } from '@/stores/subjects'
import { questionsRepo, type QuestionInput } from '@/db/questions'
import { parseDocx, saveImages, type ParsedImage } from '@/services/docx-parser'
import { parseQuestionsWithAI, type ParsedQuestion } from '@/services/importer'
import { QUESTION_TYPE_LABELS, type QuestionType } from '@/types'

const route = useRoute()
const router = useRouter()
const subjectsStore = useSubjectsStore()

const step = ref<1 | 2 | 3>(1) // 1上传 2解析 3预览
const selectedSubjectId = ref((route.query.subjectId as string) || '')
const fileRef = ref<File | null>(null)
const parsing = ref(false)
const parseError = ref('')

const parsed = ref<ParsedQuestion[]>([])
const images: ParsedImage[] = []
const hint = ref('')
const editingIdx = ref<number | null>(null)

const types: QuestionType[] = ['single', 'multiple', 'judge', 'fill', 'short', 'essay']

const lowConfidenceCount = computed(
  () => parsed.value.filter((p) => (p.confidence ?? 1) < 0.6).length,
)

/** 把编辑态答案字符串与数组互转 */
function editAnswer(p: ParsedQuestion, val: string) {
  if (p.type === 'multiple' || p.type === 'fill') {
    p.answer = val.split(/[、,，;;\n]/).map((s) => s.trim()).filter(Boolean)
  } else {
    p.answer = val
  }
}
function answerInputVal(p: ParsedQuestion): string {
  return Array.isArray(p.answer) ? p.answer.join('、') : p.answer
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
}

function onFileRead(file: any) {
  const f: File = file.file || file
  if (!f.name.toLowerCase().endsWith('.docx')) {
    showFailToast('请上传 .docx 文件')
    return
  }
  fileRef.value = f
  step.value = 2
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
    const result = await parseDocx(fileRef.value)
    images.length = 0
    images.push(...result.images)
    const qs = await parseQuestionsWithAI(result.text, hint.value || undefined)
    if (qs.length === 0) {
      parseError.value = 'AI 未识别出题目，请检查文档或添加解析提示后重试'
    } else {
      parsed.value = qs
      step.value = 3
    }
  } catch (e: any) {
    parseError.value = e?.message || '解析失败'
    showFailToast(parseError.value)
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

function removeParsed(i: number) {
  parsed.value.splice(i, 1)
}

async function saveAll() {
  const subjectId = selectedSubjectId.value
  const toHash = placeholderToHash()
  let imported = 0
  let skipped = 0

  await saveImages(images)

  for (const p of parsed.value) {
    const stem = p.stem?.trim()
    if (!stem) {
      skipped++
      continue
    }
    const attachments = (p.imagePlaceholders || [])
      .map(toHash)
      .filter((h): h is string => !!h)

    const input: QuestionInput = {
      subjectId,
      type: p.type,
      stem,
      options: p.options,
      answer: p.answer ?? '',
      analysis: p.analysis,
      attachments,
    }
    try {
      await questionsRepo.create(input)
      imported++
    } catch {
      skipped++
    }
  }

  showSuccessToast(`已导入 ${imported} 题${skipped ? `，跳过 ${skipped} 题` : ''}`)
  router.replace({ name: 'subject-detail', params: { subjectId } })
}

onMounted(async () => {
  await subjectsStore.load()
  if (!selectedSubjectId.value && subjectsStore.list.length === 1) {
    selectedSubjectId.value = subjectsStore.list[0].id
  }
})
</script>

<template>
  <div class="page">
    <div class="page-head page-head--row">
      <div class="page-head__left" @click="router.back()">
        <van-icon name="arrow-left" size="20" />
        <h1 class="page-title page-title--sm">导入题库</h1>
      </div>
    </div>

    <van-steps :active="step - 1" :active-color="'var(--brand)'">
      <van-step>上传文档</van-step>
      <van-step>AI 解析</van-step>
      <van-step>预览确认</van-step>
    </van-steps>

    <!-- 步骤 1：上传 + 科目选择 -->
    <div v-if="step === 1" style="padding: 16px">
      <van-cell-group inset style="margin-bottom: 16px">
        <van-field label="选择科目" is-link readonly>
          <template #input>
            <select v-model="selectedSubjectId" style="border: none; flex: 1">
              <option value="">请选择</option>
              <option v-for="s in subjectsStore.list" :key="s.id" :value="s.id">
                {{ s.name }}
              </option>
            </select>
          </template>
        </van-field>
      </van-cell-group>

      <van-uploader :after-read="onFileRead" accept=".docx" :max-count="1">
        <van-button icon="upload" type="primary">选择 Word 文档</van-button>
      </van-uploader>
      <p v-if="!selectedSubjectId" style="color: var(--danger); font-size: 13px; margin-top: var(--sp-3)">
        请先选择科目，或前往题库页新建科目
      </p>
    </div>

    <!-- 步骤 2：解析中 -->
    <div v-else-if="step === 2" style="padding: 16px">
      <div style="margin-bottom: 16px">
        <van-tag type="primary" plain>已选：{{ fileRef?.name }}</van-tag>
      </div>
      <van-cell-group inset>
        <van-field
          v-model="hint"
          label="解析提示"
          type="textarea"
          placeholder="可选：告诉 AI 文档格式（如：每题以「题号.」开头，答案在题后「答案：」）"
          rows="3"
          autosize
        />
      </van-cell-group>
      <div style="padding: 16px; text-align: center">
        <van-button
          type="primary"
          :loading="parsing"
          loading-text="AI 解析中..."
          @click="doParse"
        >
          开始 AI 解析
        </van-button>
        <div v-if="parseError" style="color: var(--danger); margin-top: var(--sp-3); font-size: 13px">
          {{ parseError }}
        </div>
      </div>
    </div>

    <!-- 步骤 3：预览 -->
    <div v-else style="padding: 12px">
      <van-notice-bar
        v-if="lowConfidenceCount > 0"
        color="var(--danger)"
        background="var(--surface)"
        left-icon="warning-o"
      >
        有 {{ lowConfidenceCount }} 道题解析把握较低，已标红，请重点检查
      </van-notice-bar>

      <div style="margin: var(--sp-3) 0; color: var(--text-3); font-size: 13px">
        共识别 {{ parsed.length }} 道题，{{ images.length }} 张图片
      </div>

      <van-swipe-cell
        v-for="(p, i) in parsed"
        :key="i"
        style="margin-bottom: 10px"
      >
        <div
          class="parsed-item"
          :class="{ 'parsed-item--low': (p.confidence ?? 1) < 0.6 }"
        >
          <div class="parsed-item__meta">
            <van-tag plain>{{ QUESTION_TYPE_LABELS[p.type] }}</van-tag>
            <van-tag v-if="(p.confidence ?? 1) < 0.6" type="danger" plain>把握低</van-tag>
            <van-button
              size="mini"
              :type="editingIdx === i ? 'primary' : 'default'"
              :icon="editingIdx === i ? 'cross' : 'edit'"
              style="margin-left: auto"
              @click="editingIdx = editingIdx === i ? null : i"
            />
          </div>

          <!-- 浏览态 -->
          <template v-if="editingIdx !== i">
            <div class="parsed-item__stem">{{ p.stem }}</div>
            <div v-if="p.options?.length" class="parsed-item__options">
              <div v-for="(opt, oi) in p.options" :key="oi">
                {{ String.fromCharCode(65 + oi) }}. {{ opt }}
              </div>
            </div>
            <div class="parsed-item__answer">答案：{{ Array.isArray(p.answer) ? p.answer.join('、') : p.answer }}</div>
          </template>

          <!-- 编辑态 -->
          <template v-else>
            <van-cell-group :border="false">
              <van-field label="题型" is-link readonly>
                <template #input>
                  <select v-model="p.type" style="border: none; flex: 1">
                    <option v-for="t in types" :key="t" :value="t">{{ QUESTION_TYPE_LABELS[t] }}</option>
                  </select>
                </template>
              </van-field>
              <van-field
                :model-value="p.stem"
                @update:model-value="(v:string) => (p.stem = v)"
                label="题干"
                type="textarea"
                rows="2"
                autosize
              />
              <template v-if="p.type === 'single' || p.type === 'multiple'">
                <div v-for="(opt, oi) in p.options" :key="oi" class="opt-edit">
                  <van-tag plain>{{ String.fromCharCode(65 + oi) }}</van-tag>
                  <van-field
                    :model-value="opt"
                    @update:model-value="(v:string) => editOption(p, oi, v)"
                    class="opt-input"
                  />
                  <van-icon name="cross" color="var(--danger)" @click="removeOption(p, oi)" />
                </div>
                <van-button size="small" plain icon="plus" @click="addOption(p)">添加选项</van-button>
              </template>
              <van-field
                :model-value="answerInputVal(p)"
                @update:model-value="(v:string) => editAnswer(p, v)"
                label="答案"
                :placeholder="p.type === 'multiple' || p.type === 'fill' ? '多答案用、分隔' : ''"
              />
              <van-field
                :model-value="p.analysis"
                @update:model-value="(v:string) => (p.analysis = v)"
                label="解析"
                type="textarea"
                rows="2"
                autosize
              />
            </van-cell-group>
          </template>
        </div>
        <template #right>
          <van-button square type="danger" text="移除" style="height: 100%" @click="removeParsed(i)" />
        </template>
      </van-swipe-cell>

      <div style="padding: 16px; display: flex; gap: 12px">
        <van-button block @click="step = 2">返回重试</van-button>
        <van-button block type="primary" @click="saveAll">导入到题库</van-button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.parsed-item {
  background: var(--surface);
  border-radius: var(--r-md);
  padding: var(--sp-4);
  box-shadow: var(--shadow-sm);
}
.parsed-item--low {
  border-left: 3px solid var(--danger);
}
.parsed-item__meta {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.parsed-item__stem {
  font-size: 14px;
  line-height: 1.6;
  white-space: pre-wrap;
  color: var(--text);
}
.parsed-item__options {
  font-size: 13px;
  color: var(--text-2);
  margin-top: var(--sp-2);
}
.parsed-item__answer {
  margin-top: var(--sp-2);
  font-size: 13px;
  color: var(--success);
}
.opt-edit {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) 0;
}
.opt-input {
  flex: 1;
}
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
</style>
