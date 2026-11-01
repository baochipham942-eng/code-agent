// ============================================================================
// MemoryRepository - 记忆存储/检索
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { MEMORY } from '../../../../shared/constants';
import { normalizeFtsMatchQuery, runMemoriesFtsBackfill } from '../../../../shared/memoriesFts.sql';
import { isFtsDisabled, isFtsSearchDegraded, markFtsTableAvailable, repairFtsTableIfCorrupt } from '../database/ftsRepair';
import { isSqliteCorruptionError } from '../database/sqliteErrors';
import type { MemoryRecord } from '../../../protocol/types';
import { guardSensitiveText, guardSensitiveValue } from '../../../security/sensitiveDataGuard';
import type {
  MemoryChangeActor,
  MemoryChangeJournalContext,
  MemoryChangeJournalRow,
  MemoryChangeOperation,
} from '../../../../shared/contract/memory';
import { createLogger } from '../../infra/logger';

export type { MemoryRecord };

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length === 0) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

const journalLogger = createLogger('MemoryRepository');

/** 记忆变更日志（N-MEM-JOURNAL-SOURCEJUMP）：before/after 快照 = {summary,status,content} 的截断 JSON */
function journalSnapshot(record: MemoryRecord): string {
  const snapshot = JSON.stringify({
    summary: record.summary ?? null,
    status: record.status ?? 'active',
    content: record.content,
  });
  if (snapshot.length <= MEMORY.JOURNAL_SNAPSHOT_MAX_CHARS) return snapshot;
  return `${snapshot.slice(0, MEMORY.JOURNAL_SNAPSHOT_MAX_CHARS)}…[truncated]`;
}

/** 统一条目 id（metadata.memoryEntry.id）有则记录，供面板按 entryId 查历史 */
function journalEntryId(metadata: Record<string, unknown>): string | null {
  const memoryEntry = metadata?.memoryEntry;
  if (isRecord(memoryEntry) && typeof memoryEntry.id === 'string' && memoryEntry.id.length > 0) {
    return memoryEntry.id;
  }
  return null;
}

function memoryStatusCondition(
  options: { includeArchived?: boolean; includeCandidates?: boolean },
  column = 'status',
): string {
  const status = `COALESCE(${column}, 'active')`;
  if (options.includeArchived && options.includeCandidates) return '1 = 1';
  if (options.includeArchived) return `${status} IN ('active', 'archived')`;
  if (options.includeCandidates) return `${status} != 'archived'`;
  return `${status} = 'active'`;
}

