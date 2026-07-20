import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const tauriConfigPath = join(repoRoot, 'src-tauri/tauri.conf.json');
const tauriConfigDir = dirname(tauriConfigPath);

type TauriResources = string[] | Record<string, string | null>;

type PackageLocation = {
  name: string;
  relativeRoot: string;
};

type PackageManifest = {
  dependencies?: Record<string, string>;
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
    const packageEnd = index + (scoped ? 3 : 2);
    locations.push({
      name,
      relativeRoot: segments.slice(0, packageEnd).join('/'),
    });
  }

  return locations;
}

function collectPackagedPackages(resources: TauriResources): {
  names: Set<string>;
  roots: Map<string, string>;
} {
  const names = new Set<string>();
  const roots = new Map<string, string>();

  for (const [source, target] of resourceEntries(resources)) {
    for (const location of findPackageLocations(target)) names.add(location.name);
    for (const location of findPackageLocations(source)) {
      names.add(location.name);
      const packageRoot = resolve(tauriConfigDir, location.relativeRoot);
      if (!roots.has(location.name) && existsSync(join(packageRoot, 'package.json'))) {
        roots.set(location.name, packageRoot);
      }
    }
  }

  return { names, roots };
}

function resolveInstalledDependency(parentRoot: string, dependency: string): string | null {
  let searchRoot = parentRoot;

  while (searchRoot.startsWith(repoRoot)) {
    const candidate = join(searchRoot, 'node_modules', dependency);
    if (existsSync(join(candidate, 'package.json'))) return candidate;
    if (searchRoot === repoRoot) break;
    searchRoot = dirname(searchRoot);
  }

  return null;
}

function assertResourcesDependencyClosure(
  resources: TauriResources,
  exemptions = dependencyExemptions,
): void {
  const packaged = collectPackagedPackages(resources);
  if (packaged.names.size === 0) {
    throw new Error(
      'Tauri resources dependency gate parsed 0 node_modules packages; the resources anchor or parser is broken.',
    );
  }

  const missingEdges = new Set<string>();
  const missingManifests = new Set<string>();
  const usedExemptions = new Set<string>();
  const visitedRoots = new Set<string>();
  const queue = [...packaged.names]
    .sort()
    .flatMap((name) => {
      const root = packaged.roots.get(name);
      if (root) return [{ name, root }];
      missingManifests.add(`${name} (packaged resource has no readable package.json)`);
      return [];
    });

  for (let index = 0; index < queue.length; index += 1) {
    const current = queue[index];
    const manifestPath = join(current.root, 'package.json');
    if (visitedRoots.has(manifestPath)) continue;
    visitedRoots.add(manifestPath);

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as PackageManifest;
    for (const dependency of Object.keys(manifest.dependencies ?? {}).sort()) {
      if (exemptions.has(dependency)) {
        usedExemptions.add(dependency);
        continue;
      }

      if (!packaged.names.has(dependency)) {
        missingEdges.add(`${dependency} (dependency of ${current.name})`);
      }

      const dependencyRoot = resolveInstalledDependency(current.root, dependency);
      if (dependencyRoot) {
        queue.push({ name: dependency, root: dependencyRoot });
      } else {
        missingManifests.add(`${dependency} (dependency of ${current.name})`);
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

  it('packages the complete transitive runtime dependency closure', () => {
    assertResourcesDependencyClosure(readTauriResources());
  });
});
