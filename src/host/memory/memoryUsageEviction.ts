// Seed 注入的用量淘汰（N-MEM-CITEBACK-RANK-EVICT）：
// 用过（accessCount > 0）但超过 MEMORY.SEED_STALE_USED_MS 没再用过的记忆，
// 不再进 buildPackedSeedMemory 的自动注入集合。只影响注入：不删行、不改排序/
// 打分，MemoryRead 与搜索照常返回。从未用过（accessCount 0）或 lastAccessedAt
// 缺失的行永不淘汰——也不回落到 updatedAt/createdAt（回落会把「从没被读过」
// 误伤成「很久没读」）。fail-open：任何错误都退回空集合并 warn 带原因。

import { createLogger } from '../services/infra/logger';
import { MEMORY } from '../../shared/constants';
import { storedMemoryToEntry, type MemoryEntryDatabase } from './memoryEntryRuntime';

const logger = createLogger('MemoryUsageEviction');

/** 与 listUnifiedMemoryEntries 的 DB 侧候选窗口同宽：只在这个窗口内找用量淘汰 */
const SCAN_LIMIT = 500;

/**
 * 列出应从 seed 注入中剔除的「用过但已过期不用」条目 id。
 * Entry id 与 packer 同源：storedMemoryToEntry(row).id。
 */
export function staleUsedMemoryEntryIds(
  db: MemoryEntryDatabase | undefined,
  now: number = Date.now(),
): Set<string> {
  if (!db) return new Set();
  try {
    const rows = db.listMemories({
      includeArchived: true,
      includeCandidates: true,
      limit: SCAN_LIMIT,
      orderBy: 'updated_at',
      orderDir: 'DESC',
    });
    const cutoff = now - MEMORY.SEED_STALE_USED_MS;
    const stale = new Set<string>();
    for (const row of rows) {
      // lastAccessedAt 判 typeof：DB 列可空，null 会被 as 掩盖，`null < cutoff`
      // 在数值比较里成真，必须显式挡掉。
      if (row.accessCount > 0 && typeof row.lastAccessedAt === 'number' && row.lastAccessedAt < cutoff) {
        stale.add(storedMemoryToEntry(row).id);
      }
    }
    return stale;
  } catch (error) {
    logger.warn('[MemoryUsageEviction] stale-used scan failed, injecting without eviction', {
      error: String(error),
    });
    return new Set();
  }
}
