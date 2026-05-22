import fs from 'fs';
import path from 'path';
import type {
  RuntimeAssetModuleStatus,
  RuntimeAssetsStatus,
  RuntimeAssetStatusEntry,
} from '../../shared/contract/update';
import { getRuntimeAssetsBaseDir, readActiveRuntimeAssets } from './runtimeAssetInstaller';
import { resolveNodeModule, type RuntimeAssetResolverOptions } from './runtimeAssetResolver';
import { RUNTIME_ASSET_DEFINITIONS } from './runtimeAssetRegistry';

export interface RuntimeAssetsStatusOptions {
  runtimeBaseDir?: string;
  resolverOptions?: RuntimeAssetResolverOptions;
}

function isInside(baseDir: string, targetPath: string): boolean {
  const relative = path.relative(path.resolve(baseDir), path.resolve(targetPath));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function summarize(assets: RuntimeAssetStatusEntry[]): RuntimeAssetsStatus['summary'] {
  return {
    installed: assets.filter((asset) => asset.state === 'installed').length,
    bundledFallback: assets.filter((asset) => asset.state === 'bundledFallback').length,
    missing: assets.filter((asset) => asset.state === 'missing').length,
  };
}

export async function getRuntimeAssetsStatus(
  options: RuntimeAssetsStatusOptions = {},
): Promise<RuntimeAssetsStatus> {
  const runtimeBaseDir = path.resolve(options.runtimeBaseDir ?? getRuntimeAssetsBaseDir());
  const activeManifestPath = path.join(runtimeBaseDir, 'active.json');
  const active = await readActiveRuntimeAssets(runtimeBaseDir);

  const resolverOptions: RuntimeAssetResolverOptions = {
    ...options.resolverOptions,
    env: {
      ...process.env,
      ...options.resolverOptions?.env,
      AGENT_NEO_RUNTIME_ACTIVE_MANIFEST: activeManifestPath,
    },
  };

  const assets = RUNTIME_ASSET_DEFINITIONS.map((definition): RuntimeAssetStatusEntry => {
    const activeRecord = active?.assets[definition.id];
    const nodeModules = definition.nodeModules.map((name): RuntimeAssetModuleStatus => {
      const modulePath = resolveNodeModule(name, resolverOptions);
      const managed = activeRecord?.root ? isInside(activeRecord.root, modulePath) : false;
      return {
        name,
        path: modulePath,
        exists: fs.existsSync(modulePath),
        source: managed ? 'managed' : 'bundled',
      };
    });

    const managedReady = Boolean(activeRecord?.root)
      && fs.existsSync(activeRecord!.root)
      && nodeModules.every((moduleStatus) => moduleStatus.exists && moduleStatus.source === 'managed');
    const fallbackReady = nodeModules.every((moduleStatus) => moduleStatus.exists);

    return {
      id: definition.id,
      label: definition.label,
      delivery: definition.delivery,
      state: managedReady ? 'installed' : fallbackReady ? 'bundledFallback' : 'missing',
      nodeModules,
      activeRoot: activeRecord?.root,
      installedAt: activeRecord?.installedAt,
      expandedSha256: activeRecord?.expandedSha256,
    };
  });

  return {
    runtimeBaseDir,
    activeManifestPath,
    assets,
    summary: summarize(assets),
  };
}
