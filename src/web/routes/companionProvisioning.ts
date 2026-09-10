import { Router } from 'express';
import type { CompanionGateway } from '../../host/companion/CompanionGateway';

export function createCompanionProvisioningRouter({ gateway }: { gateway: CompanionGateway }): Router {
  const router = Router();
  router.post('/pairing', (req, res) => {
    const scope = req.body?.scope;
    if (!Array.isArray(scope) || scope.length === 0 || scope.length > 32 || scope.some((value: unknown) => typeof value !== 'string' || !value.trim())) {
      res.status(400).json({ success: false, error: { code: 'INVALID_COMPANION_SCOPE' } });
      return;
    }
    res.status(201).json({ success: true, data: gateway.issueDeviceCredential(scope.map((value: string) => value.trim())) });
  });
  return router;
}
