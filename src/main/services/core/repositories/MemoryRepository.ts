// ============================================================================
// MemoryRepository - 记忆存储/检索 + entity_relations 表
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { MEMORY } from '../../../../shared/constants';

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

export interface MemoryRecord {
  id: string;
  type: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
  category: string;
  content: string;
  summary?: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath?: string;
  sessionId?: string;
  confidence: number;
  metadata: Record<string, unknown>;
  accessCount: number;
  createdAt: number;
  updatedAt: number;
  lastAccessedAt?: number;
}

export interface RelationQueryOptions {
  /** Half-life in days for confidence decay (default: MEMORY.RELATION_DECAY_DAYS) */
  decayDays?: number;
  /** Minimum confidence threshold after decay (default: MEMORY.RELATION_MIN_CONFIDENCE) */
  minConfidence?: number;
}

export interface EntityRelation {
  id: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  confidence: number;
  evidence: string;
  createdAt: number;
}

export class MemoryRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // Memory CRUD
  // --------------------------------------------------------------------------

  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    const id = `mem_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`;
    const now = Date.now();

    this.db.prepare(`
      INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, access_count, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
    `).run(
      id,
      data.type,
      data.category,
      data.content,
      data.summary || null,
      data.source,
      data.projectPath || null,
      data.sessionId || null,
      data.confidence,
      JSON.stringify(data.metadata || {}),
      now,
      now
    );

    return {
      id,
      ...data,
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
      params.push(updates.content);
    }
    if (updates.summary !== undefined) {
      sets.push('summary = ?');
      params.push(updates.summary);
    }
    if (updates.confidence !== undefined) {
      sets.push('confidence = ?');
      params.push(updates.confidence);
    }
    if (updates.metadata !== undefined) {
      sets.push('metadata = ?');
      params.push(JSON.stringify(updates.metadata));
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

  searchMemories(query: string, options: { type?: string; category?: string; limit?: number } = {}): MemoryRecord[] {
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

    const limit = options.limit || 20;

    const rows = this.db.prepare(`
      SELECT * FROM memories WHERE ${conditions.join(' AND ')}
      ORDER BY access_count DESC, updated_at DESC
      LIMIT ?
    `).all(...params, limit) as SQLiteRow[];

    return rows.map(row => this.rowToMemoryRecord(row));
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
  // Entity Relations
  // --------------------------------------------------------------------------

  addRelation(params: {
    sourceId: string;
    targetId: string;
    relationType: 'calls' | 'imports' | 'similar_to' | 'solves' | 'depends_on' | 'modifies' | 'references';
    confidence: number;
    evidence: string;
    sessionId: string;
  }): void {
    const id = `rel_${params.sessionId}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(`
      INSERT INTO entity_relations (id, source_id, target_id, relation_type, confidence, evidence, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      params.sourceId,
      params.targetId,
      params.relationType,
      params.confidence,
      params.evidence,
      Date.now(),
    );
  }

  getRelationsFor(
    entityId: string,
    direction: 'source' | 'target' | 'both' = 'both',
    options: RelationQueryOptions = {}
  ): EntityRelation[] {
    const { decayDays = MEMORY.RELATION_DECAY_DAYS, minConfidence = MEMORY.RELATION_MIN_CONFIDENCE } = options;

    let sql: string;
    if (direction === 'source') {
      sql = 'SELECT * FROM entity_relations WHERE source_id = ?';
    } else if (direction === 'target') {
      sql = 'SELECT * FROM entity_relations WHERE target_id = ?';
    } else {
      sql = 'SELECT * FROM entity_relations WHERE source_id = ? OR target_id = ?';
    }

    const params = direction === 'both' ? [entityId, entityId] : [entityId];
    const rows = this.db.prepare(sql).all(...params) as SQLiteRow[];

    const now = Date.now();
    const halfLifeMs = decayDays * 24 * 60 * 60 * 1000;

    const rawRelations = rows.map(row => ({
      id: row.id as string,
      sourceId: row.source_id as string,
      targetId: row.target_id as string,
      relationType: row.relation_type as string,
      confidence: row.confidence as number,
      evidence: row.evidence as string,
      createdAt: row.created_at as number,
    }));

    return rawRelations
      .map(r => {
        const ageMs = now - (typeof r.createdAt === 'number' ? r.createdAt : new Date(r.createdAt).getTime());
        const decayFactor = Math.pow(0.5, ageMs / halfLifeMs);
        return { ...r, confidence: (r.confidence ?? 1.0) * decayFactor };
      })
      .filter(r => r.confidence >= minConfidence)
      .sort((a, b) => b.confidence - a.confidence);
  }

  updateRelationConfidence(id: string, confidence: number, evidence?: string): void {
    this.db.prepare(
      'UPDATE entity_relations SET confidence = ?, evidence = COALESCE(?, evidence) WHERE id = ?'
    ).run(confidence, evidence ?? null, id);
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
      metadata: JSON.parse((row.metadata as string) || '{}'),
      accessCount: row.access_count as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      lastAccessedAt: row.last_accessed_at as number | undefined,
    };
  }
}
