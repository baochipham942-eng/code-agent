import { Router } from 'express';
import type { CompanionGateway } from '../../host/companion/CompanionGateway';

export interface CompanionRouterDeps {
  gateway: CompanionGateway;
}

/**
 * Authenticated companion transport boundary. The normal /api Bearer guard is
 * still applied by app.ts; this route additionally requires a device id in the
 * command contract and never exposes the desktop token as a device credential.
 */
export function createCompanionRouter({ gateway }: CompanionRouterDeps): Router {
  const router = Router();

  router.post('/companion/commands', (req, res) => {
    const result = gateway.submit(req.body);
    if (result.kind === 'accepted' || result.kind === 'replayed') {
      res.status(result.kind === 'replayed' ? 200 : 202).json({ success: true, data: result });
      return;
    }
    const status = result.kind === 'approval_conflict' || result.kind === 'conflict' ? 409 : 403;
    res.status(status).json({ success: false, error: result });
  });

  router.get('/companion/sync', (req, res) => {
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
