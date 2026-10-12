import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import {
  getSSEStreamCursor,
  registerSSEClient,
  replayFromCursor,
  sendSSEPayload,
  sseClients,
} from '../helpers/sse';
import { envelopeWebAgentEvent } from '../helpers/agentStreamCursor';
import { isCurrentUserAdmin } from '../../host/ipc/adminGuard';
import { getSessionStateManager } from '../../host/session/sessionStateManager';
import type {
  BuildInfo,
  PermissionRequest,
  PersistenceHealth,
  RendererServeDecision,
  WebHealthDetail,
  WebHealthPublic,
} from '../../shared/contract';

interface HealthDeps {
  handlers: Map<string, HandlerFn>;
  getBuildInfo: () => BuildInfo | null;
  getPersistenceHealth: () => PersistenceHealth;
  getDurableRunReady: () => boolean;
  getRendererServeDecision?: () => RendererServeDecision | null;
  getPendingPermissionRequests?: () => PermissionRequest[];
  onRendererReady?: () => void;
}

function sendPendingPermissionSnapshots(
  res: Response,
  requests: PermissionRequest[],
): number {
  for (const request of requests) {
    sendSSEPayload(res, 'agent:event', {
      ...envelopeWebAgentEvent(request.sessionId ?? 'global', {
        type: 'permission_request',
        data: request,
      }),
      snapshot: true,
    });
  }
  return requests.length;
}

function buildHealthPayload(deps: HealthDeps): WebHealthDetail {
  return {
    status: 'ok',
    mode: 'web-standalone',
    timestamp: Date.now(),
    handlers: deps.handlers.size,
    serverRoot: process.cwd(),
    pid: process.pid,
    tauriBootToken: process.env.CODE_AGENT_TAURI_BOOT_TOKEN || null,
    build: deps.getBuildInfo(),
    persistence: deps.getPersistenceHealth(),
    durableRunReady: deps.getDurableRunReady(),
    rendererServe: deps.getRendererServeDecision?.() ?? null,
  };
}

function projectPublicHealth(payload: WebHealthDetail): WebHealthPublic {
  const buildVersion = payload.build?.version;
  return {
    status: payload.status,
    mode: payload.mode,
    timestamp: payload.timestamp,
    durableRunReady: payload.durableRunReady,
    rendererServe: payload.rendererServe,
    tauriBootToken: payload.tauriBootToken,
    build: typeof buildVersion === 'string' ? { version: buildVersion } : null,
  };
}

export function createHealthRouter(deps: HealthDeps): Router {
  const router = Router();

  // ── Health ──────────────────────────────────────────────────────────
  router.get('/health', (req: Request, res: Response) => {
    if (req.query.rendererReady === '1') deps.onRendererReady?.();
    res.json(projectPublicHealth(buildHealthPayload(deps)));
  });

  router.get('/health/detail', (_req: Request, res: Response) => {
    res.json(buildHealthPayload(deps));
  });

  // ── SSE Events ─────────────────────────────────────────────────────
  router.get('/events', (_req: Request, res: Response) => {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    });
    registerSSEClient(res, isCurrentUserAdmin());

    // ADR-010 #6: 客户端重连时通过 Last-Event-ID header 或 lastEventId query 带上
    // 已见过的最大事件 id，服务端用 replay buffer 补发断线窗口内错过的事件。
    const headerLastId = _req.header('Last-Event-ID');
    const queryLastId = typeof _req.query.lastEventId === 'string' ? _req.query.lastEventId : undefined;
    const rawLastId = headerLastId ?? queryLastId;
    const queryStreamEpoch = typeof _req.query.streamEpoch === 'string'
      ? _req.query.streamEpoch
      : undefined;
    let needsHostSnapshot = rawLastId === undefined || queryStreamEpoch === undefined;
    let snapshotReason: 'initial_snapshot' | 'replay_gap' = 'initial_snapshot';
    if (rawLastId !== undefined && queryStreamEpoch !== undefined) {
      const parsed = Number.parseInt(rawLastId, 10);
      if (Number.isFinite(parsed) && parsed >= 0) {
        needsHostSnapshot = replayFromCursor(res, {
          streamEpoch: queryStreamEpoch,
          sessionId: '__sse__',
          seq: parsed,
        }) < 0;
        if (needsHostSnapshot) snapshotReason = 'replay_gap';
      } else {
        needsHostSnapshot = true;
        snapshotReason = 'replay_gap';
      }
    }

    const watermark = getSSEStreamCursor();
    sendSSEPayload(res, 'connected', {
      ...watermark,
      requiresSnapshot: needsHostSnapshot,
      reason: snapshotReason,
    });

    // 新 renderer 没有旧游标；replay buffer 覆盖时同样无法补齐。两种情况都从
    // host 当前仍持有 resolver 的请求恢复审批卡，不重发工具，也不新建审批。
    if (needsHostSnapshot) {
      try {
        sendPendingPermissionSnapshots(res, deps.getPendingPermissionRequests?.() ?? []);
      } catch {
        // SSE 主连接仍可继续；后续实时 permission_request 不受一次快照读取失败影响。
      }
      try {
        for (const summary of getSessionStateManager().getAllSummariesArray()) {
          sendSSEPayload(res, 'session:status:update', { ...summary, snapshot: true });
        }
      } catch {
        // SSE 主连接仍可继续；后续实时 session status 不受一次快照读取失败影响。
      }
    }

    _req.on('close', () => {
      sseClients.delete(res);
    });
  });

  return router;
}
