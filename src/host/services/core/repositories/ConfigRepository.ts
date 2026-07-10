// ============================================================================
// ConfigRepository - 配置/偏好/项目知识/审计日志
// ============================================================================

import { createHash } from 'node:crypto';
import type BetterSqlite3 from 'better-sqlite3';
import type { ToolResult } from '../../../../shared/contract';
import type {
  UserPreference,
  ProjectKnowledge,
  ToolExecution,
} from '../../../protocol/types';

export type { UserPreference, ProjectKnowledge, ToolExecution };

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== 'string' || value.length === 0) {
    return undefined;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  const parsed = parseJsonValue(value);
  return isRecord(parsed) ? parsed : {};
}

function parseJsonString(value: unknown): string {
  const parsed = parseJsonValue(value);
  if (typeof parsed === 'string') {
    return parsed;
  }
  return parsed === undefined ? '' : JSON.stringify(parsed);
}

function parseToolResult(value: unknown): ToolResult {
  const parsed = parseJsonValue(value);
  return isRecord(parsed)
    ? {
        toolCallId: typeof parsed.toolCallId === 'string' ? parsed.toolCallId : '',
        success: parsed.success === true,
        output: typeof parsed.output === 'string' ? parsed.output : undefined,
        error: typeof parsed.error === 'string' ? parsed.error : undefined,
        outputPath: typeof parsed.outputPath === 'string' ? parsed.outputPath : undefined,
        duration: typeof parsed.duration === 'number' ? parsed.duration : undefined,
        metadata: isRecord(parsed.metadata) ? parsed.metadata : undefined,
      }
    : { toolCallId: '', success: false };
}

function canonicalizeCacheValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalizeCacheValue);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonicalizeCacheValue(child)]),
    );
  }
  return value;
}

function isVersionedCacheNamespace(value: string): boolean {
  return value.startsWith('tool-cache:v2:');
}

