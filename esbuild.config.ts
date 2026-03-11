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
import { writeFileSync, readFileSync } from 'fs';
import { mkdirSync } from 'fs';

// ---------------------------------------------------------------------------
// Shared externals — native modules and large platform-specific deps
// ---------------------------------------------------------------------------
const NATIVE_EXTERNALS = [
  'better-sqlite3',
  'keytar',
  'isolated-vm',
  'tree-sitter',
  'tree-sitter-typescript',
  'playwright',
  'playwright-core',
  'chromium-bidi',
  'pptxgenjs',
  'mammoth',
  'exceljs',
  'qrcode',
  'pdfkit',
  'sharp',
  'docx',
  'node-pty',
  '@ui-tars/sdk',
];

const ELECTRON_ALIAS = { electron: './src/web/electronMock.ts' };

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
      alias: ELECTRON_ALIAS,
      minify: !isDev,
      sourcemap: isDev,
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
      outfile: 'dist/web/webServer.cjs',
      format: 'cjs',
      external: NATIVE_EXTERNALS,
      alias: ELECTRON_ALIAS,
      sourcemap: true,
    },
    mcp: {
      name: 'MCP Server',
      entry: 'src/main/mcp/mcp-server-entry.ts',
      outfile: 'dist/mcp-server.js',
      format: 'esm',
      external: ['@modelcontextprotocol/sdk', ...NATIVE_EXTERNALS],
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
      alias: ELECTRON_ALIAS,
    },
  };
}

// ---------------------------------------------------------------------------
// Build executor
// ---------------------------------------------------------------------------
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
    logLevel: 'error',
  });

  target.postBuild?.();

  const elapsed = Date.now() - start;
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

  // Build all targets in parallel
  const results = await Promise.allSettled(selected.map((name) => build(targets[name])));
  const failed = results.filter((r) => r.status === 'rejected');

  if (failed.length > 0) {
    console.error(`\n${failed.length} target(s) failed.`);
    process.exit(1);
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
