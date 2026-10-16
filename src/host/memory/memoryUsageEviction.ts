// Seed 注入的用量淘汰（N-MEM-CITEBACK-RANK-EVICT + N-MEM-EVICT-NEVER-READ）：
// - 用过（accessCount > 0）但超过 MEMORY.SEED_STALE_USED_MS 没再用过 ⇒ stale_used；
// - 从没被 MemoryRead 用过（accessCount 0）且自 max(创建时间, 上线日) 起超过
//   MEMORY.SEED_NEVER_USED_GRACE_MS ⇒ never_used（爸 10-14 定 B：「用过」只认 MemoryRead，
//   注入本身不算用）。
// 两类都只退出 buildPackedSeedMemory 的自动注入：不删行、不改排序/打分，MemoryRead 与
// 搜索照常返回；面板显示原因，「恢复」记一次使用即回到注入集合。
// fail-open：任何错误都退回空集合并 warn 带原因。

import { createLogger } from '../services/infra/logger';
import { MEMORY } from '../../shared/constants';
import type { MemoryEntryInjectionPause } from '../../shared/contract/memory';
import { storedMemoryToEntry, type MemoryEntryDatabase } from './memoryEntryRuntime';

const logger = createLogger('MemoryUsageEviction');

/** 与 listUnifiedMemoryEntries 的 DB 侧候选窗口同宽：只在这个窗口内找用量淘汰 */
const SCAN_LIMIT = 500;

type EvictionRow = ReturnType<MemoryEntryDatabase['listMemories']>[number];

function scanRows(db: MemoryEntryDatabase): EvictionRow[] {
  return db.listMemories({
    includeArchived: true,
    includeCandidates: true,
    limit: SCAN_LIMIT,
    orderBy: 'updated_at',
    orderDir: 'DESC',
  });
}

function pauseFor(row: EvictionRow, now: number): MemoryEntryInjectionPause | null {
  if (row.accessCount > 0) {
    // lastAccessedAt 判 typeof：DB 列可空，null 会被 as 掩盖，`null < cutoff` 在数值比较里成真。
    if (typeof row.lastAccessedAt === 'number' && row.lastAccessedAt < now - MEMORY.SEED_STALE_USED_MS) {
      return { reason: 'stale_used', since: row.lastAccessedAt + MEMORY.SEED_STALE_USED_MS };
    }
    return null;
  }
  const start = Math.max(row.createdAt, MEMORY.NEVER_USED_EVICTION_SINCE);
  if (start < now - MEMORY.SEED_NEVER_USED_GRACE_MS) {
    return { reason: 'never_used', since: start + MEMORY.SEED_NEVER_USED_GRACE_MS };
  }
  return null;
}

/**
 * 应从 seed 注入中剔除的条目及原因。Entry id 与 packer 同源：storedMemoryToEntry(row).id。
 */
export function memoryInjectionPauses(
  db: MemoryEntryDatabase | undefined,
  now: number = Date.now(),
): Map<string, MemoryEntryInjectionPause> {
  const pauses = new Map<string, MemoryEntryInjectionPause>();
  if (!db) return pauses;
  try {
    for (const row of scanRows(db)) {
      const pause = pauseFor(row, now);
      if (pause) pauses.set(storedMemoryToEntry(row).id, pause);
    }
  } catch (error) {
    logger.warn('[MemoryUsageEviction] usage scan failed, injecting without eviction', {
      error: String(error),
    });
    pauses.clear();
  }
  return pauses;
}

/** 面板「恢复自动注入」：给对应行记一次使用，回到注入集合（之后照常按宽限期老化）。 */
export function resumeMemoryInjection(
  db: MemoryEntryDatabase & { recordMemoryAccess(id: string): void },
  entryId: string,
): boolean {
  const row = scanRows(db).find((candidate) => storedMemoryToEntry(candidate).id === entryId);
  if (!row) return false;
  db.recordMemoryAccess(row.id);
  return true;
}
