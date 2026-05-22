import fs from 'fs';
import path from 'path';
import { getUserDataPath } from '../platform/appPaths';

export type RuntimeAssetKind = 'dist/web' | 'dist/renderer' | 'dist/native';

export interface RuntimeAssetResolverOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  dirname?: string;
  resourcesPath?: string;
  existsSync?: (targetPath: string) => boolean;
  readFileSync?: (targetPath: string, encoding: BufferEncoding) => string;
  userDataPath?: string;
}

const MANAGED_RUNTIME_ROOT_ENV = 'AGENT_NEO_MANAGED_RUNTIME_ROOT';
const MANAGED_RUNTIME_ASSETS_ROOT_ENV = 'AGENT_NEO_MANAGED_RUNTIME_ASSETS_ROOT';
const RUNTIME_ACTIVE_MANIFEST_ENV = 'AGENT_NEO_RUNTIME_ACTIVE_MANIFEST';
const BUNDLED_RUNTIME_ROOT_ENV = 'AGENT_NEO_BUNDLED_RUNTIME_ROOT';
const RESOURCE_DIR_ENV = 'AGENT_NEO_RESOURCE_DIR';
const RUNTIME_ASSETS_ACTIVE_KIND = 'agent_neo_runtime_assets_active';

const RUNTIME_ASSET_KINDS: Record<RuntimeAssetKind, string[]> = {
  'dist/web': ['dist', 'web'],
  'dist/renderer': ['dist', 'renderer'],
  'dist/native': ['dist', 'native'],
};

function normalizeRoot(root: string | undefined): string | null {
  const trimmed = root?.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function unique(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const candidate of paths) {
    const resolved = path.resolve(candidate);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    result.push(resolved);
  }

  return result;
}

function getRuntimeOptions(options: RuntimeAssetResolverOptions): Required<RuntimeAssetResolverOptions> {
  const processWithResources = process as NodeJS.Process & { resourcesPath?: string };

  return {
    env: options.env ?? process.env,
    cwd: options.cwd ?? process.cwd(),
    dirname: options.dirname ?? __dirname,
    resourcesPath: options.resourcesPath ?? processWithResources.resourcesPath ?? '',
    existsSync: options.existsSync ?? fs.existsSync,
    readFileSync: options.readFileSync ?? fs.readFileSync,
    userDataPath: options.userDataPath ?? getUserDataPath(),
  };
}

function candidateRuntimeRoots(options: Required<RuntimeAssetResolverOptions>): string[] {
  const roots: string[] = [];
  const resourceDir = normalizeRoot(options.env[RESOURCE_DIR_ENV]) ?? normalizeRoot(options.resourcesPath);
  const dirname = path.resolve(options.dirname);
  const cwd = path.resolve(options.cwd);

  if (resourceDir) {
    roots.push(path.join(resourceDir, '_up_'));
    roots.push(resourceDir);
  }

  roots.push(cwd);
  roots.push(path.join(cwd, '..'));
  roots.push(path.join(dirname, '..', '..'));
  roots.push(path.join(dirname, '..', '..', '..'));
  roots.push(path.join(dirname, '..', '..', '..', '..'));

  return unique(roots);
}

function hasRuntimeAssets(root: string, existsSync: (targetPath: string) => boolean): boolean {
  return existsSync(path.join(root, 'dist', 'web'))
    || existsSync(path.join(root, 'dist', 'renderer'))
    || existsSync(path.join(root, 'dist', 'native'));
}

function firstExisting(candidates: string[], existsSync: (targetPath: string) => boolean): string {
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0];
}

function activeManifestPath(options: Required<RuntimeAssetResolverOptions>): string {
  const envPath = normalizeRoot(options.env[RUNTIME_ACTIVE_MANIFEST_ENV]);
  return envPath ?? path.join(options.userDataPath, 'runtime', 'active.json');
}

