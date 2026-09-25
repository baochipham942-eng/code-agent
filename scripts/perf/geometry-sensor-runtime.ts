import path from 'node:path';
import { createServer, type ViteDevServer } from 'vite';
import react from '@vitejs/plugin-react';
import { getFreePort } from '../acceptance/browser-computer-system-chrome.ts';

export interface GeometryViteServer {
  server: ViteDevServer;
  origin: string;
  caselistUrl: string;
  sidebarUrl: string;
}

function htmlPage(title: string, scriptSrc: string): string {
  return `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width,initial-scale=1" />
    <title>${title}</title>
    <style>html,body,#root{height:100%;margin:0;}</style>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="${scriptSrc}"></script>
  </body>
</html>`;
}

export async function startGeometryVite(root: string, harnessRoot = root): Promise<GeometryViteServer> {
  const port = await getFreePort();
  const server = await createServer({
    appType: 'custom',
    configFile: false,
    logLevel: 'error',
    root: harnessRoot,
    plugins: [react()],
    css: { postcss: path.join(root, 'postcss.config.js') },
    server: {
      host: '127.0.0.1',
      port,
      strictPort: true,
      hmr: false,
      fs: { allow: [root, harnessRoot] },
    },
    resolve: {
      alias: {
        '@': path.join(root, 'src'),
        '@host': path.join(root, 'src/host'),
        '@renderer': path.join(root, 'src/renderer'),
        '@shared': path.join(root, 'src/shared'),
        '@internal-evaluation': path.join(root, 'packages/internal/evaluation-center/src'),
        '@internal-evaluation-scripts': path.join(root, 'packages/internal/evaluation-center/scripts'),
        electron: path.join(root, 'src/host/platform/index.ts'),
        keytar: path.join(harnessRoot, 'tests/__mocks__/keytar.ts'),
      },
    },
  });

  server.middlewares.use((req, res, next) => {
    if (req.url?.startsWith('/__geometry-caselist.html')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(htmlPage('geometry caselist', '/scripts/perf/geometry-caselist-harness.tsx'));
      return;
    }
    if (req.url?.startsWith('/__geometry-sidebar.html')) {
      res.statusCode = 200;
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(htmlPage('geometry sidebar', '/scripts/perf/geometry-sidebar-harness.tsx'));
      return;
    }
    next();
  });

  await server.listen();
  const origin = `http://127.0.0.1:${port}`;
  return {
    server,
    origin,
    caselistUrl: `${origin}/__geometry-caselist.html?theme=dark`,
    sidebarUrl: `${origin}/__geometry-sidebar.html?theme=dark`,
  };
}
