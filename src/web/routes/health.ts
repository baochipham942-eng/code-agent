import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { sseClients, replayFromLastEventId } from '../helpers/sse';

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

    // ADR-010 #6: 客户端重连时通过 Last-Event-ID header 或 lastEventId query 带上
    // 已见过的最大事件 id，服务端用 replay buffer 补发断线窗口内错过的事件。
    const headerLastId = _req.header('Last-Event-ID');
    const queryLastId = typeof _req.query.lastEventId === 'string' ? _req.query.lastEventId : undefined;
    const rawLastId = headerLastId ?? queryLastId;
    if (rawLastId !== undefined) {
      const parsed = Number.parseInt(rawLastId, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        replayFromLastEventId(res, parsed);
      }
    }

    sseClients.add(res);

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  return router;
}
