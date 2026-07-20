import { createHash } from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import { getUserDataPath } from '../platform';
import {
  PROVIDER_ICON_ASSET_URI_PREFIX,
  PROVIDER_ICON_IMAGE_MAX_BYTES,
  getProviderIconAssetFilename,
  parseProviderIconImageDataUrl,
  validateProviderIcon,
} from '../../shared/modelRuntime';

const MIME_EXTENSION: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
};

const EXTENSION_MIME: Record<string, string> = Object.fromEntries(
  Object.entries(MIME_EXTENSION).map(([mime, ext]) => [ext, mime === 'image/jpg' ? 'image/jpeg' : mime]),
);

export interface SaveProviderIconAssetRequest {
  provider: string;
  dataUrl: string;
  baseDir?: string;
  ownership?: ProviderIconAssetOwnership;
  source?: ProviderIconAssetSource;
  syncState?: ProviderIconAssetSyncState;
  remoteId?: string;
  lastSyncedAt?: number;
}

export interface ProviderIconAssetResult {
  icon: string;
  filename: string;
  path: string;
  imageBytes: number;
  mimeType: string;
  contentHash: string;
  ownership: ProviderIconAssetOwnership;
  source: ProviderIconAssetSource;
  syncState: ProviderIconAssetSyncState;
  remoteId?: string;
  lastSyncedAt?: number;
}

export interface ResolvedProviderIconAsset {
  icon: string;
  filename: string;
  dataUrl: string;
  imageBytes: number;
  mimeType: string;
}

export type ProviderIconAssetOwnership = 'local' | 'team';
export type ProviderIconAssetSource = 'local-upload' | 'team-sync' | 'cloud-control-plane';
export type ProviderIconAssetSyncState = 'local-only' | 'sync-ready' | 'synced';

