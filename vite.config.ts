import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { builtinModules } from 'module';

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
    // application bundle (~2.6MB) 是当前 main chunk 的真实下限。继续用
    // 函数式 manualChunks 拆分 node_modules 会触发 minify TDZ
    // (Cannot access 'X' before initialization) 阻塞 React mount —
    // 已经踩过一次坑，保留对象式声明式 chunk 拆分。
    // 阈值放到 2700 cover 现状；超过此值说明引入新大依赖应当处理。
    chunkSizeWarningLimit: 2900,
    rollupOptions: {
      external: (id) => {
        if (builtinModules.includes(id)) return true;
        if (id.startsWith('node:')) return true;
        // main/* 是 CLI/Tauri 主进程代码，renderer 通过 IPC 调用，
        // 不应被 Vite 打入 renderer bundle。@shared/commands 里的部分
        // 命令 handler 通过 dynamic import 引用 main/*，但只在 CLI 触发，
        // renderer 永不执行——把这些路径标 external 避免 ~1MB 的 gpt-tokenizer
        // / sharp / context 模块全量进 renderer chunks。
        if (/[\\/]src[\\/]main[\\/]/.test(id)) return true;
        return false;
      },
      output: {
        manualChunks: {
          'vendor-react': ['react', 'react-dom'],
          'vendor-zustand': ['zustand'],
          'vendor-prism': ['prismjs'],
          'vendor-markdown': ['react-markdown', 'remark-gfm'],
          'vendor-reactflow': ['@xyflow/react'],
          'vendor-mermaid': ['mermaid'],
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
