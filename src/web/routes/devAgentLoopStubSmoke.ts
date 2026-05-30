import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ActiveAgentLoop } from './agent';
import type { WebRouteLogger } from './routeTypes';

interface DevAgentLoopStubEntry {
  id: string;
  sessionId: string;
  loop: ActiveAgentLoop;
  createdAt: number;
  cancelledAt?: number;
  cancelCount: number;
  cancelReason?: string | null;
  paused: boolean;
  pauseCount: number;
  resumedAt?: number;
  resumeCount: number;
}

interface DevAgentLoopStubSmokeDeps {
  activeAgentLoops: Map<string, ActiveAgentLoop>;
  isEnabled: () => boolean;
  logger: WebRouteLogger;
}

const stubLoops = new Map<string, DevAgentLoopStubEntry>();
let nextStubLoopId = 1;

function readSessionId(body: unknown): string {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new Error('Request body must be an object.');
  }
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  if (typeof sessionId !== 'string' || sessionId.trim().length === 0) {
    throw new Error('sessionId is required.');
  }
  return sessionId.trim();
}

function readParamString(value: string | string[] | undefined, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${fieldName} is required.`);
  }
  return value.trim();
}

function describeEntry(
  sessionId: string,
  entry: DevAgentLoopStubEntry | undefined,
  activeAgentLoops: Map<string, ActiveAgentLoop>,
): Record<string, unknown> {
  return {
    id: entry?.id ?? null,
    sessionId,
    exists: Boolean(entry),
    active: entry ? activeAgentLoops.get(sessionId) === entry.loop : activeAgentLoops.has(sessionId),
    createdAt: entry?.createdAt ?? null,
    cancelledAt: entry?.cancelledAt ?? null,
    cancelCount: entry?.cancelCount ?? 0,
    cancelReason: entry?.cancelReason ?? null,
    paused: entry?.paused ?? false,
    pauseCount: entry?.pauseCount ?? 0,
    resumedAt: entry?.resumedAt ?? null,
    resumeCount: entry?.resumeCount ?? 0,
  };
}

export function createDevAgentLoopStubSmokeRouter(deps: DevAgentLoopStubSmokeDeps): Router {
  const router = Router();
  const { activeAgentLoops, isEnabled, logger } = deps;

  router.use((req: Request, res: Response, next) => {
    if (!isEnabled()) {
      res.status(404).json({ ok: false, error: 'Dev API is disabled.' });
      return;
    }
    next();
  });

  router.post('/', (req: Request, res: Response) => {
    try {
      const sessionId = readSessionId(req.body);
      const existingLoop = activeAgentLoops.get(sessionId);
      const existingStub = stubLoops.get(sessionId);
      if (existingLoop && existingLoop !== existingStub?.loop) {
        res.status(409).json({ ok: false, error: 'Session already has a non-stub active agent loop.' });
        return;
      }

      if (existingStub && activeAgentLoops.get(sessionId) === existingStub.loop) {
        activeAgentLoops.delete(sessionId);
      }

      const entry: DevAgentLoopStubEntry = {
        id: `dev-agent-loop-stub-${nextStubLoopId++}`,
        sessionId,
        createdAt: Date.now(),
        cancelCount: 0,
        paused: false,
        pauseCount: 0,
        resumeCount: 0,
        loop: {
          cancel(reason?: string) {
            entry.cancelledAt = Date.now();
            entry.cancelCount += 1;
            entry.cancelReason = reason ?? null;
          },
          pause() {
            entry.paused = true;
            entry.pauseCount += 1;
          },
          resume() {
            entry.paused = false;
            entry.resumedAt = Date.now();
            entry.resumeCount += 1;
          },
        },
      };

      stubLoops.set(sessionId, entry);
      activeAgentLoops.set(sessionId, entry.loop);
      res.json({ ok: true, ...describeEntry(sessionId, entry, activeAgentLoops) });
    } catch (error) {
      logger.warn('Dev agent loop stub creation failed', error);
      const message = error instanceof Error ? error.message : 'Invalid dev agent loop stub request.';
      res.status(400).json({ ok: false, error: message });
    }
  });

  router.get('/:sessionId', (req: Request, res: Response) => {
    const sessionId = readParamString(req.params.sessionId, 'sessionId');
    res.json({ ok: true, ...describeEntry(sessionId, stubLoops.get(sessionId), activeAgentLoops) });
  });

  router.delete('/:sessionId', (req: Request, res: Response) => {
    const sessionId = readParamString(req.params.sessionId, 'sessionId');
    const entry = stubLoops.get(sessionId);
    if (entry && activeAgentLoops.get(sessionId) === entry.loop) {
      activeAgentLoops.delete(sessionId);
    }
    stubLoops.delete(sessionId);
    res.json({ ok: true, sessionId });
  });

  return router;
}
