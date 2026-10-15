import { Router } from 'express';
import type { Request, Response } from 'express';
import { armBackgroundContinueDetach } from '../../host/services/daemon/shellExit';
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

  // Windows 后台继续：壳退进程前调用。把随后的 stdin EOF 从「请退出」改成驻留判据。
  // 停止并退出不走这里，关 stdin 仍是停机指令。
  router.post('/quit-guard/detach', (_req: Request, res: Response) => {
    armBackgroundContinueDetach();
    res.json({ ok: true });
  });

  return router;
}
