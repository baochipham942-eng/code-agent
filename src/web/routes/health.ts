import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { sseClients, replayFromLastEventId } from '../helpers/sse';
import type { PersistenceHealth, RendererServeDecision, WebHealthResponse } from '../../shared/contract';

interface HealthDeps {
  handlers: Map<string, HandlerFn>;
  getPersistenceHealth: () => PersistenceHealth;
  getRendererServeDecision?: () => RendererServeDecision | null;
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();
  const { handlers } = deps;

  // ── Health ──────────────────────────────────────────────────────────
  router.get('/health', (_req: Request, res: Response) => {
    const payload: WebHealthResponse = {
      status: 'ok',
      mode: 'web-standalone',
      timestamp: Date.now(),
      handlers: handlers.size,
      serverRoot: process.cwd(),
      pid: process.pid,
      tauriBootToken: process.env.CODE_AGENT_TAURI_BOOT_TOKEN || null,
      persistence: deps.getPersistenceHealth(),
      rendererServe: deps.getRendererServeDecision?.() ?? null,
    };
    res.json(payload);
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
