/**
 * Unified esbuild configuration for all Node.js bundles.
 *
 * Usage:
 *   npx tsx esbuild.config.ts [target...]
 *
 * Targets: cli, web, mcp, bridge, test-runner, all (default)
 * Options: --dev (sourcemap, no minify)
 *
 * Examples:
 *   npx tsx esbuild.config.ts              # build all
 *   npx tsx esbuild.config.ts cli web      # build cli + web only
 *   npx tsx esbuild.config.ts cli --dev    # dev build with sourcemap
 */

import * as esbuild from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { mkdirSync } from 'fs';
import { homedir } from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Shared externals — native modules and large platform-specific deps
// ---------------------------------------------------------------------------
const NATIVE_EXTERNALS = [
  'better-sqlite3',
  'keytar',
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'sharp',
  'node-pty',
  '@ui-tars/sdk',
  'onnxruntime-node',
];

// Electron alias 仅作为安全网：src/host/ 已全部迁移到 platform 模块，
// 但第三方库可能仍 require('electron')（如 electron-store）。
// TODO: 验证无第三方库需要后删除此 alias 和 electronMock.ts
const ELECTRON_ALIAS = { electron: './src/web/electronMock.ts' };

// pdfkit/pptxgenjs 不再 external（曾因未打进 app 资源导致打包后 require 崩溃，
// v0.19.0 设计模式 PDF/PPTX 导出在启动期 import 触发"Web server exited ... exit status 1"）。
// pdfkit 默认入口在运行时 fs 读 .afm 字体文件，打包后路径失效；改走 standalone 构建
// （字体已内联 base64），可被 esbuild 安全打包进 bundle。pptxgenjs 为纯 JS，直接打包即可。
const BUILD_ALIAS = { ...ELECTRON_ALIAS, pdfkit: 'pdfkit/js/pdfkit.standalone.js' };

function normalizePemLiteral(value: string): string {
  return value.trim().replace(/\\n/g, '\n');
}

const CONTROL_PLANE_PUBLIC_KEY_ENV_NAMES = new Set([
  'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS',
  'CODE_AGENT_CONTROL_PLANE_KEY_ID',
  'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY',
  'CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE',
]);
const BUNDLED_CONTROL_PLANE_PUBLIC_KEYS_FILE = path.join(
  process.cwd(),
  'config',
  'control-plane-public-keys.json',
);

