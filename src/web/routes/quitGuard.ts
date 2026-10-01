import { Router } from 'express';
import type { Request, Response } from 'express';
import { createLogger } from '../../host/services/infra/logger';

const logger = createLogger('QuitGuard');

interface QuitGuardSnapshot {
  activeRuns: number;
  armedSchedules: number;
}

interface QuitGuardRouterDeps {
  getSnapshot: () => Promise<QuitGuardSnapshot>;
}

function readIntegerCounts(snapshot: unknown): QuitGuardSnapshot | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const { activeRuns, armedSchedules } = snapshot as {
    activeRuns?: unknown;
    armedSchedules?: unknown;
  };
  if (typeof activeRuns !== 'number' || !Number.isInteger(activeRuns)) return null;
  if (typeof armedSchedules !== 'number' || !Number.isInteger(armedSchedules)) return null;
  return { activeRuns, armedSchedules };
}

export function createQuitGuardRouter(deps: QuitGuardRouterDeps): Router {
  const router = Router();

  router.get('/quit-guard', async (_req: Request, res: Response) => {
    try {
      const counts = readIntegerCounts(await deps.getSnapshot());
      if (!counts) {
        logger.warn('quit-guard snapshot unavailable', 'non-integer snapshot');
        res.status(500).json({ error: 'quit-guard-unavailable' });
        return;
      }
      res.json(counts);
    } catch (error) {
      logger.warn('quit-guard snapshot unavailable', error);
      res.status(500).json({ error: 'quit-guard-unavailable' });
    }
  });

  return router;
}
