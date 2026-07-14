// ============================================================================
// MemoryRepository - 记忆存储/检索
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { MEMORY } from '../../../../shared/constants';
import { normalizeFtsMatchQuery, runMemoriesFtsBackfill } from '../../../../shared/memoriesFts.sql';
import type { MemoryRecord } from '../../../protocol/types';
import { guardSensitiveText, guardSensitiveValue } from '../../../security/sensitiveDataGuard';

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

export class MemoryRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------------------------

  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();
    const safeContent = guardMemoryText(data.content, 50_000);
    const safeSummary = data.summary ? guardMemoryText(data.summary, 2_000) : undefined;
    const safeMetadata = guardMemoryMetadata(data.metadata || {});

    this.db.prepare(`
      INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
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
      now,
      now
    );

    return {
      id,
      ...data,
      content: safeContent,
      summary: safeSummary,
      metadata: safeMetadata,
      accessCount: 0,
      createdAt: now,
      updatedAt: now,
    };
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
  } = {}): MemoryRecord[] {
    const conditions: string[] = [];
    const params: unknown[] = [];

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

  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null {
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
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(guardMemoryMetadata(updates.metadata)));
    }

    params.push(id);
    this.db.prepare(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`).run(...params);

    return this.getMemory(id);
  }

  deleteMemory(id: string): boolean {
    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  deleteMemories(filter: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
  }): number {
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

    const result = this.db.prepare(`DELETE FROM memories WHERE ${conditions.join(' AND ')}`).run(...params);
    return result.changes;
  }

  /**
   * 关键词检索。BM25（memories_fts）召回优先——相关性排序、零外部依赖；
   * 以下情形退回 LIKE 全扫（保持旧行为）：查询 <3 字符（trigram 下限）、
   * raw FTS 语法错误、FTS 零命中（历史数据缺口兜底）。
   * 读时 decay 在两条通道之上统一应用。
   */
  searchMemories(query: string, options: { type?: string; category?: string; limit?: number; applyDecay?: boolean } = {}): MemoryRecord[] {
    // Fetch more rows than needed so decay filtering still returns enough
    const requestedLimit = options.limit || 20;
    const fetchLimit = (options.applyDecay !== false) ? requestedLimit * 3 : requestedLimit;

    const rows = this.searchMemoriesFtsRows(query, options, fetchLimit)
      ?? this.searchMemoriesLikeRows(query, options, fetchLimit);

    let records = rows.map(row => this.rowToMemoryRecord(row));

    // Apply read-time decay: confidence decreases with time since last access (or update).
    // Refresh-on-read: memories accessed recently via recordMemoryAccess() stay fresh.
    if (options.applyDecay !== false) {
      const now = Date.now();
      const halfLifeMs = MEMORY.RECORD_DECAY_DAYS * 24 * 60 * 60 * 1000;

      records = records
        .map(r => {
          const lastTouch = r.lastAccessedAt || r.updatedAt;
          const ageMs = now - lastTouch;
          const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
          return { ...r, confidence: r.confidence * decayFactor };
        })
        .filter(r => r.confidence >= MEMORY.RECORD_MIN_CONFIDENCE)
        .sort((a, b) => b.confidence - a.confidence);
    }

    return records.slice(0, requestedLimit);
  }

  /** BM25 召回；不可用/不适用时返回 null 让调用方走 LIKE 兜底 */
  private searchMemoriesFtsRows(
    query: string,
    options: { type?: string; category?: string },
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
    const extra = conditions.length > 0 ? `AND ${conditions.join(' AND ')}` : '';

    try {
      const rows = this.db.prepare(`
        SELECT m.* FROM memories_fts
        JOIN memories m ON m.id = memories_fts.memory_id
        WHERE memories_fts MATCH ? ${extra}
        ORDER BY rank
        LIMIT ?
      `).all(...params, fetchLimit) as SQLiteRow[];
      return rows.length > 0 ? rows : null;
    } catch {
      // FTS 表缺失或 raw 语法错误 → LIKE 兜底
      return null;
    }
  }

  /** 旧 LIKE 全扫通道（兜底） */
  private searchMemoriesLikeRows(
    query: string,
    options: { type?: string; category?: string },
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

    return this.db.prepare(`
      SELECT * FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY access_count DESC, updated_at DESC
      LIMIT ?
    `).all(...params, fetchLimit) as SQLiteRow[];
  }

  /**
   * Backfill memories_fts from existing memories（升级后首次启动）。
   * 只在 FTS 空且 memories 非空时执行；幂等。
   */
  backfillMemoriesFts(): number {
    try {
      // LIMIT 1 存在性检查，避免 FTS5 COUNT(*) 全扫（启动关键路径）
      const ftsHasRows = this.db.prepare('SELECT 1 FROM memories_fts LIMIT 1').get() !== undefined;
      const memHasRows = this.db.prepare('SELECT 1 FROM memories LIMIT 1').get() !== undefined;
      if (ftsHasRows || !memHasRows) {
        return 0;
      }
      return runMemoriesFtsBackfill(this.db);
    } catch {
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
