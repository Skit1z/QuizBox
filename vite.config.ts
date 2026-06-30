import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import Components from 'unplugin-vue-components/vite'
import { VantResolver } from 'unplugin-vue-components/resolvers'
import { VitePWA } from 'vite-plugin-pwa'
import { fileURLToPath, URL } from 'node:url'
import { readFileSync } from 'node:fs'
import { nodePolyfills } from 'vite-plugin-node-polyfills'

const pkg = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

// https://vite.dev/config/
export default defineConfig({
  define: {
    // 构建期注入版本号，供 UI 显示
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    vue(),
    nodePolyfills({
      include: ['buffer', 'stream', 'path', 'util'],
      globals: {
        Buffer: true,
        process: true,
      },
    }),
    Components({
      resolvers: [VantResolver()],
    }),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: [
        'favicon.svg',
        'app-icons/180x180.png',
        'app-icons/192x192.png',
        'app-icons/512x512.png',
      ],
      manifest: {
        name: '题盒 · QuizBox',
        short_name: '题盒',
        description: '主观题与客观题刷题应用',
        start_url: '/',
        display: 'standalone',
        background_color: '#f5f6f8',
        theme_color: '#4f6bed',
        icons: [
          {
            src: '/app-icons/192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/app-icons/512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any maskable',
          },
          {
            src: '/favicon.svg',
            sizes: 'any',
            type: 'image/svg+xml',
            purpose: 'any maskable',
          },
        ],
      },
      workbox: {
        // 不缓存 IndexedDB 相关的运行时；缓存静态资源
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff,woff2}'],
        // AI/WebDAV 请求不走缓存
        navigateFallbackDenylist: [/^\/api\//],
        // 新版本激活后立即清掉旧预缓存，避免旧资源残留
        cleanupOutdatedCaches: true,
        // 新 SW 跳过 waiting 直接接管 + 立即控制所有页面（配合 autoUpdate 自动刷新）
        skipWaiting: true,
        clientsClaim: true,
      },
    }),
  ],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    rollupOptions: {
      output: {
        // mammoth（.docx 解析）体积大，把它的几个重依赖拆成独立 vendor 块。
        // 这些库仅被懒加载的 docx-parser 引用，拆分后各块仍按需加载、单块不再超 500KB。
        manualChunks: {
          'vendor-jszip': ['jszip'],
          'vendor-xmldom': ['@xmldom/xmldom'],
        },
      },
    },
  },
  server: {
    host: true,
    port: 5173,
  },
})
