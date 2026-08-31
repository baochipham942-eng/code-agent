import path from 'node:path';
import { pathToFileURL } from 'node:url';
import * as esbuild from 'esbuild';
import { hostSdkStubPlugin } from './scripts/host-sdk-stub-plugin';

const packageRoot = import.meta.dirname;
const repositoryRoot = path.resolve(packageRoot, '../../..');

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

export async function buildHostBundle(): Promise<void> {
  await esbuild.build({
    absWorkingDir: packageRoot,
    entryPoints: ['src/host/entry.ts'],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: 'dist/host/index.cjs',
    define: { 'import.meta.url': 'undefined' },
    external: NATIVE_EXTERNALS,
    plugins: [hostSdkStubPlugin({ repositoryRoot })],
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void buildHostBundle().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
