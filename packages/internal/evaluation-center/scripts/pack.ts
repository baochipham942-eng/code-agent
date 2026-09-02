import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import JSZip from 'jszip';
import { buildPlugin } from './build';

const packageRoot = path.resolve(import.meta.dirname, '..');
const MAX_PACKAGE_BYTES = 50 * 1024 * 1024;

async function addTree(zip: JSZip, absoluteDir: string, zipDir: string): Promise<void> {
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const absolute = path.join(absoluteDir, entry.name);
    const relative = path.posix.join(zipDir, entry.name);
    if (entry.isDirectory()) await addTree(zip, absolute, relative);
    else if (entry.isFile()) zip.file(relative, await fs.readFile(absolute));
  }
}

export async function packPlugin(): Promise<string> {
  await buildPlugin();
  const manifestPath = path.join(packageRoot, 'dist', 'plugin.json');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8')) as { version?: unknown };
  if (typeof manifest.version !== 'string') throw new Error('plugin.json 缺少构建版本号');
  const zip = new JSZip();
  zip.file('plugin.json', await fs.readFile(manifestPath));
  zip.file('index.cjs', await fs.readFile(path.join(packageRoot, 'index.cjs')));
  await addTree(zip, path.join(packageRoot, 'dist/renderer'), 'dist/renderer');
  await addTree(zip, path.join(packageRoot, 'dist/host'), 'dist/host');
  const archive = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  if (archive.byteLength > MAX_PACKAGE_BYTES) {
    throw new Error(`插件压缩包超过 50MB：${archive.byteLength} bytes`);
  }
  const outputPath = path.join(packageRoot, 'dist', `evaluation-center-${manifest.version}.zip`);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, archive);
  process.stdout.write(`[evaluation-center] packed ${outputPath} (${archive.byteLength} bytes)\n`);
  return outputPath;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void packPlugin().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
