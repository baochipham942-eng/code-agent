import { Router } from 'express';
import type { Request, Response } from 'express';
import type { ActiveAgentLoop } from './agent';
import type { RunHandle } from '../../host/runtime/runContext';
import { RunRegistry, RunSessionConflictError } from '../../host/runtime/runRegistry';
import type { WebRouteLogger } from './routeTypes';

interface DevAgentLoopStubEntry {
  id: string;
  sessionId: string;
  runHandle: RunHandle;
  loop: ActiveAgentLoop;
  createdAt: number;
  cancelledAt?: number;
  releasedAt?: number;
  cancelCount: number;
  cancelReason?: string | null;
  paused: boolean;
  pauseCount: number;
  resumedAt?: number;
  resumeCount: number;
}

interface DevAgentLoopStubSmokeDeps {
  runRegistry: RunRegistry;
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
  runRegistry: RunRegistry,
): Record<string, unknown> {
  const activeHandle = runRegistry.getBySessionId(sessionId);
  return {
    id: entry?.id ?? null,
    runId: entry?.runHandle.context.runId ?? activeHandle?.context.runId ?? null,
    sessionId,
    exists: Boolean(entry),
    active: entry ? activeHandle === entry.runHandle : Boolean(activeHandle),
    createdAt: entry?.createdAt ?? null,
    cancelledAt: entry?.cancelledAt ?? null,
    releasedAt: entry?.releasedAt ?? null,
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
  const { runRegistry, isEnabled, logger } = deps;

  router.use((req: Request, res: Response, next) => {
    if (!isEnabled()) {
      res.status(404).json({ ok: false, error: 'Dev API is disabled.' });
      return;
    }
    next();
  });

  router.post('/', async (req: Request, res: Response) => {
    try {
      const sessionId = readSessionId(req.body);
      const existingHandle = runRegistry.getBySessionId(sessionId);
      if (existingHandle) {
        res.status(409).json({
          ok: false,
          error: 'Session already has an active run.',
          activeRunId: existingHandle.context.runId,
        });
        return;
      }

      const id = `dev-agent-loop-stub-${nextStubLoopId++}`;
      const entry: DevAgentLoopStubEntry = {
        id,
        sessionId,
        runHandle: runRegistry.start({ runId: id, sessionId, workspace: process.cwd() }),
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
            if (runRegistry.unregister(entry.runHandle.context.runId, entry.runHandle)) {
              entry.releasedAt = Date.now();
            }
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

      await entry.runHandle.attach(entry.loop);
      stubLoops.set(sessionId, entry);
      res.json({ ok: true, ...describeEntry(sessionId, entry, runRegistry) });
    } catch (error) {
      logger.warn('Dev agent loop stub creation failed', error);
      const message = error instanceof Error ? error.message : 'Invalid dev agent loop stub request.';
      res.status(error instanceof RunSessionConflictError ? 409 : 400).json({ ok: false, error: message });
    }
  });

  router.get('/:sessionId', (req: Request, res: Response) => {
    const sessionId = readParamString(req.params.sessionId, 'sessionId');
    res.json({ ok: true, ...describeEntry(sessionId, stubLoops.get(sessionId), runRegistry) });
  });

  router.delete('/:sessionId', (req: Request, res: Response) => {
    const sessionId = readParamString(req.params.sessionId, 'sessionId');
    const entry = stubLoops.get(sessionId);
    if (entry) {
      runRegistry.unregister(entry.runHandle.context.runId, entry.runHandle);
    }
    stubLoops.delete(sessionId);
    res.json({ ok: true, sessionId });
  });

  return router;
}
