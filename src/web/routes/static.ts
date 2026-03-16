import { Router } from 'express';
import type { Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';

interface StaticDeps {
  serverAuthToken: string;
}

export function createStaticRouter(deps: StaticDeps): Router {
  const router = Router();
  const { serverAuthToken } = deps;

  // ── Static file serving (production) ─────────────────────────────
  const staticDir = path.join(process.cwd(), 'dist', 'renderer');
  router.use(express.static(staticDir, {
    // Don't serve index.html via static middleware — we inject the auth token below
    index: false,
  }));

  // SPA fallback — serve index.html with injected auth token
  // This ensures only clients that load the page from this server can call APIs.
  const indexPath = path.join(staticDir, 'index.html');
  let cachedIndexHtml: string | null = null;

  router.get('/{*path}', (_req: Request, res: Response) => {
    try {
      if (!cachedIndexHtml) {
        cachedIndexHtml = fs.readFileSync(indexPath, 'utf-8');
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
