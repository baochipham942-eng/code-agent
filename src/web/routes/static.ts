import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';

interface StaticDeps {
  serverAuthToken: string;
  staticDir?: string;
}

export function createStaticRouter(deps: StaticDeps): Router {
  const router = Router();
  const { serverAuthToken } = deps;

  // ── Static file serving (production) ─────────────────────────────
  // 用 __dirname 解析，不靠 process.cwd()——cargo tauri dev 启动 main process 时
  // cwd 是 src-tauri/，导致 join(cwd, 'dist/renderer') 解析到不存在的 src-tauri/dist/renderer。
  // bundled webServer.cjs 在 dist/web/，dist/renderer 在 ../renderer (dev) /
  // app bundle 里也是 ../renderer (prod)，两处一致。
  const staticDir = deps.staticDir ?? path.resolve(__dirname, '..', 'renderer');
  router.use(express.static(staticDir, {
    // Don't serve index.html via static middleware — we inject the auth token below
    index: false,
  }));

  // SPA fallback — serve index.html with injected auth token
  // This ensures only clients that load the page from this server can call APIs.
  const indexPath = path.join(staticDir, 'index.html');
  let cachedIndexHtml: string | null = null;
  let cachedIndexMtimeMs = 0;

  router.get('/{*path}', (req: Request, res: Response) => {
    const requestPath = req.path || '';
    if (requestPath.startsWith('/assets/') || path.extname(requestPath)) {
      res.status(404).type('text').send('Static asset not found');
      return;
    }

    try {
      const stat = fs.statSync(indexPath);
      if (!cachedIndexHtml || stat.mtimeMs !== cachedIndexMtimeMs) {
        cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
        cachedIndexMtimeMs = stat.mtimeMs;
      }
      // Inject auth token into HTML so httpTransport can attach it to API requests
      const injectedHtml = cachedIndexHtml.replace(
        '<head>',
        `<head><script>window.__CODE_AGENT_TOKEN__="${serverAuthToken}";</script>`
      );
      res.type('html').send(injectedHtml);
    } catch {
      res.status(404).send('index.html not found');
    }
  });

  return router;
}
