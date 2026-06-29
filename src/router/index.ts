import { createRouter, createWebHistory, type RouteRecordRaw } from 'vue-router'

const routes: RouteRecordRaw[] = [
  { path: '/', redirect: '/home' },
  {
    path: '/setup',
    name: 'setup',
    component: () => import('@/views/SetupView.vue'),
    meta: { title: '初始化配置' },
  },
  {
    path: '/home',
    name: 'home',
    component: () => import('@/views/HomeView.vue'),
    meta: { title: '首页', tabbar: true },
  },
  {
    path: '/library',
    name: 'library',
    component: () => import('@/views/LibraryView.vue'),
    meta: { title: '题库', tabbar: true },
  },
  {
    path: '/library/:subjectId',
    name: 'subject-detail',
    component: () => import('@/views/SubjectDetailView.vue'),
    meta: { title: '题目列表' },
  },
  {
    path: '/search',
    name: 'search',
    component: () => import('@/views/SearchView.vue'),
    meta: { title: '搜索题目' },
  },
  {
    path: '/wrong',
    name: 'wrong',
    component: () => import('@/views/WrongBookView.vue'),
    meta: { title: '错题本', tabbar: true },
  },
  {
    path: '/settings',
    name: 'settings',
    component: () => import('@/views/SettingsView.vue'),
    meta: { title: '设置', tabbar: true },
  },
  {
    path: '/practice',
    name: 'practice',
    component: () => import('@/views/PracticeView.vue'),
    meta: { title: '自测模式' },
  },
  {
    path: '/my-practice',
    name: 'my-practice',
    component: () => import('@/views/MyPracticeView.vue'),
    meta: { title: '我的自测' },
  },
  {
    path: '/exam',
    name: 'exam',
    component: () => import('@/views/ExamView.vue'),
    meta: { title: '考试模式' },
  },
  {
    path: '/import',
    name: 'import',
    component: () => import('@/views/ImportView.vue'),
    meta: { title: '导入题库' },
  },
]

const router = createRouter({
  history: createWebHistory(),
  routes,
})

router.afterEach((to) => {
  const title = (to.meta.title as string) || '题盒 · QuizBox'
  document.title = title
})

export default router
