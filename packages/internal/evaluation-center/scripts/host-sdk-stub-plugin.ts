import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'esbuild';
import ts from 'typescript';

const EXTENSION = /\.(?:[cm]?[jt]sx?|json)$/u;

export interface HostSdkStubPluginOptions {
  repositoryRoot: string;
  hostSdkSource?: string;
}

export function readInternalHostSdkSpecifiers(sourcePath: string): Set<string> {
  const source = fs.readFileSync(sourcePath, 'utf8');
  const specifiers = new Set<string>();
  for (const match of source.matchAll(/^\s*'(@host\/[^']+)'\s*:/gmu)) {
    specifiers.add(match[1]);
  }
  if (specifiers.size === 0) {
    throw new Error(`无法从宿主 SDK 表读取模块键：${sourcePath}`);
  }
  return specifiers;
}

export function normalizeHostModuleSpecifier(
  specifier: string,
  resolveDir: string,
  hostRoot: string,
): string | null {
  if (specifier.startsWith('@host/')) return specifier.replace(EXTENSION, '');
  if (!specifier.startsWith('.')) return null;
  const absolute = path.resolve(resolveDir, specifier).replace(EXTENSION, '');
  const relative = path.relative(hostRoot, absolute);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
  return `@host/${relative.split(path.sep).join('/')}`;
}

function resolveSourceFile(basePath: string): string {
  const candidates = [
    basePath,
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}.js`,
    `${basePath}.cjs`,
    `${basePath}.mjs`,
    path.join(basePath, 'index.ts'),
    path.join(basePath, 'index.tsx'),
    path.join(basePath, 'index.js'),
  ];
  const resolved = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!resolved) throw new Error(`找不到要打进插件的源码模块：${basePath}`);
  return resolved;
}

function readSdkRuntimeExports(hostRoot: string, specifiers: ReadonlySet<string>): Map<string, string[]> {
  const sourceBySpecifier = new Map(
    [...specifiers].map((specifier) => [
      specifier,
      resolveSourceFile(path.join(hostRoot, specifier.slice('@host/'.length))),
    ]),
  );
  const program = ts.createProgram([...sourceBySpecifier.values()], {
    allowJs: true,
    baseUrl: path.dirname(hostRoot),
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    paths: {
      '@host/*': ['host/*'],
      '@shared/*': ['shared/*'],
    },
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  });
  const checker = program.getTypeChecker();
  const result = new Map<string, string[]>();
  for (const [specifier, sourcePath] of sourceBySpecifier) {
    const sourceFile = program.getSourceFile(sourcePath);
    const moduleSymbol = sourceFile && checker.getSymbolAtLocation(sourceFile);
    if (!moduleSymbol) throw new Error(`无法读取宿主 SDK 模块导出：${specifier}`);
    const names = checker.getExportsOfModule(moduleSymbol).flatMap((symbol) => {
      const resolved = symbol.flags & ts.SymbolFlags.Alias ? checker.getAliasedSymbol(symbol) : symbol;
      return resolved.flags & ts.SymbolFlags.Value ? [symbol.name] : [];
    });
    result.set(specifier, [...new Set(names)].sort());
  }
  return result;
}

export function hostSdkStubPlugin(options: HostSdkStubPluginOptions): Plugin {
  const hostRoot = path.join(options.repositoryRoot, 'src/host');
  const sharedRoot = path.join(options.repositoryRoot, 'src/shared');
  const sdkSource = options.hostSdkSource
    ?? path.join(hostRoot, 'internalFeatures/internalHostSdk.ts');
  const sdkSpecifiers = readInternalHostSdkSpecifiers(sdkSource);
  let sdkRuntimeExports: Map<string, string[]> | undefined;

  function getSdkRuntimeExports(): Map<string, string[]> {
    // A rejected, unexposed import never needs the SDK export table. Keep the
    // full TypeScript Program off that boundary path; under coverage it was
    // consuming almost the entire 30s test budget before esbuild even started.
    sdkRuntimeExports ??= readSdkRuntimeExports(hostRoot, sdkSpecifiers);
    return sdkRuntimeExports;
  }

  function canonicalSdkName(name: string): string {
    if (sdkSpecifiers.has(name)) return name;
    if (name.endsWith('/index') && sdkSpecifiers.has(name.slice(0, -'/index'.length))) {
      return name.slice(0, -'/index'.length);
    }
    return name;
  }

  return {
    name: 'neo-internal-host-sdk-stubs',
    setup(build) {
      build.onResolve({ filter: /.*/ }, (args) => {
        const normalized = normalizeHostModuleSpecifier(args.path, args.resolveDir, hostRoot);
        if (normalized) {
          const name = canonicalSdkName(normalized);
          if (sdkSpecifiers.has(name)) return { path: name, namespace: 'neo-host-sdk' };
          const inheritedTestingTree = Boolean(
            (args.pluginData as { bundleTestingTree?: boolean } | undefined)?.bundleTestingTree,
          );
          if (inheritedTestingTree) {
            const basePath = args.path.startsWith('@host/')
              ? path.join(hostRoot, args.path.slice('@host/'.length))
              : path.resolve(args.resolveDir, args.path);
            return {
              path: resolveSourceFile(basePath),
              namespace: 'neo-bundled-host',
              pluginData: { bundleTestingTree: true },
            };
          }
          if (name.startsWith('@host/testing/')) {
            return {
              path: resolveSourceFile(path.join(hostRoot, name.slice('@host/'.length))),
              namespace: 'neo-bundled-host',
              pluginData: { bundleTestingTree: true },
            };
          }
          return {
            errors: [{ text: `插件引用了未暴露的宿主模块 ${name}，加进宿主 SDK 表或改由插件自带` }],
          };
        }
        if (args.path.startsWith('@shared/')) {
          return { path: resolveSourceFile(path.join(sharedRoot, args.path.slice('@shared/'.length))) };
        }
        return null;
      });

      build.onLoad({ filter: /.*/, namespace: 'neo-host-sdk' }, (args) => ({
        loader: 'js',
        contents: `const exportKeys = ${JSON.stringify(getSdkRuntimeExports().get(args.path) ?? [])};
module.exports = new Proxy({}, {
  ownKeys: () => exportKeys,
  getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
  get: (_, key) => {
  if (key === '__esModule') return false;
  const sdk = globalThis.__NEO_INTERNAL_HOST_SDK__;
  if (!sdk) throw new Error(${JSON.stringify(`宿主 SDK 未注入：${args.path}`)});
  const moduleValue = sdk.modules[${JSON.stringify(args.path)}];
  if (!moduleValue) throw new Error(${JSON.stringify(`宿主 SDK 没有 ${args.path}`)});
  return moduleValue[key];
} });`,
      }));

      build.onLoad({ filter: /.*/, namespace: 'neo-bundled-host' }, (args) => ({
        contents: fs.readFileSync(args.path, 'utf8'),
        loader: args.path.endsWith('.tsx') ? 'tsx' : args.path.endsWith('.ts') ? 'ts' : 'js',
        resolveDir: path.dirname(args.path),
        pluginData: { bundleTestingTree: true },
      }));
    },
  };
}
