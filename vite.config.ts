import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  root: 'src/renderer',
  base: './',
  build: {
    outDir: '../../dist/renderer',
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      output: {
        // 代码分割：将大型依赖拆分为独立 chunk，提升首屏加载速度
        manualChunks: {
          // React 核心
          'vendor-react': ['react', 'react-dom'],
          // 状态管理
          'vendor-zustand': ['zustand'],
          // UI 组件库
          'vendor-radix': [
            '@radix-ui/react-dialog',
            '@radix-ui/react-dropdown-menu',
            '@radix-ui/react-tabs',
            '@radix-ui/react-tooltip',
            '@radix-ui/react-scroll-area',
          ],
          // 代码高亮
          'vendor-prism': ['prismjs'],
          // Markdown 渲染
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          // React Flow (DAG 可视化)
          'vendor-reactflow': ['@xyflow/react'],
        },
      },
    },
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@renderer': path.resolve(__dirname, 'src/renderer'),
      '@shared': path.resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5173,
    strictPort: true,
  },
});
