import { Router } from 'express';
import type { Request, Response } from 'express';
import { getBackgroundTaskManager } from '../../main/session/backgroundTaskManager';
import { formatError } from '../helpers/utils';
import type { WebRouteLogger } from './routeTypes';

interface BackgroundRouterDeps {
  logger: WebRouteLogger;
}

function readSessionId(body: unknown): string | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const sessionId = (body as { sessionId?: unknown }).sessionId;
  return typeof sessionId === 'string' && sessionId.trim().length > 0
    ? sessionId.trim()
    : null;
}

export function createBackgroundRouter(deps: BackgroundRouterDeps): Router {
  const router = Router();
  const { logger } = deps;

  router.get('/background/tasks', (_req: Request, res: Response) => {
    const manager = getBackgroundTaskManager();
    res.json({ success: true, data: manager.getAllTasks() });
  });

  router.post('/background/move-to-background', async (req: Request, res: Response) => {
    const sessionId = readSessionId(req.body);
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'sessionId is required.' },
      });
      return;
    }

    try {
      const moved = await getBackgroundTaskManager().moveToBackground(sessionId);
      if (!moved) {
        res.status(404).json({
          success: false,
          error: { code: 'SESSION_NOT_FOUND', message: `Session ${sessionId} was not found.` },
        });
        return;
      }
      res.json({ success: true, data: { sessionId } });
    } catch (error) {
      logger.error('Failed to move session to background:', error);
      res.status(500).json({
        success: false,
        error: { code: 'BACKGROUND_MOVE_FAILED', message: formatError(error) },
      });
    }
  });

  router.post('/background/move-to-foreground', (req: Request, res: Response) => {
    const sessionId = readSessionId(req.body);
    if (!sessionId) {
      res.status(400).json({
        success: false,
        error: { code: 'INVALID_BODY', message: 'sessionId is required.' },
      });
      return;
    }

    const task = getBackgroundTaskManager().moveToForeground(sessionId);
    if (!task) {
      res.status(404).json({
        success: false,
        error: { code: 'BACKGROUND_TASK_NOT_FOUND', message: `Session ${sessionId} is not in background.` },
      });
      return;
    }
    res.json({ success: true, data: task });
  });

  return router;
}
