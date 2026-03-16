import { Router } from 'express';
import type { Request, Response } from 'express';
import type { HandlerFn } from '../electronMock';
import { formatError } from '../helpers/utils';

interface SettingsDeps {
  handlers: Map<string, HandlerFn>;
}

export function createSettingsRouter(deps: SettingsDeps): Router {
  const router = Router();
  const { handlers } = deps;

  router.get('/settings', async (_req: Request, res: Response) => {
    try {
      const handler = handlers.get('domain:settings');
      if (handler) {
        const result = await handler(null, { action: 'get', payload: undefined });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  router.put('/settings', async (req: Request, res: Response) => {
    try {
      const handler = handlers.get('domain:settings');
      if (handler) {
        const result = await handler(null, { action: 'set', payload: { settings: req.body } });
        res.json(result);
        return;
      }
      res.status(501).json({ error: 'Settings handler not registered' });
    } catch (error) {
      res.status(500).json({ error: formatError(error) });
    }
  });

  return router;
}
