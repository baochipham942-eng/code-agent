import path from 'node:path';
import { Router } from 'express';
import type { Request, Response } from 'express';
import type { InternalFeatureHostRuntime } from '../../host/internalFeatures/internalFeatureHostRuntime';
import { isCurrentUserAdmin } from '../../host/ipc/adminGuard';
import { verifyInstalledPluginTrust } from '../../host/plugins/pluginPackageTrust';
import type { LoadedPlugin } from '../../host/plugins/types';

interface InternalFeaturesRouterDeps {
  runtime: Pick<InternalFeatureHostRuntime, 'isLoaded' | 'loadedHash'>;
  registry: {
    getPlugin(pluginId: string): LoadedPlugin | undefined;
  };
  pluginsDir: string;
  verifyPluginTrust?: typeof verifyInstalledPluginTrust;
}

function wildcardPath(value: unknown): string {
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string').join('/');
  return typeof value === 'string' ? value : '';
}

export function createInternalFeaturesRouter(deps: InternalFeaturesRouterDeps): Router {
  const router = Router();
  const verifyPluginTrust = deps.verifyPluginTrust ?? verifyInstalledPluginTrust;

  router.get('/internal-features/:id/{*path}', (req: Request, res: Response) => {
    const pluginId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!pluginId) {
      res.sendStatus(404);
      return;
    }
    if (!isCurrentUserAdmin() || !deps.runtime.isLoaded(pluginId) || !deps.runtime.loadedHash(pluginId)) {
      res.sendStatus(404);
      return;
    }

    const plugin = deps.registry.getPlugin(pluginId);
    const feature = plugin?.manifest.internalFeature;
    if (!plugin || plugin.manifest.surfaces?.[0] !== 'internal-feature' || !feature) {
      res.sendStatus(404);
      return;
    }

    const base = path.resolve(deps.pluginsDir, pluginId, path.dirname(feature.rendererEntry));
    const requestedFile = path.resolve(base, wildcardPath(req.params.path));
    if (!requestedFile.startsWith(`${base}${path.sep}`)) {
      res.sendStatus(404);
      return;
    }

    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(requestedFile, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });

  router.get('/plugin-ui/:id/{*path}', async (req: Request, res: Response) => {
    const pluginId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    if (!pluginId || !isCurrentUserAdmin()) {
      res.sendStatus(404);
      return;
    }

    const plugin = deps.registry.getPlugin(pluginId);
    const pluginUi = plugin?.manifest.pluginUi;
    if (!plugin || plugin.manifest.surfaces?.[0] !== 'ui' || !pluginUi) {
      res.sendStatus(404);
      return;
    }
    try {
      await verifyPluginTrust(plugin.rootPath, plugin.manifest);
    } catch {
      res.sendStatus(404);
      return;
    }

    const base = path.resolve(plugin.rootPath, path.dirname(pluginUi.rendererEntry));
    const requestedFile = path.resolve(base, wildcardPath(req.params.path));
    if (!requestedFile.startsWith(`${base}${path.sep}`)) {
      res.sendStatus(404);
      return;
    }

    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(requestedFile, (error) => {
      if (error && !res.headersSent) res.sendStatus(404);
    });
  });

  return router;
}
