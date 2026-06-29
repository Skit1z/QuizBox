<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'

const route = useRoute()
const router = useRouter()

/** 路由切换时的 key，用于强制过渡；tab 页走 keep-alive，不在此列 */
const routeKey = computed(() => String(route.name) + String(route.params.subjectId || ''))

/** 需要缓存的页面（tab 主页 + 题库列表），切回时保留滚动与状态 */
const cachedViews = ['HomeView', 'LibraryView']

const isDesktop = ref(typeof window !== 'undefined' && window.innerWidth >= 768)
const updateLayout = () => {
  isDesktop.value = window.innerWidth >= 768
}
onMounted(() => {
  window.addEventListener('resize', updateLayout)
})
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateLayout)
})

const navItems = [
  { name: 'home', label: '首页', icon: 'wap-home-o' },
  { name: 'library', label: '题库', icon: 'bookmark-o' },
  { name: 'settings', label: '设置', icon: 'setting-o' },
]

const activeName = computed(() => route.name as string)
const showTabbar = computed(() => !!route.meta.tabbar)

function go(name: string) {
  router.push({ name })
}

// 移动端底部 tabbar active 索引
const activeTab = computed(() => {
  const idx = navItems.findIndex((i) => i.name === route.name)
  return idx >= 0 ? idx : 0
})
function onTabChange(idx: number | string) {
  const item = navItems[Number(idx)]
  if (item) go(item.name)
}

onMounted(async () => {
  // 预热：触发数据库可用性
  try {
    const { db } = await import('@/db')
    await db.open()
  } catch {
    showToast('数据库初始化失败')
  }
  // 一次性加载设置并应用主题。同步是可选能力，不阻塞手机端本地使用。
  try {
    const { useSettingsStore } = await import('@/stores/settings')
    const settings = useSettingsStore()
    await settings.load()
    settings.applyAll()
  } catch {
    // ignore
  }
  // 启动时尝试同步（若已启用）
  try {
    const { useSyncStore } = await import('@/stores/sync')
    useSyncStore().init()
  } catch {
    // 同步失败不阻塞使用
  }
})
</script>

<template>
  <div :class="isDesktop ? 'app-shell app-shell--desktop' : 'app-shell app-shell--mobile'">
    <!-- 桌面端左侧导航 -->
    <aside v-if="isDesktop" class="app-sidebar">
      <div class="app-sidebar__brand" @click="go('home')">
        <div class="app-sidebar__brand-icon">
          <img src="/favicon.svg" alt="" />
        </div>
        <span>QuizBox</span>
      </div>
      <div
        v-for="item in navItems"
        :key="item.name"
        :class="['app-sidebar__item', activeName === item.name && 'app-sidebar__item--active']"
        @click="go(item.name)"
      >
        <van-icon :name="item.icon" size="20" />
        <span>{{ item.label }}</span>
      </div>
    </aside>

    <!-- 主内容区 -->
    <main :class="isDesktop ? 'app-content' : 'app-main-mobile'">
      <router-view v-slot="{ Component }">
        <transition name="page-fade" mode="out-in">
          <keep-alive :include="cachedViews">
            <component :is="Component" :key="routeKey" />
          </keep-alive>
        </transition>
      </router-view>
    </main>

    <!-- 移动端底部 tabbar -->
    <van-tabbar
      v-if="!isDesktop && showTabbar"
      :model-value="activeTab"
      @change="onTabChange"
      placeholder
    >
      <van-tabbar-item v-for="item in navItems" :key="item.name" :icon="item.icon">
        {{ item.label }}
      </van-tabbar-item>
    </van-tabbar>
  </div>
</template>

<style scoped>
.app-main-mobile {
  min-height: calc(100vh - 50px);
}
</style>