function parseActiveRuntimeRoots(
  manifestPath: string,
  options: Required<RuntimeAssetResolverOptions>,
  moduleName: string,
): string[] {
  if (!options.existsSync(manifestPath)) return [];

  try {
    const parsed = JSON.parse(options.readFileSync(manifestPath, 'utf8')) as {
      kind?: string;
      assets?: Record<string, {
        root?: string;
        nodeModules?: string[];
      }>;
    };
    if (parsed.kind !== RUNTIME_ASSETS_ACTIVE_KIND || !parsed.assets) return [];

    return Object.values(parsed.assets)
      .filter((asset) => {
        if (!asset.root) return false;
        return !asset.nodeModules || asset.nodeModules.length === 0 || asset.nodeModules.includes(moduleName);
      })
      .map((asset) => asset.root!)
      .map((root) => path.resolve(root));
  } catch {
    return [];
  }
}

function candidateManagedRuntimeAssetRoots(
  options: Required<RuntimeAssetResolverOptions>,
  moduleName: string,
): string[] {
  const roots: string[] = [];
  const managedAssetsRoot = normalizeRoot(options.env[MANAGED_RUNTIME_ASSETS_ROOT_ENV]);
  if (managedAssetsRoot) {
    roots.push(managedAssetsRoot);
  }

  roots.push(...parseActiveRuntimeRoots(activeManifestPath(options), options, moduleName));
  return unique(roots);
}

export function resolveRuntimeRoot(options: RuntimeAssetResolverOptions = {}): string {
  const resolvedOptions = getRuntimeOptions(options);
  const managedRoot = normalizeRoot(resolvedOptions.env[MANAGED_RUNTIME_ROOT_ENV]);
  if (managedRoot) return managedRoot;

  const bundledRoot = normalizeRoot(resolvedOptions.env[BUNDLED_RUNTIME_ROOT_ENV]);
  if (bundledRoot) return bundledRoot;

  const candidates = candidateRuntimeRoots(resolvedOptions);
  return candidates.find((candidate) => hasRuntimeAssets(candidate, resolvedOptions.existsSync))
    ?? candidates[0];
}

export function resolveBundledPath(
  kind: RuntimeAssetKind,
  options: RuntimeAssetResolverOptions = {},
): string {
  return path.join(resolveRuntimeRoot(options), ...RUNTIME_ASSET_KINDS[kind]);
}

function candidateNodeModulePaths(
  name: string,
  resolvedOptions: Required<RuntimeAssetResolverOptions>,
): string[] {
  const root = resolveRuntimeRoot(resolvedOptions);
  return unique([
    ...candidateManagedRuntimeAssetRoots(resolvedOptions, name).flatMap((managedRoot) => [
      path.join(managedRoot, 'node_modules', name),
      path.join(managedRoot, name),
    ]),
    path.join(root, 'node_modules', name),
    path.join(root, 'dist', 'native', 'node_modules', name),
    path.join(root, 'dist', 'native', name),
    path.join(resolvedOptions.cwd, 'node_modules', name),
    path.join(resolvedOptions.dirname, '..', '..', 'node_modules', name),
  ]);
}

export function resolveNodeModule(
  name: string,
  options: RuntimeAssetResolverOptions = {},
): string {
  const resolvedOptions = getRuntimeOptions(options);
  const candidates = candidateNodeModulePaths(name, resolvedOptions);

  return firstExisting(candidates, resolvedOptions.existsSync);
}

export function resolveExistingNodeModule(
  name: string,
  options: RuntimeAssetResolverOptions = {},
): string | null {
  const resolvedOptions = getRuntimeOptions(options);
  return candidateNodeModulePaths(name, resolvedOptions)
    .find((candidate) => resolvedOptions.existsSync(candidate)) ?? null;
}

export function resolveHelperBinary(
  name: string,
  options: RuntimeAssetResolverOptions = {},
): string {
  const resolvedOptions = getRuntimeOptions(options);
  const root = resolveRuntimeRoot(options);
  const candidates = unique([
    path.join(root, 'scripts', name),
    path.join(root, 'resources', name),
    path.join(root, 'resources', 'bin', name),
    path.join(root, 'dist', 'native', name),
    path.join(resolvedOptions.cwd, 'scripts', name),
    path.join(resolvedOptions.dirname, '..', '..', 'scripts', name),
  ]);

  return firstExisting(candidates, resolvedOptions.existsSync);
}
