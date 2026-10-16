// ============================================================================
// Document Snapshot Manager
// ============================================================================
// Unified snapshot/backup layer for rich documents (xlsx, pptx, docx).
// Binary files can't be meaningfully diffed by git, so this provides
// per-edit snapshots with restore and cleanup capabilities.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import type {
  DeliverablePublishState,
  DeliverableShareLink,
  PublishedDeliverableVersion,
} from '../../../shared/contract/deliverable';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Snapshot {
  id: string;
  filePath: string;
  snapshotPath: string;
  timestamp: number;
  description: string;
  sizeBytes: number;
}

export interface SnapshotMeta {
  snapshots: Snapshot[];
  publishedVersions?: PublishedVersionMeta[];
  share?: DeliverableShareLink;
}

export interface PublishedVersionMeta extends PublishedDeliverableVersion {
  contentHash: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_SNAPSHOTS_PER_FILE = 20;
const SNAPSHOT_DIR_NAME = '.doc-snapshots';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getSnapshotDir(filePath: string): string {
  return path.join(path.dirname(filePath), SNAPSHOT_DIR_NAME);
}

function getMetaPath(filePath: string): string {
  const fileName = path.basename(filePath);
  return path.join(getSnapshotDir(filePath), `${fileName}.meta.json`);
}

/** 旧键：去扩展名的基名（status.md 与 status.docx 共用 status.meta.json）。 */
function getLegacyMetaPath(filePath: string): string {
  const baseName = path.basename(filePath, path.extname(filePath));
  return path.join(getSnapshotDir(filePath), `${baseName}.meta.json`);
}

/**
 * 旧版共享 meta 的只读拆分：只留下属于本文件的条目。
 * 发布版按 snapshotPath 扩展名归属，编辑快照按 filePath 全等归属；
 * share 归属看 push 到的那个发布版（version === share.pushedVersion）的扩展名，
 * 对不上号的（找不到该发布版）按现状保留。版本号原样保留，不重排。
 */
function filterLegacyMeta(filePath: string, meta: SnapshotMeta): SnapshotMeta {
  const ext = path.extname(filePath);
  const publishedVersions = meta.publishedVersions ?? [];
  const share = meta.share;
  const shareOwner = share
    ? publishedVersions.find((item) => item.version === share.pushedVersion)
    : undefined;
  return {
    snapshots: meta.snapshots.filter((item) => item.filePath === filePath),
    publishedVersions: publishedVersions.filter(
      (item) => path.extname(item.snapshotPath) === ext,
    ),
    ...(share && (!shareOwner || path.extname(shareOwner.snapshotPath) === ext)
      ? { share }
      : {}),
  };
}

export function loadMeta(filePath: string): SnapshotMeta {
  const metaPath = getMetaPath(filePath);
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as SnapshotMeta;
      return meta;
    } catch {
      return { snapshots: [] };
    }
  }
  // 新键不存在时回退读旧键（只读，永不改动旧文件）；首次 saveMeta 落新键。
  const legacyPath = getLegacyMetaPath(filePath);
  if (fs.existsSync(legacyPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(legacyPath, 'utf-8')) as SnapshotMeta;
      return filterLegacyMeta(filePath, meta);
    } catch {
      return { snapshots: [] };
    }
  }
  return { snapshots: [] };
}

