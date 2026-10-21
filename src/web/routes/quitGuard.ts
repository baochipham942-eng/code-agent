import { Router } from 'express';
import type { Request, Response } from 'express';
import { setDaemonQuitIntent } from '../../host/services/daemon/quitIntent';
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

  // 壳声明的退出意图（ADR-083 append 2026-10-18）。background = 后台继续
  // （armed schedules 从此构成留守原因 + 摘掉 win32 的 EOF 停机指令）；
  // stop = 停止并退出（下一次 stdin EOF 全平台先排空再优雅停机）。
  router.post('/quit-intent', (req: Request, res: Response) => {
    const { mode } = (req.body ?? {}) as { mode?: unknown };
    if (mode !== 'background' && mode !== 'stop') {
      res.status(400).json({ error: 'invalid-quit-intent' });
      return;
    }
    setDaemonQuitIntent(mode);
    res.json({ ok: true, mode });
  });

  // Windows 后台继续（旧路由）：保留为 quit-intent background 的别名——Rust 壳
  // 仍在调用（N-RESIDENT-QUIT-THREE-BUTTONS 之前不撤）。
  router.post('/quit-guard/detach', (_req: Request, res: Response) => {
    setDaemonQuitIntent('background');
    res.json({ ok: true });
  });

  return router;
}
