import fs from 'fs';
import crypto from 'crypto';
import path from 'path';
import type {
  RuntimeAssetFileStatus,
  RuntimeAssetHashKind,
  RuntimeAssetModuleStatus,
  RuntimeAssetRegistryEntry,
  RuntimeAssetRegistrySource,
  RuntimeAssetsStatus,
  RuntimeAssetStatusEntry,
} from '../../shared/contract/update';
import { getRuntimeAssetsBaseDir, readActiveRuntimeAssets } from './runtimeAssetInstaller';
import {
  resolveHelperBinary,
  resolveNodeModule,
  resolveRuntimeRoot,
  type RuntimeAssetResolverOptions,
} from './runtimeAssetResolver';
import {
  CURRENT_RUNTIME_ASSET_PLATFORM,
  RUNTIME_ASSET_DEFINITIONS,
  type RuntimeAssetDefinition,
} from './runtimeAssetRegistry';

export interface RuntimeAssetsStatusOptions {
  runtimeBaseDir?: string;
  resolverOptions?: RuntimeAssetResolverOptions;
  shellVersion?: string;
  platform?: string;
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
    unsupported: assets.filter((asset) => asset.state === 'unsupported').length,
  };
}

function isExecutable(filePath: string): boolean {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return false;
    if (process.platform === 'win32') return true;
    return (stat.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function fileSha256(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) return undefined;
    const hash = crypto.createHash('sha256');
    hash.update(fs.readFileSync(filePath));
    return hash.digest('hex');
  } catch {
    return undefined;
  }
}

function classifySource(
  targetPath: string,
  runtimeRoot: string,
  resolverOptions: RuntimeAssetResolverOptions,
): RuntimeAssetRegistrySource {
  if (!fs.existsSync(targetPath)) return 'missing';
  if (isInside(runtimeRoot, targetPath)) return 'bundled';
  if (resolverOptions.cwd && isInside(resolverOptions.cwd, targetPath)) return 'dev';
  if (resolverOptions.dirname && isInside(path.resolve(resolverOptions.dirname, '..', '..'), targetPath)) return 'dev';
  return 'bundled';
}

function assetVersion(definition: RuntimeAssetDefinition, activeVersion: string | undefined, shellVersion: string | undefined): string | undefined {
  return activeVersion ?? definition.version ?? (definition.delivery === 'bundled' ? shellVersion : undefined);
}

function assetMinShellVersion(
  definition: RuntimeAssetDefinition,
  activeMinShellVersion: string | undefined,
  activeVersion: string | undefined,
  shellVersion: string | undefined,
): string | undefined {
  return activeMinShellVersion ?? definition.minShellVersion ?? activeVersion ?? (definition.delivery === 'bundled' ? shellVersion : undefined);
}

function pinnedHash(definition: RuntimeAssetDefinition, platform: string): { hash?: string; hashKind?: RuntimeAssetHashKind } {
  const pinned = definition.pinnedHashes?.[platform];
  return pinned ? { hash: pinned.hash, hashKind: pinned.hashKind } : {};
}

export async function getRuntimeAssetsStatus(
  options: RuntimeAssetsStatusOptions = {},
): Promise<RuntimeAssetsStatus> {
  const runtimeBaseDir = path.resolve(options.runtimeBaseDir ?? getRuntimeAssetsBaseDir());
  const platform = options.platform ?? CURRENT_RUNTIME_ASSET_PLATFORM;
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
  const runtimeRoot = resolveRuntimeRoot(resolverOptions);

  const definitions = RUNTIME_ASSET_DEFINITIONS;
  const assets = definitions.map((definition): RuntimeAssetStatusEntry => {
    const supported = !definition.platforms || definition.platforms.includes(platform);
    const activeRecord = active?.assets[definition.id];
    const nodeModules = (definition.nodeModules ?? []).map((name): RuntimeAssetModuleStatus => {
      const modulePath = resolveNodeModule(name, resolverOptions);
      const managed = activeRecord?.root ? isInside(activeRecord.root, modulePath) : false;
      return {
        name,
        path: modulePath,
        exists: fs.existsSync(modulePath),
        source: managed ? 'managed' : 'bundled',
      };
    });
    const files: RuntimeAssetFileStatus[] = definition.resourceName ? (() => {
      const resourcePath = resolveHelperBinary(definition.resourceName, resolverOptions);
      const exists = fs.existsSync(resourcePath);
      const executable = exists && definition.resourceKind !== 'directory'
        ? isExecutable(resourcePath)
        : undefined;
      return [{
        name: definition.resourceName,
        path: resourcePath,
        exists,
        ...(executable !== undefined ? { executable } : {}),
        source: classifySource(resourcePath, runtimeRoot, resolverOptions),
      }];
    })() : [];

    const managedReady = Boolean(activeRecord?.root)
      && fs.existsSync(activeRecord!.root)
      && nodeModules.every((moduleStatus) => moduleStatus.exists && moduleStatus.source === 'managed');
    const fallbackReady = nodeModules.every((moduleStatus) => moduleStatus.exists)
      && files.every((fileStatus) => fileStatus.exists && fileStatus.source !== 'missing' && fileStatus.executable !== false);
    const state = !supported ? 'unsupported' : managedReady ? 'installed' : fallbackReady ? 'bundledFallback' : 'missing';
    const source: RuntimeAssetRegistrySource = managedReady
      ? 'managed'
      : files[0]?.source ?? (fallbackReady ? 'bundled' : 'missing');
    const firstPath = activeRecord?.root ?? files[0]?.path ?? nodeModules[0]?.path;
    const version = assetVersion(definition, activeRecord?.appVersion, options.shellVersion);
    const minShellVersion = assetMinShellVersion(
      definition,
      activeRecord?.minShellVersion,
      activeRecord?.appVersion,
      options.shellVersion,
    );
    const pinned = pinnedHash(definition, platform);
    const hash = activeRecord?.archiveSha256
      ?? activeRecord?.expandedSha256
      ?? pinned.hash
      ?? (definition.resourceKind === 'file' && files[0]?.exists ? fileSha256(files[0].path) : undefined);
    const hashKind: RuntimeAssetHashKind | undefined = activeRecord?.archiveSha256
      ? 'archiveSha256'
      : activeRecord?.expandedSha256
        ? 'expandedSha256'
        : pinned.hashKind
          ?? (definition.resourceKind === 'file' && files[0]?.exists ? 'fileSha256' : undefined);
    const registry: RuntimeAssetRegistryEntry = {
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      delivery: definition.delivery,
      state,
      source,
      ...(firstPath ? { path: firstPath } : {}),
      ...(version ? { version } : {}),
      ...(minShellVersion ? { minShellVersion } : {}),
      platform: activeRecord?.platform ?? platform,
      ...(hash ? { hash } : {}),
      ...(hashKind ? { hashKind } : {}),
      required: supported && definition.delivery === 'bundled',
    };

    return {
      id: definition.id,
      label: definition.label,
      kind: definition.kind,
      delivery: definition.delivery,
      state,
      nodeModules,
      ...(files.length > 0 ? { files } : {}),
      activeRoot: activeRecord?.root,
      installedAt: activeRecord?.installedAt,
      version,
      minShellVersion,
      platform: registry.platform,
      archiveSha256: activeRecord?.archiveSha256,
      expandedSha256: activeRecord?.expandedSha256,
      registry,
    };
  });

  return {
    runtimeBaseDir,
    activeManifestPath,
    assets,
    summary: summarize(assets),
  };
}
