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
    // mermaid (~1.24MB) 和 application code (~1.18MB) 是不可拆分的下限，
    // 阈值放宽到 1700 以匹配真实下限；超过此值说明引入了新的大依赖，
    // 应该当 warning 处理而不是默默吞掉。
    chunkSizeWarningLimit: 1700,
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
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('/react/') || id.includes('/react-dom/') || id.includes('/scheduler/')) return 'vendor-react';
          if (id.includes('/mermaid/') || id.includes('@mermaid-js')) return 'vendor-mermaid';
          if (id.includes('/cytoscape')) return 'vendor-cytoscape';
          if (id.includes('@xyflow') || id.includes('/d3-')) return 'vendor-reactflow';
          if (id.includes('react-markdown') || id.includes('/remark') || id.includes('/rehype') || id.includes('/unified') || id.includes('/mdast') || id.includes('/hast')) return 'vendor-markdown';
          if (id.includes('prismjs') || id.includes('react-syntax-highlighter') || id.includes('refractor')) return 'vendor-prism';
          if (id.includes('/zustand/')) return 'vendor-zustand';
          if (id.includes('@radix-ui') || id.includes('lucide-react') || id.includes('framer-motion')) return 'vendor-ui';
          return 'vendor';
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
