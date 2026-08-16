import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { sseClients, replayFromLastEventId, sendSSEPayload } from '../helpers/sse';
import type {
  BuildInfo,
  PermissionRequest,
  PersistenceHealth,
  RendererServeDecision,
  WebHealthResponse,
} from '../../shared/contract';

interface HealthDeps {
  handlers: Map<string, HandlerFn>;
  getBuildInfo: () => BuildInfo | null;
  getPersistenceHealth: () => PersistenceHealth;
  getDurableRunReady: () => boolean;
  getRendererServeDecision?: () => RendererServeDecision | null;
  getPendingPermissionRequests?: () => PermissionRequest[];
}

export function sendPendingPermissionSnapshots(
  res: Response,
  requests: PermissionRequest[],
): number {
  for (const request of requests) {
    sendSSEPayload(res, 'agent:event', {
      type: 'permission_request',
      data: request,
      sessionId: request.sessionId,
      snapshot: true,
    });
  }
  return requests.length;
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
      build: deps.getBuildInfo(),
      persistence: deps.getPersistenceHealth(),
      durableRunReady: deps.getDurableRunReady(),
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
    let needsHostSnapshot = rawLastId === undefined;
    if (rawLastId !== undefined) {
      const parsed = Number.parseInt(rawLastId, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        needsHostSnapshot = replayFromLastEventId(res, parsed) < 0;
      } else {
        needsHostSnapshot = true;
      }
    }

    sseClients.add(res);

    // 新 renderer 没有旧游标；replay buffer 覆盖时同样无法补齐。两种情况都从
    // host 当前仍持有 resolver 的请求恢复审批卡，不重发工具，也不新建审批。
    if (needsHostSnapshot) {
      try {
        sendPendingPermissionSnapshots(res, deps.getPendingPermissionRequests?.() ?? []);
      } catch {
        // SSE 主连接仍可继续；后续实时 permission_request 不受一次快照读取失败影响。
      }
    }

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  return router;
}
