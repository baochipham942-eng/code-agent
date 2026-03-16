import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { sseClients } from '../helpers/sse';

interface HealthDeps {
  handlers: Map<string, HandlerFn>;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const { handlers } = deps;

  // ── Health ──────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    res.json({
      status: 'ok',
      mode: 'web-standalone',
      timestamp: Date.now(),
      handlers: handlers.size,
    });
  });

  // ── SSE Events ─────────────────────────────────────────────────────
  router.get('/events', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    res.write('data: {"channel":"connected","args":{}}\n\n');

    sseClients.add(res);

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  return router;
}
