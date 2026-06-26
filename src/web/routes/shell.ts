import { Router } from 'express';
import type { Request, Response } from 'express';
import { getShellCapabilitiesManifest } from '../../host/shellCapabilities';

interface ShellRouterDeps {
  getAppVersion: () => string;
  now?: () => Date;
}

export function createShellRouter(deps: ShellRouterDeps): Router {
  const router = Router();

  router.get('/shell/capabilities', (_req: Request, res: Response) => {
    res.json(getShellCapabilitiesManifest(
      deps.getAppVersion(),
      (deps.now?.() ?? new Date()).toISOString(),
    ));
  });

  return router;
}
