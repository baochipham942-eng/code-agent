// ============================================================================
// Vite Web Build Config
// ============================================================================
//
// 构建用于浏览器的 React 前端（非 Electron）。
// 输出到 dist/web/，由 serve.ts 提供静态文件服务。
//
// 与 vite.config.ts 的区别：
// - base 设为 '/'（绝对路径，适合 HTTP 服务）
// - 输出到 dist/web/（不覆盖 Electron 的 dist/renderer/）
// - 排除 Electron 相关 API（通过 define 提供 polyfill 标志）
//
// 用法：
//   npm run build:web
//   code-agent serve --web dist/web
//
// ============================================================================

import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: '/',
  build: {
    outDir: '../../dist/web',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-zustand': ['zustand'],
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-scroll-area',
          ],
          'vendor-prism': ['prismjs'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          'vendor-reactflow': ['@xyflow/react'],
        },
      },
    },
  },
  define: {
    // 让代码可以通过 import.meta.env 检测构建目标
    'import.meta.env.VITE_BUILD_TARGET': JSON.stringify('web'),
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 3001,
    host: 'localhost',
    strictPort: true,
    proxy: {
      // 开发模式下将 API 请求代理到 serve.ts
      '/api': {
        target: 'http://localhost:8180',
        changeOrigin: true,
      },
    },
  },
});
