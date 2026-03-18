// ============================================================================
// Document Snapshot Manager
// ============================================================================
// Unified snapshot/backup layer for rich documents (xlsx, pptx, docx).
// Binary files can't be meaningfully diffed by git, so this provides
// per-edit snapshots with restore and cleanup capabilities.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';

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

interface SnapshotMeta {
  snapshots: Snapshot[];
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
  const fileHash = path.basename(filePath, path.extname(filePath));
  return path.join(getSnapshotDir(filePath), `${fileHash}.meta.json`);
}

function loadMeta(filePath: string): SnapshotMeta {
  const metaPath = getMetaPath(filePath);
  if (fs.existsSync(metaPath)) {
    try {
      return JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
    } catch {
      return { snapshots: [] };
    }
  }
  return { snapshots: [] };
}

function saveMeta(filePath: string, meta: SnapshotMeta): void {
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
