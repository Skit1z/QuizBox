<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { showToast } from 'vant'

const route = useRoute()
const router = useRouter()

const isDesktop = ref(window.innerWidth >= 768)
const updateLayout = () => {
  isDesktop.value = window.innerWidth >= 768
}
window.addEventListener('resize', updateLayout)
onBeforeUnmount(() => {
  window.removeEventListener('resize', updateLayout)
})

const navItems = [
  { name: 'home', label: '首页', icon: 'wap-home-o' },
  { name: 'library', label: '题库', icon: 'bookmark-o' },
  { name: 'wrong', label: '错题本', icon: 'warning-o' },
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
  } catch (e) {
    showToast('数据库初始化失败')
  }
  // 尽早应用主题
  try {
    const { useSettingsStore } = await import('@/stores/settings')
    const settings = useSettingsStore()
    await settings.load()
    settings.applyAll()
  } catch {
    // ignore
  }
  // 移动端首次启动引导：未配置 WebDAV 则跳转初始化页
  try {
    const { useSettingsStore } = await import('@/stores/settings')
    const settings = useSettingsStore()
    await settings.load()
    const isMobile = !isDesktop.value
    if (isMobile && (!settings.webdav.enabled || !settings.webdav.url)) {
      if (route.name !== 'setup') router.replace({ name: 'setup' })
    }
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
          <van-icon name="bookmark-o" size="18" />
        </div>
        <span>刷题系统</span>
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
      <router-view />
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