export interface ProviderIconAssetManifestEntry {
  icon: string;
  filename: string;
  provider: string;
  mimeType: string;
  imageBytes: number;
  contentHash: string;
  ownership: ProviderIconAssetOwnership;
  source: ProviderIconAssetSource;
  syncState: ProviderIconAssetSyncState;
  remoteId?: string;
  lastSyncedAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderIconAssetManifest {
  version: 1;
  updatedAt: number;
  assets: Record<string, ProviderIconAssetManifestEntry>;
}

function getProviderIconAssetsDir(baseDir = getUserDataPath()): string {
  return path.join(baseDir, 'assets', 'provider-icons');
}

function getProviderIconManifestPath(baseDir = getUserDataPath()): string {
  return path.join(getProviderIconAssetsDir(baseDir), 'manifest.json');
}

function sanitizeProviderId(provider: string): string {
  return provider
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'provider';
}

function resolveAssetPath(filename: string, baseDir?: string): string {
  const dir = getProviderIconAssetsDir(baseDir);
  const target = path.join(dir, filename);
  const relative = path.relative(dir, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Invalid provider icon asset path.');
  }
  return target;
}

function emptyManifest(): ProviderIconAssetManifest {
  return {
    version: 1,
    updatedAt: 0,
    assets: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function parseProviderIconAssetOwnership(value: unknown): ProviderIconAssetOwnership {
  return value === 'team' ? 'team' : 'local';
}

function parseProviderIconAssetSource(value: unknown, ownership: ProviderIconAssetOwnership): ProviderIconAssetSource {
  if (value === 'team-sync' || value === 'cloud-control-plane' || value === 'local-upload') {
    return value;
  }
  return ownership === 'team' ? 'team-sync' : 'local-upload';
}

function parseProviderIconAssetSyncState(value: unknown, source: ProviderIconAssetSource): ProviderIconAssetSyncState {
  if (value === 'synced' || value === 'sync-ready' || value === 'local-only') {
    return value;
  }
  return source === 'local-upload' ? 'local-only' : 'synced';
}

function resolveProviderIconAssetGovernanceMetadata(
  request: SaveProviderIconAssetRequest,
  previous: ProviderIconAssetManifestEntry | undefined,
): Pick<ProviderIconAssetManifestEntry, 'ownership' | 'source' | 'syncState' | 'remoteId' | 'lastSyncedAt'> {
  const requestedOwnership = request.ownership ?? previous?.ownership ?? 'local';
  const ownership = parseProviderIconAssetOwnership(requestedOwnership);
  const source = parseProviderIconAssetSource(request.source ?? previous?.source, ownership);
  const syncState = parseProviderIconAssetSyncState(request.syncState ?? previous?.syncState, source);
  const remoteId = request.remoteId ?? previous?.remoteId;
  const lastSyncedAt = request.lastSyncedAt ?? previous?.lastSyncedAt;
  return {
    ownership,
    source,
    syncState,
    ...(remoteId ? { remoteId } : {}),
    ...(typeof lastSyncedAt === 'number' ? { lastSyncedAt } : {}),
  };
}

function parseManifestEntry(value: unknown): ProviderIconAssetManifestEntry | null {
  if (!isRecord(value)) return null;
  const ownership = parseProviderIconAssetOwnership(value.ownership);
  const source = parseProviderIconAssetSource(value.source, ownership);
  const syncState = parseProviderIconAssetSyncState(value.syncState, source);
  if (
    typeof value.icon !== 'string'
    || typeof value.filename !== 'string'
    || typeof value.provider !== 'string'
    || typeof value.mimeType !== 'string'
    || typeof value.imageBytes !== 'number'
    || typeof value.contentHash !== 'string'
    || typeof value.createdAt !== 'number'
    || typeof value.updatedAt !== 'number'
  ) {
    return null;
  }
  return {
    icon: value.icon,
    filename: value.filename,
    provider: value.provider,
    mimeType: value.mimeType,
    imageBytes: value.imageBytes,
    contentHash: value.contentHash,
    ownership,
    source,
    syncState,
    ...(typeof value.remoteId === 'string' && value.remoteId ? { remoteId: value.remoteId } : {}),
    ...(typeof value.lastSyncedAt === 'number' ? { lastSyncedAt: value.lastSyncedAt } : {}),
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

export async function readProviderIconAssetManifest(baseDir?: string): Promise<ProviderIconAssetManifest> {
  try {
    const raw = await fs.readFile(getProviderIconManifestPath(baseDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.assets)) {
      return emptyManifest();
    }
    const assets: Record<string, ProviderIconAssetManifestEntry> = {};
    for (const [icon, entry] of Object.entries(parsed.assets)) {
      const normalized = parseManifestEntry(entry);
      if (normalized?.icon === icon) {
        assets[icon] = normalized;
      }
    }
    return {
      version: 1,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
      assets,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyManifest();
    throw error;
  }
}

async function writeProviderIconAssetManifest(
  manifest: ProviderIconAssetManifest,
  baseDir?: string,
): Promise<void> {
  const manifestPath = getProviderIconManifestPath(baseDir);
  await fs.mkdir(path.dirname(manifestPath), { recursive: true });
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

export async function saveProviderIconAsset({
  provider,
  dataUrl,
  baseDir,
  ownership,
  source,
  syncState,
  remoteId,
  lastSyncedAt,
}: SaveProviderIconAssetRequest): Promise<ProviderIconAssetResult> {
  const validation = validateProviderIcon(dataUrl);
  if (!validation.valid || validation.kind !== 'image') {
    throw new Error('Provider icon asset must be a supported data:image icon.');
  }
  if (validation.imageBytes > PROVIDER_ICON_IMAGE_MAX_BYTES) {
    throw new Error('Provider icon asset is too large.');
  }

  const parsed = parseProviderIconImageDataUrl(validation.normalized);
  if (!parsed) {
    throw new Error('Provider icon asset could not be decoded.');
  }

  const extension = MIME_EXTENSION[parsed.mimeType.toLowerCase()];
  if (!extension) {
    throw new Error(`Unsupported provider icon mime type: ${parsed.mimeType}`);
  }

  const buffer = Buffer.from(parsed.base64, 'base64');
  const contentHash = createHash('sha256').update(buffer).digest('hex');
  const filename = `${sanitizeProviderId(provider)}-${contentHash.slice(0, 16)}.${extension}`;
  const dir = getProviderIconAssetsDir(baseDir);
  const filePath = resolveAssetPath(filename, baseDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(filePath, buffer);
  const icon = `${PROVIDER_ICON_ASSET_URI_PREFIX}${filename}`;
  const now = Date.now();
  const manifest = await readProviderIconAssetManifest(baseDir);
  const previous = manifest.assets[icon];
  const governance = resolveProviderIconAssetGovernanceMetadata(
    { provider, dataUrl, baseDir, ownership, source, syncState, remoteId, lastSyncedAt },
    previous,
  );
  manifest.updatedAt = now;
  manifest.assets[icon] = {
    icon,
    filename,
    provider,
    mimeType: parsed.mimeType,
    imageBytes: parsed.imageBytes,
    contentHash,
    ...governance,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
  await writeProviderIconAssetManifest(manifest, baseDir);

  return {
    icon,
    filename,
    path: filePath,
    imageBytes: parsed.imageBytes,
    mimeType: parsed.mimeType,
    contentHash,
    ...governance,
  };
}

export async function resolveProviderIconAsset(
  icon: string,
  baseDir?: string,
): Promise<ResolvedProviderIconAsset> {
  const filename = getProviderIconAssetFilename(icon);
  if (!filename) {
    throw new Error('Invalid provider icon asset reference.');
  }
  const filePath = resolveAssetPath(filename, baseDir);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const mimeType = EXTENSION_MIME[ext];
  if (!mimeType) {
    throw new Error(`Unsupported provider icon asset extension: ${ext}`);
  }

  const buffer = await fs.readFile(filePath);
  if (buffer.byteLength > PROVIDER_ICON_IMAGE_MAX_BYTES) {
    throw new Error('Provider icon asset is too large.');
  }

  return {
    icon,
    filename,
    dataUrl: `data:${mimeType};base64,${buffer.toString('base64')}`,
    imageBytes: buffer.byteLength,
    mimeType,
  };
}
