import { execFile } from 'child_process';
import crypto from 'crypto';
import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { promisify } from 'util';
import { getUserDataPath } from '../platform/appPaths';

const execFileAsync = promisify(execFile);

export const RUNTIME_ASSETS_ACTIVE_KIND = 'agent_neo_runtime_assets_active';
export const RUNTIME_ASSETS_MANIFEST_KIND = 'agent_neo_runtime_assets';

export interface RuntimeAssetManifestEntry {
  id: string;
  description?: string;
  platform?: string;
  groups?: string[];
  nodeModules?: string[];
  archiveFile: string;
  archiveBytes?: number;
  archiveSha256: string | null;
  expandedBytes?: number;
  expandedSha256: string;
  fileCount?: number;
  compatibility?: {
    minAppVersion?: string | null;
    maxAppVersion?: string | null;
  };
  install?: {
    root?: string;
  };
}

export interface RuntimeAssetsManifest {
  schemaVersion: number;
  kind: typeof RUNTIME_ASSETS_MANIFEST_KIND;
  generatedAt?: string;
  appVersion?: string;
  platform?: string;
  assets: RuntimeAssetManifestEntry[];
}

export interface RuntimeAssetInstallRecord {
  assetId: string;
  root: string;
  expandedSha256: string;
  archiveSha256: string;
  archiveFile: string;
  appVersion?: string;
  platform?: string;
  groups: string[];
  nodeModules: string[];
  installedAt: string;
}

export interface RuntimeAssetsActiveState {
  schemaVersion: 1;
  kind: typeof RUNTIME_ASSETS_ACTIVE_KIND;
  updatedAt: string;
  assets: Record<string, RuntimeAssetInstallRecord>;
}

export interface RuntimeAssetInstallOptions {
  manifestPath: string;
  assetId: string;
  archivePath?: string;
  runtimeBaseDir?: string;
  keepPrevious?: number;
  now?: () => Date;
}

export interface RuntimeAssetInstallResult {
  assetId: string;
  root: string;
  activeManifestPath: string;
  expandedSha256: string;
  archiveSha256: string;
  reusedExistingInstall: boolean;
}

interface RuntimeFileEntry {
  path: string;
  relativePath: string;
  bytes: number;
}

function toPosix(value: string): string {
  return value.split(path.sep).join('/');
}

function normalizeRuntimeSha256(value: string | null | undefined, label: string): string {
  const normalized = typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value.trim())
    ? value.trim().toLowerCase()
    : undefined;
  if (!normalized) {
    throw new Error(`${label} must be a valid sha256`);
  }
  return normalized;
}

function verifyDigestMatch(
  actual: string,
  expected: string,
): { ok: true } | { ok: false; reason: string } {
  const normalizedActual = actual.toLowerCase();
  const normalizedExpected = expected.toLowerCase();
  if (normalizedActual === normalizedExpected) return { ok: true };
  return { ok: false, reason: `expected ${normalizedExpected}, got ${normalizedActual}` };
}

function sha256File(filePath: string): string {
  const hash = crypto.createHash('sha256');
  hash.update(fsSync.readFileSync(filePath));
  return hash.digest('hex');
}

export function ensureInside(baseDir: string, targetPath: string, label: string): string {
  const resolvedBase = path.resolve(baseDir);
  const resolvedTarget = path.resolve(targetPath);
  const relative = path.relative(resolvedBase, resolvedTarget);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`${label} escapes ${resolvedBase}: ${targetPath}`);
  }
  return resolvedTarget;
}

function validateInstallRoot(asset: RuntimeAssetManifestEntry): void {
  const expected = `runtime/${asset.id}/${asset.expandedSha256}`;
  if (asset.install?.root && asset.install.root !== expected) {
    throw new Error(`Runtime asset install root mismatch for ${asset.id}: expected ${expected}, got ${asset.install.root}`);
  }
}

function normalizeArchiveEntry(entryName: string): string | null {
  const trimmed = entryName.trim();
  if (!trimmed || trimmed === '.' || trimmed === './') return null;
  if (trimmed.includes('\0')) {
    throw new Error('Runtime asset archive contains an invalid NUL path');
  }
  // 反斜杠在 Windows 解压时是路径分隔符：`..\evil` 能绕过下面按 '/' 分段的
  // 遍历检查；盘符/UNC 前缀同理。自产资产无合法反斜杠文件名，直接拒。
  if (trimmed.includes('\\') || /^[A-Za-z]:/.test(trimmed)) {
    throw new Error(`Runtime asset archive contains an invalid path: ${entryName}`);
  }
  if (trimmed.startsWith('/')) {
    throw new Error(`Runtime asset archive contains an absolute path: ${entryName}`);
  }

  const withoutDot = trimmed.replace(/^\.\/+/, '');
  if (!withoutDot || withoutDot === '.') return null;
  const segments = withoutDot.split('/');
  if (segments.includes('..')) {
    throw new Error(`Runtime asset archive contains a traversal path: ${entryName}`);
  }

  const normalized = path.posix.normalize(withoutDot);
  if (normalized === '..' || normalized.startsWith('../') || path.posix.isAbsolute(normalized)) {
    throw new Error(`Runtime asset archive contains a traversal path: ${entryName}`);
  }
  return normalized;
}

