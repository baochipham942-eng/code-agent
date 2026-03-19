import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';

/**
 * Vite plugin: inject web server auth token into HTML during dev.
 * The token is written to .dev-token by webServer.ts on startup.
 */
function devAuthTokenPlugin(): Plugin {
  return {
    name: 'dev-auth-token',
    apply: 'serve',
    transformIndexHtml(html) {
      try {
        const tokenPath = path.resolve(__dirname, '.dev-token');
        const token = fs.readFileSync(tokenPath, 'utf-8').trim();
        if (token) {
          return html.replace(
            '<head>',
            `<head><script>window.__CODE_AGENT_TOKEN__="${token}";</script>`
          );
        }
      } catch {
        // .dev-token not yet created — web server hasn't started
      }
      return html;
    },
  };
}

export default defineConfig({
  plugins: [react(), devAuthTokenPlugin()],
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
    proxy: {
      '/api': {
        target: 'http://localhost:8180',
        changeOrigin: true,
        bypass(req) {
          // Don't proxy Vite module requests (source files, HMR)
          if (req.url?.match(/\.(ts|tsx|js|jsx|mjs)(\?|$)/) || req.url?.includes('?import')) {
            return req.url;
          }
        },
      },
    },
    port: 3000,
    host: 'localhost',
    strictPort: true,
  },
});