function hashFile(filePath: string): string {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

export function saveMeta(filePath: string, meta: SnapshotMeta): void {
  const metaPath = getMetaPath(filePath);
  const dir = path.dirname(metaPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a snapshot of a document before editing.
 */
export function createSnapshot(filePath: string, description = 'pre-edit'): Snapshot {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const snapshotDir = getSnapshotDir(filePath);
  if (!fs.existsSync(snapshotDir)) {
    fs.mkdirSync(snapshotDir, { recursive: true });
  }

  const timestamp = Date.now();
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const id = `${base}-${timestamp}`;
  const snapshotPath = path.join(snapshotDir, `${id}${ext}`);

  fs.copyFileSync(filePath, snapshotPath);
  const stats = fs.statSync(snapshotPath);

  const snapshot: Snapshot = {
    id,
    filePath,
    snapshotPath,
    timestamp,
    description,
    sizeBytes: stats.size,
  };

  // Update meta
  const meta = loadMeta(filePath);
  meta.snapshots.push(snapshot);
  saveMeta(filePath, meta);

  // Auto-cleanup if too many snapshots
  cleanup(filePath);

  return snapshot;
}

/**
 * Freeze the current working copy as an immutable, named published version.
 * Published snapshots have their own list and never count toward the edit-snapshot quota.
 */
export function publishVersion(filePath: string, note?: string): PublishedDeliverableVersion {
  if (!fs.existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`);
  }

  const snapshotDir = getSnapshotDir(filePath);
  fs.mkdirSync(snapshotDir, { recursive: true });
  const meta = loadMeta(filePath);
  const publishedVersions = meta.publishedVersions ?? [];
  const version = publishedVersions.reduce((max, item) => Math.max(max, item.version), 0) + 1;
  const publishedAt = Date.now();
  const ext = path.extname(filePath);
  const base = path.basename(filePath, ext);
  const snapshotPath = path.join(snapshotDir, `${base}.published-v${version}${ext}`);

  fs.copyFileSync(filePath, snapshotPath);
  fs.chmodSync(snapshotPath, 0o444);
  const trimmedNote = note?.trim();
  const published: PublishedVersionMeta = {
    version,
    publishedAt,
    snapshotPath,
    ...(trimmedNote ? { note: trimmedNote } : {}),
    contentHash: hashFile(filePath),
  };
  publishedVersions.push(published);
  meta.publishedVersions = publishedVersions;
  saveMeta(filePath, meta);

  const { contentHash: _contentHash, ...publicVersion } = published;
  return publicVersion;
}

export function listPublishedVersions(filePath: string): PublishedDeliverableVersion[] {
  const publishedVersions = loadMeta(filePath).publishedVersions ?? [];
  return publishedVersions
    .filter((item) => fs.existsSync(item.snapshotPath))
    .map(({ contentHash: _contentHash, ...item }) => item)
    .sort((left, right) => right.version - left.version);
}

function hasUnpublishedChanges(filePath: string): boolean {
  const latest = (loadMeta(filePath).publishedVersions ?? [])
    .reduce<PublishedVersionMeta | undefined>(
      (current, item) => (!current || item.version > current.version ? item : current),
      undefined,
    );
  if (!latest || !fs.existsSync(filePath)) return false;
  return hashFile(filePath) !== latest.contentHash;
}

export function getPublishState(filePath: string): DeliverablePublishState {
  const latest = listPublishedVersions(filePath)[0];
  if (!latest) return { kind: 'draft' };
  return {
    kind: hasUnpublishedChanges(filePath) ? 'published-dirty' : 'published',
    version: latest.version,
    publishedAt: latest.publishedAt,
  };
}

/**
 * Restore a document from a snapshot.
 */
export function restoreSnapshot(snapshotId: string, filePath: string): boolean {
  const meta = loadMeta(filePath);
  const snapshot = meta.snapshots.find(s => s.id === snapshotId);

  if (!snapshot || !fs.existsSync(snapshot.snapshotPath)) {
    return false;
  }

  fs.copyFileSync(snapshot.snapshotPath, filePath);
  return true;
}

/**
 * Restore from the most recent snapshot.
 */
export function restoreLatest(filePath: string): Snapshot | null {
  const meta = loadMeta(filePath);
  if (meta.snapshots.length === 0) return null;

  const latest = meta.snapshots[meta.snapshots.length - 1];
  if (!fs.existsSync(latest.snapshotPath)) return null;

  fs.copyFileSync(latest.snapshotPath, filePath);
  return latest;
}

/**
 * List all snapshots for a document.
 */
export function listSnapshots(filePath: string): Snapshot[] {
  const meta = loadMeta(filePath);
  // Filter out snapshots whose files no longer exist
  return meta.snapshots.filter(s => fs.existsSync(s.snapshotPath));
}

/**
 * Keep only the most recent N snapshots, delete the rest.
 */
export function cleanup(filePath: string, maxSnapshots = MAX_SNAPSHOTS_PER_FILE): number {
  const meta = loadMeta(filePath);

  if (meta.snapshots.length <= maxSnapshots) return 0;

  // Sort by timestamp ascending
  meta.snapshots.sort((a, b) => a.timestamp - b.timestamp);

  // Remove oldest
  const toRemove = meta.snapshots.splice(0, meta.snapshots.length - maxSnapshots);
  let removed = 0;

  for (const snapshot of toRemove) {
    try {
      if (fs.existsSync(snapshot.snapshotPath)) {
        fs.unlinkSync(snapshot.snapshotPath);
        removed++;
      }
    } catch {
      // Best-effort cleanup
    }
  }

  saveMeta(filePath, meta);
  return removed;
}

/**
 * Remove all snapshots for a document.
 */
export function clearSnapshots(filePath: string): number {
  const meta = loadMeta(filePath);
  let removed = 0;

  for (const snapshot of meta.snapshots) {
    try {
      if (fs.existsSync(snapshot.snapshotPath)) {
        fs.unlinkSync(snapshot.snapshotPath);
        removed++;
      }
    } catch {
      // Best-effort
    }
  }

  meta.snapshots = [];
  saveMeta(filePath, meta);
  return removed;
}
