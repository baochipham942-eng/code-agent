import { execFile } from 'node:child_process';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const execFileAsync = promisify(execFile);

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

function inferDarwinArch(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('aarch64') || lower.includes('arm64')) return 'aarch64';
  if (lower.includes('x86_64') || lower.includes('x64')) return 'x86_64';
  return process.arch === 'arm64' ? 'aarch64' : 'x86_64';
}

async function loadReleaseNotes(version) {
  const explicitNotesPath = readArg('--notes') || process.env.UPDATE_RELEASE_NOTES_PATH;
  const notesPath = explicitNotesPath
    ? path.resolve(rootDir, explicitNotesPath)
    : path.join(rootDir, 'docs', 'releases', `v${version}.md`);

  if (await exists(notesPath)) {
    return (await readFile(notesPath, 'utf8')).trim();
  }

  try {
    const { stdout: previousTag } = await execFileAsync(
      'git',
      ['describe', '--tags', '--abbrev=0', 'HEAD^'],
      { cwd: rootDir },
    );
    const range = `${previousTag.trim()}..HEAD`;
    const { stdout } = await execFileAsync(
      'git',
      ['log', '--pretty=format:- %s', range],
      { cwd: rootDir },
    );
    const notes = stdout.trim();
    if (notes) return notes;
  } catch {
    // A first release or a source archive without git metadata falls back below.
  }

  return `Code Agent v${version}`;
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
const archiveFiles = (await walk(bundleDir))
  .filter((filePath) => filePath.endsWith('.app.tar.gz'))
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
  const arch = inferDarwinArch(fileName);
  const entry = {
    url: `${baseUrl}/${encodeFileName(fileName)}`,
    signature: (await readFile(signaturePath, 'utf8')).trim(),
  };

  platforms[`darwin-${arch}`] = entry;
  platforms[`darwin-${arch}-app`] = entry;
}

const outputPath = path.resolve(
  rootDir,
  readArg('--output') || process.env.UPDATE_MANIFEST_OUTPUT || path.join('src-tauri', 'target', 'release', 'bundle', 'latest.json'),
);

const manifest = {
  version,
  notes: await loadReleaseNotes(version),
  pub_date: new Date().toISOString(),
  platforms,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(manifest, null, 2)}\n`);

console.log(`Wrote updater manifest: ${outputPath}`);