function cleanEnvValue(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readPublicKeyEnvFiles(): Record<string, string> {
  const env: Record<string, string> = {};
  const candidates = [
    path.join(process.cwd(), '.env'),
    path.join(homedir(), '.code-agent', '.env'),
  ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    const lines = readFileSync(candidate, 'utf8').split(/\r?\n/);
    for (const line of lines) {
      const normalized = line.trim().replace(/^export\s+/, '');
      if (!normalized || normalized.startsWith('#')) continue;
      const eq = normalized.indexOf('=');
      if (eq <= 0) continue;
      const name = normalized.slice(0, eq).trim();
      if (!CONTROL_PLANE_PUBLIC_KEY_ENV_NAMES.has(name)) continue;
      env[name] = cleanEnvValue(normalized.slice(eq + 1));
    }
  }
  return env;
}

function getPublicKeyEnv(name: string, envFileValues: Record<string, string>): string | undefined {
  return process.env[name] ?? envFileValues[name];
}

function readPublicKeysFile(filePath: string): Record<string, string> {
  const parsed = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, unknown>;
  const keysSource = parsed.keys && typeof parsed.keys === 'object' && !Array.isArray(parsed.keys)
    ? parsed.keys as Record<string, unknown>
    : parsed;
  return Object.fromEntries(
    Object.entries(keysSource)
      .filter((entry): entry is [string, string] => (
        typeof entry[0] === 'string'
        && typeof entry[1] === 'string'
        && entry[1].trim().length > 0
      ))
      .map(([fileKeyId, filePublicKey]) => [fileKeyId, normalizePemLiteral(filePublicKey)]),
  );
}

function readControlPlanePublicKeysFromEnv(): Record<string, string> {
  const envFileValues = readPublicKeyEnvFiles();
  // Production verification keys are public distribution material. Keep the
  // compatibility set in source so a stale CI secret cannot silently remove a
  // key from the packaged app; env/file inputs may add or deliberately replace
  // entries for non-production channels.
  const publicKeys: Record<string, string> = existsSync(BUNDLED_CONTROL_PLANE_PUBLIC_KEYS_FILE)
    ? readPublicKeysFile(BUNDLED_CONTROL_PLANE_PUBLIC_KEYS_FILE)
    : {};

  const filePath = getPublicKeyEnv('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS_FILE', envFileValues);
  if (filePath) {
    Object.assign(publicKeys, readPublicKeysFile(filePath));
  }

  const rawJson = getPublicKeyEnv('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS', envFileValues);
  if (rawJson) {
    try {
      const parsed = JSON.parse(rawJson) as Record<string, unknown>;
      Object.assign(
        publicKeys,
        Object.fromEntries(Object.entries(parsed)
          .filter((entry): entry is [string, string] => (
            typeof entry[0] === 'string'
            && typeof entry[1] === 'string'
            && entry[1].trim().length > 0
          ))
          .map(([keyId, publicKey]) => [keyId, normalizePemLiteral(publicKey)])),
      );
    } catch {
      throw new Error('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEYS must be valid JSON when set');
    }
  }

  const keyId = getPublicKeyEnv('CODE_AGENT_CONTROL_PLANE_KEY_ID', envFileValues);
  const publicKey = getPublicKeyEnv('CODE_AGENT_CONTROL_PLANE_PUBLIC_KEY', envFileValues);
  if (keyId && publicKey) {
    publicKeys[keyId] = normalizePemLiteral(publicKey);
  }

  return publicKeys;
}

function writeControlPlanePublicKeysFile(): void {
  mkdirSync('dist/web', { recursive: true });
  const keys = readControlPlanePublicKeysFromEnv();
  writeFileSync(
    'dist/web/control-plane-public-keys.json',
    JSON.stringify({
      schemaVersion: 1,
      keys,
    }, null, 2) + '\n',
  );
  console.log(`  ✓ Control plane public keys → dist/web/control-plane-public-keys.json (${Object.keys(keys).length} key(s))`);
}

function writeWebServerArtifacts(): void {
  copyFileSync('src/web/webServerBootstrap.cjs', 'dist/web/webServer.cjs');
  writeControlPlanePublicKeysFile();
}

function runGameSkillContentCodegen(): void {
  execFileSync(process.execPath, ['scripts/generate-game-skill-content.mjs'], {
    cwd: process.cwd(),
    stdio: 'inherit',
  });
}

// ---------------------------------------------------------------------------
// Build targets
// ---------------------------------------------------------------------------
interface BuildTarget {
  name: string;
  entry: string;
  outfile: string;
  format: 'cjs' | 'esm';
  external?: string[];
  alias?: Record<string, string>;
  minify?: boolean;
  sourcemap?: boolean;
  /** 注入到 bundle 最顶部的 JS 代码，先于一切 require 执行 */
  banner?: string;
  postBuild?: () => void;
}

function defineTargets(isDev: boolean): Record<string, BuildTarget> {
  return {
    cli: {
      name: 'CLI',
      entry: 'src/cli/index.ts',
      outfile: 'dist/cli/index.cjs',
      format: 'cjs',
      external: NATIVE_EXTERNALS,
      alias: BUILD_ALIAS,
      minify: !isDev,
      sourcemap: isDev,
      // 必须在任何 require 之前设置 CLI 模式，让 secureStorage.ts 跳过 keytar
      // require（keytar 为 electron headers 编译，系统 Node 加载会 SIGSEGV）。
      // cli/index.ts 源码的 process.env 赋值在 import 后才执行（import hoisting），
      // 所以必须走 esbuild banner 注入。
      banner: 'process.env.CODE_AGENT_CLI_MODE="true";process.env.DOTENV_CONFIG_QUIET="true";',
      postBuild() {
        // Inject shebang for npm bin
        const content = readFileSync('dist/cli/index.cjs', 'utf-8');
        if (!content.startsWith('#!')) {
          writeFileSync('dist/cli/index.cjs', '#!/usr/bin/env node\n' + content);
        }
      },
    },
    web: {
      name: 'Web Server',
      entry: 'src/web/webServer.ts',
      outfile: 'dist/web/webServer.bundle.cjs',
      format: 'cjs',
      external: NATIVE_EXTERNALS,
      alias: BUILD_ALIAS,
      minify: !isDev,
      sourcemap: isDev,
      postBuild: writeWebServerArtifacts,
    },
    mcp: {
      name: 'MCP Server',
      entry: 'src/host/mcp/mcp-server-entry.ts',
      outfile: 'dist/mcp-server.js',
      format: 'esm',
      external: ['@modelcontextprotocol/sdk', ...NATIVE_EXTERNALS],
      banner: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
    },
    bridge: {
      name: 'Bridge',
      entry: 'packages/bridge/src/index.ts',
      outfile: 'dist/bridge/code-agent-bridge.cjs',
      format: 'cjs',
      external: NATIVE_EXTERNALS,
      minify: !isDev,
    },
    'test-runner': {
      name: 'Test Runner',
      entry: 'scripts/real-test-entry.ts',
      outfile: 'dist/test-runner.cjs',
      format: 'cjs',
      external: NATIVE_EXTERNALS,
      alias: BUILD_ALIAS,
    },
  };
}

// ---------------------------------------------------------------------------
// Build executor
// ---------------------------------------------------------------------------
const BUILD_TIMEOUT_MS = 60_000;

async function build(target: BuildTarget): Promise<void> {
  const start = Date.now();

  // Ensure output directory exists
  const outDir = target.outfile.substring(0, target.outfile.lastIndexOf('/'));
  mkdirSync(outDir, { recursive: true });

  await esbuild.build({
    entryPoints: [target.entry],
    outfile: target.outfile,
    bundle: true,
    platform: 'node',
    format: target.format,
    external: target.external,
    alias: target.alias,
    minify: target.minify,
    sourcemap: target.sourcemap,
    banner: target.banner ? { js: target.banner } : undefined,
    logLevel: 'error',
  });

  if (!target.sourcemap) {
    const mapPath = `${target.outfile}.map`;
    if (existsSync(mapPath)) {
      unlinkSync(mapPath);
    }
  }

  target.postBuild?.();

  const elapsed = Date.now() - start;
  if (elapsed > BUILD_TIMEOUT_MS) {
    console.warn(`  ⚠ ${target.name} took ${elapsed}ms (>${BUILD_TIMEOUT_MS}ms)`);
  }
  console.log(`  ✓ ${target.name} → ${target.outfile} (${elapsed}ms)`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const args = process.argv.slice(2);
  const isDev = args.includes('--dev');
  const targetNames = args.filter((a) => !a.startsWith('--'));

  const targets = defineTargets(isDev);
  const selected = targetNames.length > 0
    ? targetNames.filter((n) => n in targets)
    : Object.keys(targets);

  if (selected.length === 0) {
    console.error('Unknown targets:', targetNames.join(', '));
    console.error('Available:', Object.keys(targets).join(', '));
    process.exit(1);
  }

  console.log(`Building ${selected.length} target(s)${isDev ? ' (dev)' : ''}...`);
  runGameSkillContentCodegen();

  // Build all targets in parallel — allSettled ensures one failure doesn't block others
  const results = await Promise.allSettled(selected.map((name) => build(targets[name])));
  const failures = results
    .map((r, i) => (r.status === 'rejected' ? { name: selected[i], reason: r.reason } : null))
    .filter(Boolean) as { name: string; reason: unknown }[];

  if (failures.length > 0) {
    console.error(`\n${failures.length} target(s) failed:`);
    for (const f of failures) {
      console.error(`  ✗ ${f.name}: ${f.reason instanceof Error ? f.reason.message : f.reason}`);
    }
    process.exit(1);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