export class ConfigRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // User Preferences
  // --------------------------------------------------------------------------

  setPreference(key: string, value: unknown): void {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_preferences (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    stmt.run(key, JSON.stringify(value), Date.now());
  }

  getPreference<T>(key: string, defaultValue?: T): T | undefined {
    const stmt = this.db.prepare('SELECT value FROM user_preferences WHERE key = ?');
    const row = stmt.get(key) as SQLiteRow | undefined;

    if (!row) return defaultValue;
    const parsed = parseJsonValue(row.value) as T | undefined;
    return parsed ?? defaultValue;
  }

  getAllPreferences(): Record<string, unknown> {
    const stmt = this.db.prepare('SELECT key, value FROM user_preferences');
    const rows = stmt.all() as SQLiteRow[];

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key as string] = parseJsonValue(row.value);
    }
    return result;
  }

  deletePreference(key: string): boolean {
    const stmt = this.db.prepare('DELETE FROM user_preferences WHERE key = ?');
    const result = stmt.run(key);
    return result.changes > 0;
  }

  // --------------------------------------------------------------------------
  // Project Knowledge
  // --------------------------------------------------------------------------

  saveProjectKnowledge(
    projectPath: string,
    key: string,
    value: unknown,
    source: 'learned' | 'explicit' | 'inferred' = 'learned',
    confidence: number = 1.0
  ): void {
    const now = Date.now();
    const id = `pk_${now}_${Math.random().toString(36).substring(2, 11)}`;

    const stmt = this.db.prepare(`
      INSERT INTO project_knowledge (id, project_path, key, value, source, confidence, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_path, key) DO UPDATE SET
        value = excluded.value,
        source = excluded.source,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `);

    stmt.run(id, projectPath, key, JSON.stringify(value), source, confidence, now, now);
  }

  getProjectKnowledge(projectPath: string, key?: string): ProjectKnowledge[] {
    let sql = 'SELECT * FROM project_knowledge WHERE project_path = ?';
    const params: unknown[] = [projectPath];

    if (key) {
      sql += ' AND key = ?';
      params.push(key);
    }

    sql += ' ORDER BY confidence DESC, updated_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row): ProjectKnowledge => ({
      id: row.id as string,
      projectPath: row.project_path as string,
      key: row.key as string,
      value: parseJsonString(row.value),
      source: row.source as ProjectKnowledge['source'],
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  getAllProjectKnowledge(): ProjectKnowledge[] {
    const stmt = this.db.prepare(
      'SELECT * FROM project_knowledge ORDER BY updated_at DESC'
    );
    const rows = stmt.all() as SQLiteRow[];

    return rows.map((row): ProjectKnowledge => ({
      id: row.id as string,
      projectPath: row.project_path as string,
      key: row.key as string,
      value: parseJsonString(row.value),
      source: row.source as ProjectKnowledge['source'],
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  updateProjectKnowledge(id: string, content: string): boolean {
    const stmt = this.db.prepare(`
      UPDATE project_knowledge
      SET value = ?, updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(JSON.stringify(content), Date.now(), id);
    return result.changes > 0;
  }

  deleteProjectKnowledge(id: string): boolean {
    const stmt = this.db.prepare('DELETE FROM project_knowledge WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteProjectKnowledgeBySource(source: string): number {
    const stmt = this.db.prepare('DELETE FROM project_knowledge WHERE source = ?');
    const result = stmt.run(source);
    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Audit Log
  // --------------------------------------------------------------------------

  logAuditEvent(
    eventType: string,
    eventData: Record<string, unknown>,
    sessionId?: string
  ): void {
    const stmt = this.db.prepare(`
      INSERT INTO audit_log (session_id, event_type, event_data, created_at)
      VALUES (?, ?, ?, ?)
    `);

    stmt.run(sessionId || null, eventType, JSON.stringify(eventData), Date.now());
  }

  getAuditLog(
    options: {
      sessionId?: string;
      eventType?: string;
      limit?: number;
      since?: number;
    } = {}
  ): Array<{ id: number; sessionId: string | null; eventType: string; eventData: Record<string, unknown>; createdAt: number }> {
    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: unknown[] = [];

    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }

    if (options.eventType) {
      sql += ' AND event_type = ?';
      params.push(options.eventType);
    }

    if (options.since) {
      sql += ' AND created_at > ?';
      params.push(options.since);
    }

    sql += ' ORDER BY created_at DESC';

    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row) => ({
      id: row.id as number,
      sessionId: row.session_id as string | null,
      eventType: row.event_type as string,
      eventData: parseJsonRecord(row.event_data),
      createdAt: row.created_at as number,
    }));
  }

  // --------------------------------------------------------------------------
  // Tool Execution Cache
  // --------------------------------------------------------------------------

  private hashArguments(
    cacheNamespace: string,
    toolName: string,
    args: Record<string, unknown>,
  ): string {
    const canonicalArguments = JSON.stringify(canonicalizeCacheValue(args));
    const digest = createHash('sha256')
      .update(cacheNamespace)
      .update('\0')
      .update(toolName)
      .update('\0')
      .update(canonicalArguments)
      .digest('hex');
    return `tool-cache:v2:${digest}`;
  }

  saveToolExecution(
    sessionId: string,
    messageId: string | null,
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    cacheNamespace: string,
    ttlMs?: number,
  ): void {
    if (!sessionId || !isVersionedCacheNamespace(cacheNamespace)) return;
    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : null;

    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, message_id, tool_name, arguments, arguments_hash, result, success, duration, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      `te_${now}_${Math.random().toString(36).substring(2, 11)}`,
      sessionId,
      messageId,
      toolName,
      JSON.stringify(args),
      this.hashArguments(cacheNamespace, toolName, args),
      JSON.stringify(result),
      result.success ? 1 : 0,
      result.duration || 0,
      now,
      expiresAt
    );
  }

  getCachedToolResult(
    sessionId: string,
    cacheNamespace: string,
    toolName: string,
    args: Record<string, unknown>
  ): ToolResult | null {
    if (!sessionId || !isVersionedCacheNamespace(cacheNamespace)) return null;
    const hash = this.hashArguments(cacheNamespace, toolName, args);
    const now = Date.now();

    const stmt = this.db.prepare(`
      SELECT result FROM tool_executions
      WHERE session_id = ? AND arguments_hash = ? AND tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = stmt.get(sessionId, hash, toolName, now) as SQLiteRow | undefined;
    if (!row) return null;

    return parseToolResult(row.result);
  }

  invalidateCachedToolResults(sessionId: string): number {
    if (!sessionId) return 0;
    const stmt = this.db.prepare(`
      DELETE FROM tool_executions
      WHERE session_id = ? AND arguments_hash LIKE 'tool-cache:v2:%'
    `);
    return stmt.run(sessionId).changes;
  }

  cleanExpiredCache(): number {
    const stmt = this.db.prepare(`
      DELETE FROM tool_executions
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    const result = stmt.run(Date.now());
    return result.changes;
  }

  clearToolCache(): number {
    const stmt = this.db.prepare('DELETE FROM tool_executions');
    const result = stmt.run();
    return result.changes;
  }

  getToolCacheCount(): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tool_executions');
    const row = stmt.get() as SQLiteRow | undefined;
    return (row?.count as number) || 0;
  }
}