export function validateRuntimeArchiveEntries(entryNames: string[], verboseListing: string[] = []): void {
  for (const entryName of entryNames) {
    normalizeArchiveEntry(entryName);
  }

  for (const line of verboseListing) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const entryType = trimmed[0];
    if (entryType === 'l' || entryType === 'h') {
      throw new Error(`Runtime asset archive contains an unsupported link entry: ${trimmed}`);
    }
    if (entryType && !['-', 'd'].includes(entryType)) {
      throw new Error(`Runtime asset archive contains an unsupported entry type: ${trimmed}`);
    }
  }
}

async function listArchive(archivePath: string): Promise<{ names: string[]; verbose: string[] }> {
  const [namesResult, verboseResult] = await Promise.all([
    execFileAsync('tar', ['-tzf', archivePath], { maxBuffer: 20 * 1024 * 1024 }),
    execFileAsync('tar', ['-tvzf', archivePath], { maxBuffer: 20 * 1024 * 1024 }),
  ]);
  return {
    names: namesResult.stdout.split('\n').filter(Boolean),
    verbose: verboseResult.stdout.split('\n').filter(Boolean),
  };
}

async function extractArchive(archivePath: string, destinationDir: string): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true });
  const listing = await listArchive(archivePath);
  validateRuntimeArchiveEntries(listing.names, listing.verbose);
  await execFileAsync('tar', ['-xzf', archivePath, '-C', destinationDir], { maxBuffer: 20 * 1024 * 1024 });
}

async function walkRuntimeFiles(rootDir: string): Promise<RuntimeFileEntry[]> {
  const files: RuntimeFileEntry[] = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop()!;
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = ensureInside(rootDir, path.join(current, entry.name), 'runtime asset file');
      const lstat = await fs.lstat(fullPath);
      if (lstat.isSymbolicLink()) {
        throw new Error(`Runtime asset contains a symlink, refusing install: ${fullPath}`);
      }
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push({
          path: fullPath,
          relativePath: toPosix(path.relative(rootDir, fullPath)),
          bytes: lstat.size,
        });
      }
    }
  }

  files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
  return files;
}

