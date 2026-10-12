import { Router, type Request, type Response } from 'express';
import type { CompanionGateway } from '../../host/services/companion/CompanionGateway';

/**
 * The router guard below rejects every request without a device header, so a miss
 * here is a wiring bug rather than untrusted input — surface it instead of asserting.
 */
function deviceOf(req: Request): string {
  const deviceId = req.header('x-neo-companion-device')?.trim();
  if (!deviceId) throw new Error('COMPANION_UNAUTHORIZED');
  return deviceId;
}

/**
 * While the remote switch is off, syncForDevice/commandStatus throw
 * COMPANION_REMOTE_OFF (same code the LAN surface refuses with). Answer it as a
 * coded 403 like POST /commands does instead of letting it surface as a bare 500.
 */
function respondOrRefuse<T>(res: Response, read: () => T): void {
  try {
    res.json({ success: true, data: read() });
  } catch (error) {
    if (error instanceof Error && error.message === 'COMPANION_REMOTE_OFF') {
      res.status(403).json({ success: false, error: { code: 'COMPANION_REMOTE_OFF' } });
      return;
    }
    throw error;
  }
}

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
    // This HTTP adapter is for local integration only. The remote entry point
    // must authenticate an end-to-end encrypted device session before dispatch.
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ success: false, error: { code: 'COMPANION_SECURE_CHANNEL_REQUIRED' } });
      return;
    }
    const deviceId = req.header('x-neo-companion-device')?.trim();
    const credential = req.header('x-neo-companion-credential')?.trim();
    if (!deviceId || !credential || !authenticate(deviceId, credential)) {
      res.status(401).json({ success: false, error: { code: 'COMPANION_UNAUTHORIZED' } });
      return;
    }
    next();
  });

  router.post('/commands', async (req, res) => {
    const body = req.body as { deviceId?: unknown } | undefined;
    if (body?.deviceId !== deviceOf(req)) {
      res.status(403).json({ success: false, error: { code: 'COMPANION_IDENTITY_MISMATCH' } });
      return;
    }
    const result = await gateway.submit(req.body);
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
    if (!Number.isSafeInteger(epoch) || epoch < 1 || !Number.isSafeInteger(afterSeq) || afterSeq < 0) {
      res.status(400).json({ success: false, error: { code: 'INVALID_SYNC_CURSOR' } });
      return;
    }
    respondOrRefuse(res, () => gateway.syncForDevice(deviceOf(req), epoch, afterSeq));
  });

  router.get('/commands/:commandId', (req, res) => {
    respondOrRefuse(res, () => {
      const command = gateway.commandStatus(deviceOf(req), String(req.params.commandId));
      return command ? { kind: 'found', command } : { kind: 'not_seen' };
    });
  });

  return router;
}
