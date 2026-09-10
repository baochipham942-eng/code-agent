import { Router } from 'express';
import { z } from 'zod';
import { COMPANION_LIMITS } from '../../shared/constants/companion';
import type { CompanionGateway } from '../../host/companion/CompanionGateway';

/** Same shape the handler validated by hand; parsing it keeps `any` out of the route. */
const pairingSchema = z.object({
  scope: z.array(z.string().trim().min(1)).min(1).max(COMPANION_LIMITS.maxScopeSessions),
});

export function createCompanionProvisioningRouter({ gateway }: { gateway: CompanionGateway }): Router {
  const router = Router();
  router.post('/pairing', (req, res) => {
    const parsed = pairingSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ success: false, error: { code: 'INVALID_COMPANION_SCOPE' } });
      return;
    }
    res.status(201).json({ success: true, data: gateway.issueDeviceCredential(parsed.data.scope) });
  });
  return router;
}
