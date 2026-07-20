import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tauriConfigPath = join(repoRoot, 'src-tauri/tauri.conf.json');
const requireFromTest = createRequire(import.meta.url);

type TauriResources = string[] | Record<string, string | null>;

type PackageLocation = {
  name: string;
};

type PackageManifest = {
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
};

type PackageResolver = (packageName: string, anchorDir: string) => string | null;

type DependencyClosureEnvironment = {
  resolvePackage: PackageResolver;
  readManifest: (packageRoot: string) => PackageManifest;
};

type DependencyClosureResult = {
  skipped: string[];
};

const dependencyExemptions = new Map<string, string>([
  // 安装阶段下载预编译二进制，应用运行时不会加载这个工具。
  ['prebuild-install', '安装阶段下载预编译二进制'],
  // 原生扩展编译/装配期提供 C++ API，已生成的运行时产物不会加载它。
  ['node-addon-api', '原生扩展编译和装配期工具'],
]);

function readTauriResources(): TauriResources {
  const tauriConfig = JSON.parse(readFileSync(tauriConfigPath, 'utf8')) as {
    bundle?: { resources?: TauriResources };
  };
  return tauriConfig.bundle?.resources ?? [];
}

function resourceEntries(resources: TauriResources): Array<[string, string]> {
  if (Array.isArray(resources)) {
    return resources.map((resource) => [resource, resource]);
  }
  return Object.entries(resources).flatMap(([source, target]) => (
    typeof target === 'string' ? [[source, target]] : []
  ));
}

function findPackageLocations(resourcePath: string): PackageLocation[] {
  const segments = resourcePath.replaceAll('\\', '/').split('/');
  const locations: PackageLocation[] = [];

  for (let index = 0; index < segments.length; index += 1) {
    if (segments[index] !== 'node_modules') continue;
    const firstNameSegment = segments[index + 1];
    if (!firstNameSegment) continue;

    const scoped = firstNameSegment.startsWith('@');
    const secondNameSegment = scoped ? segments[index + 2] : undefined;
    if (scoped && !secondNameSegment) continue;

    const name = scoped ? `${firstNameSegment}/${secondNameSegment}` : firstNameSegment;
    locations.push({ name });
  }

  return locations;
}

function isWithinRepo(candidatePath: string): boolean {
  const relativePath = relative(repoRoot, candidatePath);
  return relativePath === ''
    || (!isAbsolute(relativePath) && relativePath !== '..' && !relativePath.startsWith(`..${sep}`));
}

function resolveInstalledPackage(packageName: string, anchorDir: string): string | null {
  try {
    const manifestPath = requireFromTest.resolve(`${packageName}/package.json`, {
      paths: [anchorDir],
    });
    return isWithinRepo(manifestPath) ? dirname(manifestPath) : null;
  } catch {
    return null;
  }
}

const defaultEnvironment: DependencyClosureEnvironment = {
  resolvePackage: resolveInstalledPackage,
  readManifest: (packageRoot) => (
    JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as PackageManifest
  ),
};

function collectPackagedPackages(
  resources: TauriResources,
  resolvePackage: PackageResolver,
): {
  names: Set<string>;
  roots: Map<string, string>;
} {
  const names = new Set<string>();
  const roots = new Map<string, string>();

  for (const [source, target] of resourceEntries(resources)) {
    for (const location of findPackageLocations(target)) names.add(location.name);
    let anchorDir = repoRoot;
    for (const location of findPackageLocations(source)) {
      names.add(location.name);
      const packageRoot = resolvePackage(location.name, anchorDir);
      if (packageRoot) {
        roots.set(location.name, packageRoot);
        anchorDir = packageRoot;
      }
    }
  }

  return { names, roots };
}

