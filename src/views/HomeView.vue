<script setup lang="ts">
import { ref, onMounted, onActivated, onBeforeUnmount, computed } from 'vue'
defineOptions({ name: 'HomeView' })
import { useRouter } from 'vue-router'
import { useSubjectsStore } from '@/stores/subjects'
import { useSyncStore } from '@/stores/sync'
import { questionsRepo } from '@/db/questions'
import { wrongBookRepo } from '@/db/wrongbook'
import { showToast } from 'vant'

const router = useRouter()
const subjectsStore = useSubjectsStore()
const syncStore = useSyncStore()

const stats = ref({ subjects: 0, questions: 0, wrong: 0 })
const greeting = computed(() => {
  const h = new Date().getHours()
  if (h < 6) return '夜深了，记得早点休息哦 🌌'
  if (h < 12) return '一日之计在于晨，今天也要加油呀 ☀️'
  if (h < 14) return '中午好，吃饱了也别忘了让大脑小憩一下 ☕️'
  if (h < 18) return '下午好，来一场酣畅淋漓的刷题之旅吧 🚀'
  return '今晚，让我们把学过的知识都巩固一遍 ✨'
})

/** 日期 + 星期 */
const dateText = computed(() => {
  const d = new Date()
  const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`
})

/** 设备信息：型号 + 名称（从 UA 解析，移动端优先） */
const deviceText = computed(() => {
  if (typeof navigator === 'undefined') return ''
  const ua = navigator.userAgent
  let model = ''
  // iOS 设备型号
  const iphoneMatch = ua.match(/iPhone([0-9]+,[0-9]+)/)
  const ipadMatch = ua.match(/iPad([0-9]+,[0-9]+)/)
  if (/Android/.test(ua)) {
    const m = ua.match(/Android[^;]*;\s*([^)]+?)\s*Build/i)
    model = m ? m[1].trim() : 'Android 手机'
  } else if (iphoneMatch) {
    model = 'iPhone'
  } else if (ipadMatch) {
    model = 'iPad'
  } else if (/Macintosh|Mac OS X/.test(ua)) {
    model = /Tauri/.test(ua) ? '桌面端' : 'Mac'
  } else if (/Windows/.test(ua)) {
    model = 'Windows PC'
  } else if (/Linux/.test(ua)) {
    model = 'Linux'
  }
  
  // 优先使用 Tauri
  const isDesktop = (window as any).__TAURI__
  const deviceName = isDesktop ? `桌面端${model ? ' · ' + model : ''}` : (model || '移动端')
  
  // 根据设备类型加点有意思的尾缀
  const isMobile = /Android|iPhone|iPad/i.test(ua)
  if (isMobile) {
    return `${deviceName} · 随时随地，碎片时间刷刷题 📱`
  } else {
    return `${deviceName} · 大屏幕大视角，复习效率加倍 ✨`
  }
})

const features = [
  { title: '自测模式', desc: '即时反馈', icon: 'edit', route: 'practice' },
  { title: '我的自测', desc: '继续未完成', icon: 'clock-o', route: 'my-practice' },
  { title: '考试模式', desc: '限时交卷', icon: 'certificate', route: 'exam' },
  { title: '错题本', desc: '间隔复习', icon: 'warning-o', route: 'wrong' },
]

async function loadStats() {
  await subjectsStore.load()
  const [w, totalQ] = await Promise.all([
    wrongBookRepo.listAll(),
    questionsRepo.countAll(),
  ])
  stats.value = {
    subjects: subjectsStore.list.length,
    questions: totalQ,
    wrong: w.length,
  }
}

const refreshing = ref(false)

/** 下拉刷新：触发一次云端题库增量同步并刷新统计 */
async function onPullRefresh() {
  try {
    const res = await syncStore.runBank()
    if (res.ok) {
      const pulledMsg =
        res.pulled > 0 ? `已同步 ${res.pulled} 条` : '已是最新'
      showToast(pulledMsg)
    } else if (res.error) {
      showToast(res.error)
    }
  } finally {
    await loadStats()
    refreshing.value = false
  }
}

function refreshWhenVisible() {
  if (document.visibilityState === 'visible') void loadStats()
}

onMounted(() => {
  void loadStats()
  window.addEventListener('focus', loadStats)
  window.addEventListener('visibilitychange', refreshWhenVisible)
  window.addEventListener('quizbox:data-changed', loadStats)
})
onActivated(loadStats)
onBeforeUnmount(() => {
  window.removeEventListener('focus', loadStats)
  window.removeEventListener('visibilitychange', refreshWhenVisible)
  window.removeEventListener('quizbox:data-changed', loadStats)
})
</script>

<template>
  <van-pull-refresh v-model="refreshing" @refresh="onPullRefresh">
    <div class="page">
      <!-- 头部问候 -->
      <div class="page-head">
        <img class="home-icon" src="/favicon.svg" alt="题盒图标" />
        <p class="page-sub">{{ greeting }}</p>
        <h1 class="page-title">{{ dateText }}</h1>
        <p v-if="deviceText" class="page-device">{{ deviceText }}</p>
      </div>

      <!-- 数据概览 -->
      <div class="stat-row">
        <div class="stat">
          <div class="stat__num">{{ stats.subjects }}</div>
          <div class="stat__label">科目</div>
        </div>
        <div class="stat__sep"></div>
        <div class="stat">
          <div class="stat__num">{{ stats.questions }}</div>
          <div class="stat__label">题目</div>
        </div>
        <div class="stat__sep"></div>
        <div class="stat">
          <div class="stat__num" :class="{ 'stat__num--accent': stats.wrong > 0 }">{{ stats.wrong }}</div>
          <div class="stat__label">待复习</div>
        </div>
      </div>

      <!-- 功能入口 -->
      <div class="section-title">开始学习</div>
      <div class="feature-grid">
        <div
          v-for="f in features"
          :key="f.route"
          class="feature card card--clickable"
          @click="router.push({ name: f.route })"
        >
          <div class="feature__icon">
            <van-icon :name="f.icon" size="22" />
          </div>
          <div class="feature__body">
            <div class="feature__title">{{ f.title }}</div>
            <div class="feature__desc">{{ f.desc }}</div>
          </div>
          <van-icon name="arrow" size="14" color="var(--text-3)" />
        </div>
      </div>

    </div>
  </van-pull-refresh>
</template>

<style scoped>
.page-head {
  position: relative;
  min-height: 56px;
  padding-left: 68px;
  display: flex;
  flex-direction: column;
  justify-content: center;
}
.home-icon {
  position: absolute;
  left: 0;
  top: 50%;
  width: 52px;
  height: 52px;
  border-radius: 12px;
  transform: translateY(-50%);
  box-shadow: var(--shadow-brand);
}
.stat-row {
  display: flex;
  align-items: center;
  background: var(--surface);
  border-radius: var(--r-lg);
  padding: var(--sp-5) var(--sp-4);
  box-shadow: var(--shadow-sm);
}
.stat {
  flex: 1;
  text-align: center;
}
.stat__num {
  font-size: 28px;
  font-weight: 700;
  color: var(--text);
  letter-spacing: -0.02em;
  line-height: 1;
}
.stat__num--accent {
  color: var(--danger);
}
.stat__label {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 6px;
}
.stat__sep {
  width: 1px;
  height: 32px;
  background: var(--border-strong);
}

.feature-grid {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.feature {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-5);
}
.feature__icon {
  width: 44px;
  height: 44px;
  border-radius: var(--r-md);
  background: var(--brand-soft);
  color: var(--brand);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.feature__body {
  flex: 1;
}
.feature__title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}
.feature__desc {
  font-size: 12px;
  color: var(--text-3);
  margin-top: 2px;
}
.page-device {
  font-size: 13px !important;
  font-weight: 500;
  color: var(--text-2) !important;
  opacity: 0.9 !important;
  margin-top: 4px !important;
}
</style>
