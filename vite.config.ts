import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import fs from 'fs';
import { builtinModules } from 'module';

/**
 * Vite plugin: stub out dynamic imports of `src/main/*` from renderer-side code.
 *
 * 背景：shared/commands/definitions/ 里有 `await import('../../main/...')` 这样
 * 的 CLI-only 动态导入，dev 模式 Vite 的 dep-scan 会静态追到 main/ 里，
 * 继而撞到 node 内置模块（如 `https`、`fs`），报 "Failed to resolve entry for
 * package https"。生产 build 已用 rollupOptions.external 屏蔽；dev 模式需要
 * 这个 stub 保持行为一致。
 *
 * Stub 模块在 renderer 里若被意外 await，会抛出清晰错误而不是静默失败。
 */
function stubMainInRendererPlugin(): Plugin {
  const STUB_ID = '\0virtual:main-stub';
  return {
    name: 'stub-main-in-renderer',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer) return null;
      // 只拦 renderer 方向能追到的路径：shared/ 或 renderer/ 里的动态 import
      if (!/[\\/]src[\\/](shared|renderer)[\\/]/.test(importer)) return null;
      // 匹配相对路径或 alias 形式的 main/* 引用
      if (/(^|[\\/])main[\\/]/.test(source) && !source.includes('node_modules')) {
        return STUB_ID;
      }
      return null;
    },
    load(id) {
      if (id === STUB_ID) {
        return `
          const handler = { get() { throw new Error('[stub] src/main/* 不可在 renderer/web 运行时调用，仅 CLI/Tauri 主进程可用'); } };
          export default new Proxy({}, handler);
        `;
      }
      return null;
    },
  };
}

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
  plugins: [stubMainInRendererPlugin(), react(), devAuthTokenPlugin()],
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
        // 注意：声明的 vendor 必须是项目实际有 import 的包，否则会生成空 chunk
        // 警告 "Generated an empty chunk: xxx"。已踩过 vendor-prism (项目用
        // react-syntax-highlighter 不直接 import prismjs) 和 vendor-react
        // (linux/darwin 平台 react 被 inline 进主 bundle 行为不一致) 两个坑。
        manualChunks: {
          'vendor-zustand': ['zustand'],
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
