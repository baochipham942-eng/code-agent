import { Router } from 'express';
import type { CompanionGateway } from '../../host/companion/CompanionGateway';

export interface CompanionRouterDeps {
  gateway: CompanionGateway;
  authenticate: (deviceId: string, credential: string) => boolean;
}

/**
 * Authenticated companion transport boundary. This route is mounted outside
 * the desktop /api Bearer guard and requires a separate device credential.
 */
export function createCompanionRouter({ gateway, authenticate }: CompanionRouterDeps): Router {
  const router = Router();
  router.use((req, res, next) => {
    const deviceId = req.header('x-neo-companion-device')?.trim();
    const credential = req.header('x-neo-companion-credential')?.trim();
    if (!deviceId || !credential || !authenticate(deviceId, credential)) {
      res.status(401).json({ success: false, error: { code: 'COMPANION_UNAUTHORIZED' } });
      return;
    }
    next();
  });

  router.post('/commands', (req, res) => {
    const result = gateway.submit(req.body);
    if (result.kind === 'accepted' || result.kind === 'replayed') {
      res.status(result.kind === 'replayed' ? 200 : 202).json({ success: true, data: result });
      return;
    }
    const status = result.kind === 'approval_conflict' || result.kind === 'conflict' ? 409 : 403;
    res.status(status).json({ success: false, error: result });
  });

  router.get('/sync', (req, res) => {
    const epoch = Number(req.query.epoch);
    const afterSeq = Number(req.query.afterSeq ?? 0);
    if (!Number.isInteger(epoch) || epoch < 1 || !Number.isInteger(afterSeq) || afterSeq < 0) {
      res.status(400).json({ success: false, error: { code: 'INVALID_SYNC_CURSOR' } });
      return;
    }
    res.json({ success: true, data: gateway.sync(epoch, afterSeq) });
  });

  return router;
}
