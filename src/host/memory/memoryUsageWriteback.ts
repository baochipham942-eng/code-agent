// 记忆算「用过」只认本进程里对那一条的成功 MemoryRead。
// 同一 (runKey, filename) 只调用一次 recordMemoryAccess。
// 去重表按 runKey 首次写入的顺序保留，最多 64 个，超出丢最旧的（FIFO，重复读不刷新顺序）。

import { getDatabase } from '../services/core/databaseService';
import { memoryEntryMetadata } from './memoryEntryMetadata';

const MAX_TRACKED_RUNS = 64;
const MIRROR_PAGE_SIZE = 1000;
const MIRROR_SCAN_CAP = 100_000;

const readsByRun = new Map<string, Set<string>>();

type MemoryReadUsageWriteback =
  | { recorded: true }
  | { recorded: false; reason: 'duplicate' | 'missing-mirror' | 'blank-key' };

type MemoryDb = ReturnType<typeof getDatabase>;

function remember(runKey: string, filename: string): void {
  let seen = readsByRun.get(runKey);
  if (!seen) {
    if (readsByRun.size >= MAX_TRACKED_RUNS) {
      const oldest = readsByRun.keys().next().value;
      if (oldest !== undefined) readsByRun.delete(oldest);
    }
    seen = new Set<string>();
    readsByRun.set(runKey, seen);
  }
  seen.add(filename);
}

function findActiveLightFileMirror(db: MemoryDb, filename: string): { id: string } | null {
  for (let offset = 0; offset < MIRROR_SCAN_CAP; offset += MIRROR_PAGE_SIZE) {
    const rows = db.listMemories({
      includeCandidates: true,
      limit: MIRROR_PAGE_SIZE,
      offset,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    for (const row of rows) {
      if (row.status === 'archived') continue;
      const meta = memoryEntryMetadata(row);
      if (meta?.sourceOfTruth === 'light_file' && meta.filePath === filename) return row;
    }
    if (rows.length < MIRROR_PAGE_SIZE) return null;
  }
  return null;
}

export function recordMemoryReadUsage(input: {
  runKey: string;
  filename: string;
}): MemoryReadUsageWriteback {
  const runKey = input.runKey;
  const filename = input.filename;
  if (!runKey || !filename) return { recorded: false, reason: 'blank-key' };
  if (readsByRun.get(runKey)?.has(filename)) return { recorded: false, reason: 'duplicate' };

  const db = getDatabase();
  const row = findActiveLightFileMirror(db, filename);
  if (!row) return { recorded: false, reason: 'missing-mirror' };

  db.recordMemoryAccess(row.id);
  remember(runKey, filename);
  return { recorded: true };
}
