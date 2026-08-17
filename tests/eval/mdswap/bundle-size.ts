import { build } from 'esbuild';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const probes = ['neo', 'streamdown-core', 'streamdown-full'] as const;
const report: Record<string, unknown> = {};
for (const probe of probes) {
  const result = await build({
    entryPoints: [path.join(here, `bundle-entry-${probe}.tsx`)],
    bundle: true,
    write: false,
    metafile: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    minify: true,
    target: 'es2022',
    alias: {
      '@': path.resolve(here, '../../../src'),
      '@renderer': path.resolve(here, '../../../src/renderer'),
      '@shared': path.resolve(here, '../../../src/shared'),
    },
    outdir: 'out',
    loader: { '.node': 'file', '.woff': 'file', '.woff2': 'file', '.ttf': 'file' },
    external: ['electron', 'node:*'],
  });
  const js = result.outputFiles.filter((file) => file.path.endsWith('.js'));
  const bytes = js.reduce((sum, file) => sum + file.contents.byteLength, 0);
  const gzipBytes = js.reduce((sum, file) => sum + gzipSync(file.contents).byteLength, 0);
  report[probe] = { bytes, gzipBytes, jsChunks: js.length };
}
await fs.mkdir(path.join(here, 'artifacts'), { recursive: true });
await fs.writeFile(path.join(here, 'artifacts/bundle-size.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(report);