function assertResourcesDependencyClosure(
  resources: TauriResources,
  exemptions = dependencyExemptions,
  environment = defaultEnvironment,
): DependencyClosureResult {
  const packaged = collectPackagedPackages(resources, environment.resolvePackage);
  if (packaged.names.size === 0) {
    throw new Error(
      'Tauri resources dependency gate parsed 0 node_modules packages; the resources anchor or parser is broken.',
    );
  }

  const missingEdges = new Set<string>();
  const missingManifests = new Set<string>();
  const usedExemptions = new Set<string>();
  const visitedRoots = new Set<string>();
  const optionalOwners = new Map<string, string>();
  const skipped = new Set<string>();
  const manifestCache = new Map<string, PackageManifest>();

  const readManifest = (packageRoot: string): PackageManifest => {
    const cached = manifestCache.get(packageRoot);
    if (cached) return cached;
    const manifest = environment.readManifest(packageRoot);
    manifestCache.set(packageRoot, manifest);
    return manifest;
  };

  const registerOptionalDependencies = (owner: string, manifest: PackageManifest): void => {
    for (const dependency of Object.keys(manifest.optionalDependencies ?? {}).sort()) {
      if (!optionalOwners.has(dependency)) optionalOwners.set(dependency, owner);
    }
  };

  for (const name of [...packaged.names].sort()) {
    const root = packaged.roots.get(name);
    if (root) registerOptionalDependencies(name, readManifest(root));
  }

  const recordUnresolvedManifest = (name: string, reason: string): void => {
    const optionalOwner = optionalOwners.get(name);
    if (optionalOwner) {
      skipped.add(
        `${name} (optional dependency of ${optionalOwner}; not installed on this machine/platform)`,
      );
      return;
    }
    missingManifests.add(`${name} (${reason})`);
  };

  const queue = [...packaged.names]
    .sort()
    .flatMap((name) => {
      const root = packaged.roots.get(name);
      if (root) return [{ name, root }];
      recordUnresolvedManifest(name, 'packaged resource has no readable package.json');
      return [];
    });

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const manifestPath = join(current.root, 'package.json');
    if (visitedRoots.has(manifestPath)) continue;
    visitedRoots.add(manifestPath);

    const manifest = readManifest(current.root);
    registerOptionalDependencies(current.name, manifest);
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (exemptions.has(dependency)) {
        usedExemptions.add(dependency);
        continue;
      }

      if (!packaged.names.has(dependency)) {
        missingEdges.add(`${dependency} (dependency of ${current.name})`);
      }

      const dependencyRoot = environment.resolvePackage(dependency, current.root);
      if (dependencyRoot) {
        queue.push({ name: dependency, root: dependencyRoot });
      } else {
        recordUnresolvedManifest(dependency, `dependency of ${current.name}`);
      }
    }
  }

  const zombieExemptions = [...exemptions.keys()]
    .filter((dependency) => !usedExemptions.has(dependency))
    .sort();
  const failures: string[] = [];

  if (missingEdges.size > 0) {
    failures.push(
      `Missing packaged runtime dependencies:\n${[...missingEdges].sort().map((edge) => `- ${edge}`).join('\n')}`,
    );
  }
  if (missingManifests.size > 0) {
    failures.push(
      `Unreadable installed dependency manifests:\n${[...missingManifests].sort().map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  if (zombieExemptions.length > 0) {
    failures.push(
      `Stale dependency exemptions with no reachable packaged package reference:\n${zombieExemptions.map((dependency) => `- ${dependency}: ${exemptions.get(dependency)}`).join('\n')}`,
    );
  }

  if (failures.length > 0) {
    throw new Error(`Tauri resources npm dependency closure failed.\n\n${failures.join('\n\n')}`);
  }

  const skippedEntries = [...skipped].sort();
  if (skippedEntries.length > 0) {
    console.log(
      `Skipped unavailable optional dependencies:\n${skippedEntries.map((entry) => `- ${entry}`).join('\n')}`,
    );
  }
  return { skipped: skippedEntries };
}

describe('Tauri resources npm dependency closure', () => {
  it('fails loud when the resources parser finds no node_modules packages', () => {
    expect(() => assertResourcesDependencyClosure({}, new Map())).toThrowError(
      /parsed 0 node_modules packages/,
    );
  });

  it('rejects stale dependency exemptions', () => {
    const exemptionsWithZombie = new Map(dependencyExemptions);
    exemptionsWithZombie.set('unused-installer', '测试僵尸豁免');

    expect(() => assertResourcesDependencyClosure(readTauriResources(), exemptionsWithZombie)).toThrowError(
      /Stale dependency exemptions[\s\S]*unused-installer: 测试僵尸豁免/,
    );
  });

  it('skips a packaged optional dependency that is unavailable on the current platform', () => {
    const parentRoot = '/synthetic/node_modules/example-parent';
    const result = assertResourcesDependencyClosure(
      {
        '../node_modules/example-parent': 'node_modules/example-parent',
        '../node_modules/@platform/missing': 'node_modules/@platform/missing',
      },
      new Map(),
      {
        resolvePackage: (packageName) => (
          packageName === 'example-parent' ? parentRoot : null
        ),
        readManifest: (packageRoot) => {
          if (packageRoot !== parentRoot) throw new Error(`Unexpected package root: ${packageRoot}`);
          return { optionalDependencies: { '@platform/missing': '1.0.0' } };
        },
      },
    );

    expect(result.skipped).toEqual([
      '@platform/missing (optional dependency of example-parent; not installed on this machine/platform)',
    ]);
  });

  it('packages the complete transitive runtime dependency closure', () => {
    assertResourcesDependencyClosure(readTauriResources());
  });
});