async function treeHash(rootDir: string): Promise<string> {
  const files = await walkRuntimeFiles(rootDir);
  const hash = crypto.createHash('sha256');
  for (const file of files) {
    hash.update(file.relativePath);
    hash.update('\0');
    hash.update(String(file.bytes));
    hash.update('\0');
    hash.update(sha256File(file.path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function getActiveManifestPath(runtimeBaseDir: string): string {
  return path.join(runtimeBaseDir, 'active.json');
}

async function atomicWriteText(filePath: string, content: string): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );

  try {
    await fs.writeFile(tempPath, content, 'utf8');
    await fs.rename(tempPath, filePath);
  } catch (error) {
    try {
      await fs.unlink(tempPath);
    } catch {
      // best effort cleanup
    }
    throw error;
  }
}

export function getRuntimeAssetsBaseDir(): string {
  return path.join(getUserDataPath(), 'runtime');
}

export async function readRuntimeAssetsManifest(manifestPath: string): Promise<RuntimeAssetsManifest> {
  const raw = await fs.readFile(manifestPath, 'utf8');
  const parsed = JSON.parse(raw) as RuntimeAssetsManifest;
  if (parsed.kind !== RUNTIME_ASSETS_MANIFEST_KIND || !Array.isArray(parsed.assets)) {
    throw new Error(`Invalid runtime assets manifest: ${manifestPath}`);
  }
  return parsed;
}

export async function readActiveRuntimeAssets(runtimeBaseDir = getRuntimeAssetsBaseDir()): Promise<RuntimeAssetsActiveState | null> {
  const activePath = getActiveManifestPath(runtimeBaseDir);
  try {
    const raw = await fs.readFile(activePath, 'utf8');
    const parsed = JSON.parse(raw) as RuntimeAssetsActiveState;
    if (parsed.kind !== RUNTIME_ASSETS_ACTIVE_KIND || !parsed.assets) return null;
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function writeActiveRuntimeAsset(
  runtimeBaseDir: string,
  record: RuntimeAssetInstallRecord,
): Promise<string> {
  const current = await readActiveRuntimeAssets(runtimeBaseDir) ?? {
    schemaVersion: 1 as const,
    kind: RUNTIME_ASSETS_ACTIVE_KIND,
    updatedAt: record.installedAt,
    assets: {},
  };

  const next: RuntimeAssetsActiveState = {
    schemaVersion: 1,
    kind: RUNTIME_ASSETS_ACTIVE_KIND,
    updatedAt: record.installedAt,
    assets: {
      ...current.assets,
      [record.assetId]: record,
    },
  };

  const activePath = getActiveManifestPath(runtimeBaseDir);
  await atomicWriteText(activePath, `${JSON.stringify(next, null, 2)}\n`);
  return activePath;
}

async function cleanupPreviousAssetVersions(
  runtimeBaseDir: string,
  assetId: string,
  activeHash: string,
  keepPrevious: number,
): Promise<void> {
  if (keepPrevious < 0) return;

  const assetBaseDir = path.join(runtimeBaseDir, assetId);
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(assetBaseDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const previous = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && entry.name !== activeHash)
      .map(async (entry) => {
        const fullPath = path.join(assetBaseDir, entry.name);
        const stat = await fs.stat(fullPath);
        return { fullPath, mtimeMs: stat.mtimeMs };
      }),
  );

  previous.sort((left, right) => right.mtimeMs - left.mtimeMs);
  for (const stale of previous.slice(keepPrevious)) {
    await fs.rm(stale.fullPath, { recursive: true, force: true });
  }
}

function resolveArchivePath(manifestPath: string, manifestDir: string, asset: RuntimeAssetManifestEntry, overridePath?: string): string {
  if (overridePath) {
    return path.resolve(overridePath);
  }

  const archivePath = path.resolve(manifestDir, asset.archiveFile);
  return ensureInside(path.dirname(manifestPath), archivePath, 'runtime asset archive');
}

export async function installRuntimeAssetFromManifest(
  options: RuntimeAssetInstallOptions,
): Promise<RuntimeAssetInstallResult> {
  const manifestPath = path.resolve(options.manifestPath);
  const manifestDir = path.dirname(manifestPath);
  const manifest = await readRuntimeAssetsManifest(manifestPath);
  const asset = manifest.assets.find((entry) => entry.id === options.assetId);
  if (!asset) {
    throw new Error(`Runtime asset not found in manifest: ${options.assetId}`);
  }
  validateInstallRoot(asset);

  const runtimeBaseDir = path.resolve(options.runtimeBaseDir ?? getRuntimeAssetsBaseDir());
  const archivePath = resolveArchivePath(manifestPath, manifestDir, asset, options.archivePath);
  const expectedArchiveSha256 = normalizeRuntimeSha256(asset.archiveSha256, `${asset.id} archiveSha256`);
  const expectedExpandedSha256 = normalizeRuntimeSha256(asset.expandedSha256, `${asset.id} expandedSha256`);

  const actualArchiveSha256 = sha256File(archivePath);
  const archiveVerdict = verifyDigestMatch(actualArchiveSha256, expectedArchiveSha256);
  if (!archiveVerdict.ok) {
    throw new Error(`Runtime asset archive sha256 mismatch for ${asset.id}: ${archiveVerdict.reason}`);
  }

  const assetBaseDir = path.join(runtimeBaseDir, asset.id);
  const targetRoot = ensureInside(runtimeBaseDir, path.join(assetBaseDir, expectedExpandedSha256), 'runtime asset install target');
  const tempBaseDir = path.join(runtimeBaseDir, '.tmp');
  const tempDir = ensureInside(
    tempBaseDir,
    path.join(tempBaseDir, `${asset.id}-${process.pid}-${Date.now()}`),
    'runtime asset temp dir',
  );
  const extractDir = path.join(tempDir, 'extract');
  let reusedExistingInstall = false;

  await fs.mkdir(tempBaseDir, { recursive: true });
  await fs.rm(tempDir, { recursive: true, force: true });

  try {
    await extractArchive(archivePath, extractDir);
    const actualExpandedSha256 = await treeHash(extractDir);
    const expandedVerdict = verifyDigestMatch(actualExpandedSha256, expectedExpandedSha256);
    if (!expandedVerdict.ok) {
      throw new Error(`Runtime asset expanded sha256 mismatch for ${asset.id}: ${expandedVerdict.reason}`);
    }

    await fs.mkdir(path.dirname(targetRoot), { recursive: true });
    if (fsSync.existsSync(targetRoot)) {
      const existingHash = await treeHash(targetRoot);
      const existingVerdict = verifyDigestMatch(existingHash, expectedExpandedSha256);
      if (!existingVerdict.ok) {
        await fs.rm(targetRoot, { recursive: true, force: true });
        await fs.rename(extractDir, targetRoot);
      } else {
        reusedExistingInstall = true;
      }
    } else {
      await fs.rename(extractDir, targetRoot);
    }

    const installedAt = (options.now ?? (() => new Date()))().toISOString();
    const activeManifestPath = await writeActiveRuntimeAsset(runtimeBaseDir, {
      assetId: asset.id,
      root: targetRoot,
      expandedSha256: expectedExpandedSha256,
      archiveSha256: expectedArchiveSha256,
      archiveFile: archivePath,
      appVersion: manifest.appVersion,
      platform: asset.platform ?? manifest.platform,
      groups: asset.groups ?? [],
      nodeModules: asset.nodeModules ?? [],
      installedAt,
    });

    await cleanupPreviousAssetVersions(runtimeBaseDir, asset.id, expectedExpandedSha256, options.keepPrevious ?? 1);

    return {
      assetId: asset.id,
      root: targetRoot,
      activeManifestPath,
      expandedSha256: expectedExpandedSha256,
      archiveSha256: expectedArchiveSha256,
      reusedExistingInstall,
    };
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true });
  }
}