export class MemoryRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------------------------

  createMemory(
    data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>,
    journal?: MemoryChangeJournalContext,
  ): MemoryRecord {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();
    const safeContent = guardMemoryText(data.content, 50_000);
    const safeSummary = data.summary ? guardMemoryText(data.summary, 2_000) : undefined;
    const safeMetadata = guardMemoryMetadata(data.metadata || {});

    this.db.prepare(`
      INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, status, deprecated_by, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      data.type,
      data.category,
      safeContent,
      safeSummary || null,
      data.source,
      data.projectPath || null,
      data.sessionId || null,
      data.confidence,
      JSON.stringify(safeMetadata),
      data.status || 'active',
      data.deprecatedBy || null,
      now,
      now
    );

    const created: MemoryRecord = {
      id,
      ...data,
      content: safeContent,
      summary: safeSummary,
      metadata: safeMetadata,
      status: data.status || 'active',
      deprecatedBy: data.deprecatedBy,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.appendJournal('create', created, null, created, journal);
    return created;
  }

  getMemory(id: string): MemoryRecord | null {
    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToMemoryRecord(row);
  }

  listMemories(options: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
    orderBy?: string;
    orderDir?: 'ASC' | 'DESC';
    includeArchived?: boolean;
    includeCandidates?: boolean;
  } = {}): MemoryRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

    conditions.push(memoryStatusCondition(options));

    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }
    if (options.source) {
      conditions.push('source = ?');
      params.push(options.source);
    }
    if (options.projectPath) {
      conditions.push('project_path = ?');
      params.push(options.projectPath);
    }
    if (options.sessionId) {
      conditions.push('session_id = ?');
      params.push(options.sessionId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const orderBy = options.orderBy || 'created_at';
    const orderDir = options.orderDir || 'DESC';
    const limit = options.limit || 100;
    const offset = options.offset || 0;

    const rows = this.db.prepare(`
      SELECT * FROM memories ${where}
      ORDER BY ${orderBy} ${orderDir}
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SQLiteRow[];

    return rows.map(row => this.rowToMemoryRecord(row));
  }

  updateMemory(id: string, updates: Partial<MemoryRecord>, journal?: MemoryChangeJournalContext): MemoryRecord | null {
    const before = this.getMemory(id);

    const sets: string[] = ['updated_at = ?'];
    const params: unknown[] = [Date.now()];

    if (updates.category !== undefined) {
      sets.push('category = ?');
      params.push(updates.category);
    }
    if (updates.content !== undefined) {
      sets.push('content = ?');
      params.push(guardMemoryText(updates.content, 50_000));
    }
    if (updates.summary !== undefined) {
      sets.push('summary = ?');
      params.push(updates.summary ? guardMemoryText(updates.summary, 2_000) : null);
    }
    if (updates.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(updates.confidence);
    }
    if (updates.projectPath !== undefined) {
      sets.push('project_path = ?');
      params.push(updates.projectPath || null);
    }
    if (updates.sessionId !== undefined) {
      sets.push('session_id = ?');
      params.push(updates.sessionId || null);
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(guardMemoryMetadata(updates.metadata)));
    }
    if (updates.status !== undefined) {
      sets.push('status = ?');
      params.push(updates.status);
    }
    if (updates.deprecatedBy !== undefined) {
      sets.push('deprecated_by = ?');
      params.push(updates.deprecatedBy || null);
    }

    params.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    const after = this.getMemory(id);
    if (before && after) {
      // 只记真实变更（rework r2 ①③）：快照（summary/status/content）无差异的写入
      // 不追加日志行——否则镜像重建等批量回写会给每条 no-op 记一行，淹没历史并
      // 抹掉列表上真实的「后台写入」标记。显式 evict 恒记（清退要留痕）。
      const changed = journal?.operation === 'evict' || journalSnapshot(before) !== journalSnapshot(after);
      if (changed) {
        this.appendJournal(journal?.operation ?? 'update', after, before, after, journal);
      }
    }
    return after;
  }

  deleteMemory(id: string, journal?: MemoryChangeJournalContext): boolean {
    const before = this.getMemory(id);
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    if (result.changes > 0 && before) {
      this.appendJournal(journal?.operation ?? 'delete', before, before, null, journal);
    }
    return result.changes > 0;
  }

  deleteMemories(filter: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
  }, journal?: MemoryChangeJournalContext): number {
    const conditions: string[] = [];
    const params: unknown[] = [];

    if (filter.type) {
      conditions.push('type = ?');
      params.push(filter.type);
    }
    if (filter.category) {
      conditions.push('category = ?');
      params.push(filter.category);
    }
    if (filter.source) {
      conditions.push('source = ?');
      params.push(filter.source);
    }
    if (filter.projectPath) {
      conditions.push('project_path = ?');
      params.push(filter.projectPath);
    }
    if (filter.sessionId) {
      conditions.push('session_id = ?');
      params.push(filter.sessionId);
    }

    if (conditions.length === 0) {
      return 0; // 不允许无条件删除所有
    }

    const deleted = (this.db.prepare(`SELECT * FROM memories WHERE ${conditions.join(' AND ')}`).all(...params) as SQLiteRow[])
      .map((row) => this.rowToMemoryRecord(row));
    const result = this.db.prepare(`DELETE FROM memories WHERE ${conditions.join(' AND ')}`).run(...params);
    if (result.changes > 0) {
      for (const record of deleted) {
        this.appendJournal(journal?.operation ?? 'delete', record, record, null, journal);
      }
    }
    return result.changes;
  }

  /**
   * 关键词检索。BM25（memories_fts）召回优先——相关性排序、零外部依赖；
   * 以下情形退回 LIKE 全扫（保持旧行为）：查询 <3 字符（trigram 下限）、
   * raw FTS 语法错误、FTS 零命中（历史数据缺口兜底）。
   * 读时 decay 在两条通道之上统一应用。排序：衰减置信度降序 → accessCount 降序
   * → (lastAccessedAt || updatedAt) 降序——高频使用的记忆在置信度打平时先被召回。
   */
  searchMemories(query: string, options: { type?: string; category?: string; limit?: number; applyDecay?: boolean; includeArchived?: boolean; includeCandidates?: boolean; now?: number } = {}): MemoryRecord[] {
    // Fetch more rows than needed so decay filtering still returns enough
    const requestedLimit = options.limit || 20;
    const fetchLimit = (options.applyDecay !== false) ? requestedLimit * 3 : requestedLimit;

    const rows = this.searchMemoriesFtsRows(query, options, fetchLimit)
      ?? this.searchMemoriesLikeRows(query, options, fetchLimit);

    let records = rows.map(row => this.rowToMemoryRecord(row));

    // Apply read-time decay: confidence decreases with time since last access (or update).
    // Refresh-on-read: memories accessed recently via recordMemoryAccess() stay fresh.
    if (options.applyDecay !== false) {
      const now = options.now ?? Date.now();
      const halfLifeMs = MEMORY.RECORD_DECAY_DAYS * 24 * 60 * 60 * 1000;

      records = records
        .map(r => {
          const lastTouch = r.lastAccessedAt || r.updatedAt;
          const ageMs = now - lastTouch;
          const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
          return { ...r, confidence: r.confidence * decayFactor };
        })
        .filter(r => r.confidence >= MEMORY.RECORD_MIN_CONFIDENCE)
        .sort((a, b) =>
          b.confidence - a.confidence ||
          b.accessCount - a.accessCount ||
          (b.lastAccessedAt || b.updatedAt) - (a.lastAccessedAt || a.updatedAt)
        );
    }

    return records.slice(0, requestedLimit);
  }

  /** BM25 召回；不可用/不适用时返回 null 让调用方走 LIKE 兜底 */
  private searchMemoriesFtsRows(
    query: string,
    options: { type?: string; category?: string; includeArchived?: boolean; includeCandidates?: boolean },
    fetchLimit: number
  ): SQLiteRow[] | null {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return null;
    }

    const conditions: string[] = [];
    const params: unknown[] = [normalizeFtsMatchQuery(trimmed)];
    if (options.type) {
      conditions.push('memories_fts.type = ?');
      params.push(options.type);
    }
    if (options.category) {
      conditions.push('memories_fts.category = ?');
      params.push(options.category);
    }
    conditions.push(memoryStatusCondition(options, 'm.status'));
    const extra = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    if (isFtsSearchDegraded('memories_fts')) {
      return null;
    }

    try {
      const rows = this.db.prepare(`
        SELECT m.* FROM memories_fts
        JOIN memories m ON m.id = memories_fts.memory_id
        WHERE memories_fts MATCH ? ${extra}
        ORDER BY rank
        LIMIT ?
      `).all(...params, fetchLimit) as SQLiteRow[];
      return rows.length > 0 ? rows : null;
    } catch (err) {
      if (isSqliteCorruptionError(err)) {
        repairFtsTableIfCorrupt(this.db, 'memories_fts');
      }
      // FTS 表缺失 / 语法错误 / 损坏 → LIKE 兜底
      return null;
    }
  }

  /** 旧 LIKE 全扫通道（兜底） */
  private searchMemoriesLikeRows(
    query: string,
    options: { type?: string; category?: string; includeArchived?: boolean; includeCandidates?: boolean },
    fetchLimit: number
  ): SQLiteRow[] {
    const conditions: string[] = ['(content LIKE ? OR summary LIKE ?)'];
    const params: unknown[] = [`%${query}%`, `%${query}%`];

    if (options.type) {
      conditions.push('type = ?');
      params.push(options.type);
    }
    if (options.category) {
      conditions.push('category = ?');
      params.push(options.category);
    }
    conditions.push(memoryStatusCondition(options));

    return this.db.prepare(`
      SELECT * FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY access_count DESC, COALESCE(last_accessed_at, updated_at) DESC
      LIMIT ?
    `).all(...params, fetchLimit) as SQLiteRow[];
  }

  /**
   * Backfill memories_fts from existing memories（升级后首次启动）。
   * 只在 FTS 空且 memories 非空时执行；幂等。
   */
  backfillMemoriesFts(): number {
    if (isFtsDisabled('memories_fts')) {
      return 0;
    }
    try {
      // LIMIT 1 存在性检查，避免 FTS5 COUNT(*) 全扫（启动关键路径）
      const ftsHasRows = this.db.prepare('SELECT 1 FROM memories_fts LIMIT 1').get() !== undefined;
      const memHasRows = this.db.prepare('SELECT 1 FROM memories LIMIT 1').get() !== undefined;
      if (ftsHasRows || !memHasRows) {
        return 0;
      }
      const backfilled = runMemoriesFtsBackfill(this.db);
      markFtsTableAvailable('memories_fts');
      return backfilled;
    } catch (err) {
      if (isSqliteCorruptionError(err)) {
        repairFtsTableIfCorrupt(this.db, 'memories_fts');
      }
      // backfill 失败不阻塞启动；下次启动重试（原子回滚保证 FTS 仍为空）
      return 0;
    }
  }

  getMemoryStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as SQLiteRow;
    const total = totalRow.c as number;

    const byType: Record<string, number> = {};
    const typeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM memories GROUP BY type').all() as SQLiteRow[];
    for (const row of typeRows) {
      byType[row.type as string] = row.c as number;
    }

    const bySource: Record<string, number> = {};
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as c FROM memories GROUP BY source').all() as SQLiteRow[];
    for (const row of sourceRows) {
      bySource[row.source as string] = row.c as number;
    }

    const byCategory: Record<string, number> = {};
    const categoryRows = this.db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as SQLiteRow[];
    for (const row of categoryRows) {
      byCategory[row.category as string] = row.c as number;
    }

    return { total, byType, bySource, byCategory };
  }

  recordMemoryAccess(id: string): void {
    this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  // --------------------------------------------------------------------------
  // Memory Change Journal（N-MEM-JOURNAL-SOURCEJUMP，append-only）
  // --------------------------------------------------------------------------

  /**
   * 读某条记忆的变更日志（新→旧）；entryId/memoryId 二选一。
   * db: 前缀的 entryId（直建 DB 记忆在面板里的兜底条目 id，无统一条目 id）查不到
   * entry_id 行时回落到 memory_id——与 annotateLastChange 的徽标解析同口径，
   * 否则「后台写入」徽标亮着、详情历史却恒空（rework r4）。
   */
  listMemoryJournal(request: { entryId?: string; memoryId?: string; limit?: number }): MemoryChangeJournalRow[] {
    const limit = Math.max(1, Math.min(request.limit ?? MEMORY.JOURNAL_DEFAULT_LIMIT, MEMORY.JOURNAL_MAX_LIMIT));
    const selectJournal = (column: 'entry_id' | 'memory_id', key: string): SQLiteRow[] =>
      this.db.prepare(`
        SELECT * FROM memory_change_journal WHERE ${column} = ? ORDER BY id DESC LIMIT ?
      `).all(key, limit) as SQLiteRow[];
    if (request.entryId) {
      const rows = selectJournal('entry_id', request.entryId);
      if (rows.length > 0 || !request.entryId.startsWith('db:')) return rows.map((row) => this.rowToJournalRow(row));
      return selectJournal('memory_id', request.entryId.slice(3)).map((row) => this.rowToJournalRow(row));
    }
    if (!request.memoryId) return [];
    return selectJournal('memory_id', request.memoryId).map((row) => this.rowToJournalRow(row));
  }

  /** 每条记忆最近一次变更（列表「后台写入」标记用）。 */
  latestMemoryChanges(): Array<Pick<MemoryChangeJournalRow, 'memoryId' | 'entryId' | 'actor' | 'operation' | 'timestamp'>> {
    const rows = this.db.prepare(`
      SELECT memory_id, entry_id, actor, operation, timestamp FROM (
        SELECT memory_id, entry_id, actor, operation, timestamp,
          ROW_NUMBER() OVER (PARTITION BY memory_id ORDER BY id DESC) AS rn
        FROM memory_change_journal
      ) WHERE rn = 1
    `).all() as SQLiteRow[];
    return rows.map((row) => ({
      memoryId: row.memory_id as string,
      entryId: (row.entry_id as string | null) ?? null,
      actor: row.actor as MemoryChangeActor,
      operation: row.operation as MemoryChangeOperation,
      timestamp: row.timestamp as number,
    }));
  }

  /**
   * 追加一行变更日志。fail-safe：日志写失败只 warn，绝不拦记忆写入本身
   * （与 trace finalizer 同款纪律）。
   */
  private appendJournal(
    defaultOperation: MemoryChangeOperation,
    anchor: MemoryRecord,
    before: MemoryRecord | null,
    after: MemoryRecord | null,
    journal: MemoryChangeJournalContext | undefined,
  ): void {
    const operation: MemoryChangeOperation = journal?.operation ?? defaultOperation;
    const sessionId = journal?.sessionId
      ?? after?.sessionId
      ?? before?.sessionId
      ?? null;
    const entryId = journalEntryId(after?.metadata ?? anchor.metadata ?? {});
    try {
      this.db.prepare(`
        INSERT INTO memory_change_journal (timestamp, operation, memory_id, entry_id, actor, before_content, after_content, session_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        Date.now(),
        operation,
        anchor.id,
        entryId,
        journal?.actor ?? 'unknown',
        before ? journalSnapshot(before) : null,
        after ? journalSnapshot(after) : null,
        sessionId,
      );
    } catch (error) {
      journalLogger.warn('Memory change journal append failed (memory write kept)', {
        memoryId: anchor.id,
        operation,
        actor: journal?.actor ?? 'unknown',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private rowToJournalRow(row: SQLiteRow): MemoryChangeJournalRow {
    return {
      id: row.id as number,
      timestamp: row.timestamp as number,
      operation: row.operation as MemoryChangeOperation,
      memoryId: row.memory_id as string,
      entryId: (row.entry_id as string | null) ?? null,
      actor: row.actor as MemoryChangeActor,
      beforeContent: (row.before_content as string | null) ?? null,
      afterContent: (row.after_content as string | null) ?? null,
      sessionId: (row.session_id as string | null) ?? null,
    };
  }

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private rowToMemoryRecord(row: SQLiteRow): MemoryRecord {
    return {
      id: row.id as string,
      type: row.type as MemoryRecord['type'],
      category: row.category as string,
      content: row.content as string,
      summary: row.summary as string | undefined,
      source: row.source as MemoryRecord['source'],
      projectPath: row.project_path as string | undefined,
      sessionId: row.session_id as string | undefined,
      confidence: row.confidence as number,
      metadata: parseJsonRecord(row.metadata),
      status: (row.status as MemoryRecord['status']) || 'active',
      deprecatedBy: row.deprecated_by as string | undefined,
      accessCount: row.access_count as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastAccessedAt: row.last_accessed_at as number | undefined,
    };
  }
}

function guardMemoryText(value: string, maxLength: number): string {
  return guardSensitiveText(value, {
    surface: 'memory',
    mode: 'local-persist',
    maxLength,
  }).trim();
}

function guardMemoryMetadata(value: Record<string, unknown> | undefined): Record<string, unknown> {
  return guardSensitiveValue(value || {}, {
    surface: 'memory',
    mode: 'local-persist',
    maxLength: 20_000,
  }) as Record<string, unknown>;
}
