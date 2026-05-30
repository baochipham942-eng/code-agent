// ============================================================================
// Dev API Routes — telemetry / todos / compact-state / replay E2E seed hooks
// ============================================================================
//
// Split out of dev.ts to keep that file under the God File limit (max-lines).
// These routes back the restart-recovery / telemetry-feedback E2E smoke tests
// and reuse the seed/read helpers that remain defined in dev.ts.
// ============================================================================

import type { Router, Request, Response } from 'express';
import { formatError } from '../helpers/utils';
import type { WebRouteLogger } from './routeTypes';
import {
  DevApiError,
  readRequiredString,
  seedCompletedTelemetryTurn,
  findCloudTelemetryFeedback,
  findCloudTelemetryTrace,
  seedDevTodos,
  readDevTodos,
  seedDevCompactState,
  readDevCompactState,
  readDevReplayState,
} from './dev';
import type {
  DevTelemetrySeedTurnRequest,
  DevTodoSeedRequest,
  DevCompactStateSeedRequest,
} from './dev';

interface DevTelemetrySeedRouteDeps {
  logger: WebRouteLogger;
  ensureDevApiEnabled: (res: Response) => boolean;
}

/**
 * Registers the telemetry/todos/compact-state/replay dev seed hooks on the
 * shared dev router. Paths are unchanged from when they lived in dev.ts.
 */
export function registerDevTelemetrySeedRoutes(router: Router, deps: DevTelemetrySeedRouteDeps): void {
  const { logger, ensureDevApiEnabled } = deps;

  // ── POST /api/dev/telemetry/seed-turn ───────────────────────────────
  // 给端到端 smoke 造一条已完成 telemetry session/turn，避免为验证反馈链路真实打模型。
  router.post('/dev/telemetry/seed-turn', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedCompletedTelemetryTurn(req.body as DevTelemetrySeedTurnRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry seed-turn request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/telemetry/upload ──────────────────────────────────
  router.post('/dev/telemetry/upload', async (_req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const { getTelemetryUploaderService } = await import('../../main/telemetry/telemetryUploaderService');
      const uploaded = await getTelemetryUploaderService().upload();
      res.json({ ok: true, uploaded });
    } catch (error) {
      logger.error('Dev telemetry upload request failed', error);
      res.status(500).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/todos/seed ────────────────────────────────────────
  // E2E/dev-only hook for restart recovery smoke. Uses the real todoParser
  // persistence path instead of writing SQLite directly.
  router.post('/dev/todos/seed', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedDevTodos(req.body as DevTodoSeedRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev todos seed request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/todos ──────────────────────────────────────────────
  router.get('/dev/todos', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevTodos(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev todos read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── POST /api/dev/compact-state/seed ─────────────────────────────────
  // E2E/dev-only hook for restart recovery smoke. It seeds the post-compact
  // durable state through SessionManager and the runtime-state repository.
  router.post('/dev/compact-state/seed', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await seedDevCompactState(req.body as DevCompactStateSeedRequest);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev compact-state seed request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/compact-state ───────────────────────────────────────
  router.get('/dev/compact-state', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevCompactState(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev compact-state read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/replay-state ───────────────────────────────────────
  router.get('/dev/replay-state', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const result = await readDevReplayState(req.query.sessionId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev replay-state read request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/telemetry/cloud-feedback ───────────────────────────
  router.get('/dev/telemetry/cloud-feedback', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const sessionId = readRequiredString(req.query.sessionId, 'sessionId');
      const turnId = readRequiredString(req.query.turnId, 'turnId');
      const result = await findCloudTelemetryFeedback(sessionId, turnId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry cloud-feedback request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });

  // ── GET /api/dev/telemetry/cloud-trace ──────────────────────────────
  router.get('/dev/telemetry/cloud-trace', async (req: Request, res: Response) => {
    if (!ensureDevApiEnabled(res)) return;

    try {
      const sessionId = readRequiredString(req.query.sessionId, 'sessionId');
      const turnId = readRequiredString(req.query.turnId, 'turnId');
      const result = await findCloudTelemetryTrace(sessionId, turnId);
      res.json({ ok: true, ...result });
    } catch (error) {
      const status = error instanceof DevApiError ? error.status : 500;
      logger.error('Dev telemetry cloud-trace request failed', error);
      res.status(status).json({
        ok: false,
        error: formatError(error),
      });
    }
  });
}
