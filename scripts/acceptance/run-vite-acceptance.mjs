#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const [, , target, ...targetArgs] = process.argv;

if (!target) {
  console.error('Usage: node scripts/acceptance/run-vite-acceptance.mjs <script.ts|script.tsx> [args...]');
  process.exit(1);
}

const root = process.cwd();
const targetPath = path.resolve(root, target);
const originalArgv = process.argv;

const server = await createServer({
  appType: 'custom',
  configFile: false,
  logLevel: 'error',
  root,
  server: {
    hmr: {
      port: 30_000 + (process.pid % 10_000),
    },
    middlewareMode: true,
  },
  resolve: {
    alias: {
      '@': path.resolve(root, 'src'),
      '@main': path.resolve(root, 'src/main'),
      '@renderer': path.resolve(root, 'src/renderer'),
      '@shared': path.resolve(root, 'src/shared'),
      electron: path.resolve(root, 'src/host/platform/index.ts'),
      keytar: path.resolve(root, 'tests/__mocks__/keytar.ts'),
    },
  },
});

try {
  const mod = await server.ssrLoadModule(`/@fs/${targetPath}`);
  if (typeof mod.main !== 'function') {
    throw new Error(`${target} must export async function main()`);
  }
  process.argv = [
    originalArgv[0] ?? process.execPath,
    targetPath,
    ...targetArgs,
  ];
  await mod.main();
} catch (error) {
  const message = error instanceof Error && error.stack ? error.stack : String(error);
  console.error(message);
  process.exitCode = 1;
} finally {
  process.argv = originalArgv;
  await server.close();
}
