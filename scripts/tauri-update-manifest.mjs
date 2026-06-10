import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadReleaseNotes } from './lib/release-notes.mjs';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function encodeFileName(fileName) {
  return fileName
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walk(filePath));
    } else {
      files.push(filePath);
    }
  }
  return files;
}

function inferPlatformArch(fileName) {
  const lower = fileName.toLowerCase();
  // NSIS setup.exe → windows；.app.tar.gz → darwin
  const platform = lower.endsWith('.exe') ? 'windows' : 'darwin';
  if (lower.includes('aarch64') || lower.includes('arm64')) return { platform, arch: 'aarch64' };
  if (lower.includes('x86_64') || lower.includes('x64')) return { platform, arch: 'x86_64' };
  if (platform === 'windows') return { platform, arch: 'x86_64' }; // win 仅发 x64
  return { platform, arch: process.arch === 'arm64' ? 'aarch64' : 'x86_64' };
}

const packageJson = JSON.parse(await readFile(path.join(rootDir, 'package.json'), 'utf8'));
const version = readArg('--version') || process.env.VERSION || packageJson.version;
const baseUrl = (
  readArg('--base-url') ||
  process.env.UPDATE_ARTIFACT_BASE_URL ||
  process.env.ARTIFACT_BASE_URL ||
  ''
).replace(/\/$/, '');

if (!baseUrl) {
  throw new Error('Missing --base-url or UPDATE_ARTIFACT_BASE_URL for updater manifest URLs');
}

const bundleDir = path.join(rootDir, 'src-tauri', 'target', 'release', 'bundle');
// darwin updater 产物是 .app.tar.gz；windows 是 NSIS setup.exe 本体（minisign .sig 同侧）
const archiveFiles = (await walk(bundleDir))
  .filter((filePath) => filePath.endsWith('.app.tar.gz')
    || (filePath.includes(`${path.sep}nsis${path.sep}`) && filePath.endsWith('.exe')))
  .sort();

if (archiveFiles.length === 0) {
  throw new Error(`No Tauri updater archive found under ${bundleDir}`);
}

const platforms = {};
for (const archivePath of archiveFiles) {
  const signaturePath = `${archivePath}.sig`;
  if (!await exists(signaturePath)) {
    throw new Error(`Missing updater signature beside ${archivePath}`);
  }

  const fileName = path.basename(archivePath);
  const { platform, arch } = inferPlatformArch(fileName);
  const entry = {
    url: `${baseUrl}/${encodeFileName(fileName)}`,
    signature: (await readFile(signaturePath, 'utf8')).trim(),
  };

  platforms[`${platform}-${arch}`] = entry;
  if (platform === 'darwin') {
    platforms[`darwin-${arch}-app`] = entry; // 老客户端兼容键
  }
}

const outputPath = path.resolve(
  rootDir,
  readArg('--output') || process.env.UPDATE_MANIFEST_OUTPUT || path.join('src-tauri', 'target', 'release', 'bundle', 'latest.json'),
);

const manifest = {
  version,
  notes: await loadReleaseNotes(rootDir, version, readArg('--notes') || process.env.UPDATE_RELEASE_NOTES_PATH),
  pub_date: new Date().toISOString(),
  platforms,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote updater manifest: ${outputPath}`);
