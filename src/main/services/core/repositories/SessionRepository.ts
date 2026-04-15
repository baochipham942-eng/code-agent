// ============================================================================
// SessionRepository - 会话 CRUD（sessions 表 + messages 表 + todos 表）
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import type {
  Session,
  SessionStatus,
  TokenUsage,
  Message,
  ModelProvider,
  TodoItem,
} from '../../../../shared/contract';
import { createLogger } from '../../infra/logger';
import type { StoredSession, StoredMessage } from '../../../protocol/types';

export type { StoredSession, StoredMessage };

const logger = createLogger('SessionRepository');

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

type SyncOrigin = 'local' | 'remote';

interface SessionWriteOptions {
  syncOrigin?: SyncOrigin;
}

interface MessageWriteOptions {
  skipTimestampUpdate?: boolean;
  syncOrigin?: SyncOrigin;
  syncedAt?: number | null;
  updatedAt?: number;
}

export class SessionRepository {
  constructor(private db: BetterSqlite3.Database) {}

  private normalizeTimestamp(value: number | string | undefined, fallback: number): number {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }

    if (typeof value === 'string') {
      const parsed = Date.parse(value);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return fallback;
  }

  private resolveSyncedAt(options?: SessionWriteOptions | MessageWriteOptions): number | null {
    if (options && 'syncedAt' in options && options.syncedAt !== undefined) {
      return options.syncedAt;
    }
    return options?.syncOrigin === 'remote' ? Date.now() : null;
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  createSession(session: Session): void {
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at, workspace, status, last_token_usage, is_deleted, synced_at, git_branch)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?)
    `);

    stmt.run(
      session.id,
      session.title,
      null, // generation_id column kept for historical compatibility
      session.modelConfig.provider,
      session.modelConfig.model,
      session.workingDirectory || null,
      session.createdAt,
      session.updatedAt,
      session.workspace || null,
      session.status || 'idle',
      session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null,
      session.gitBranch || null
    );
  }

  createSessionWithId(
    id: string,
    data: {
      title: string;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
      createdAt?: number | string;
      updatedAt?: number | string;
      isDeleted?: boolean;
    },
    options?: SessionWriteOptions
  ): void {
    const now = Date.now();
    const createdAt = this.normalizeTimestamp(data.createdAt, now);
    const updatedAt = this.normalizeTimestamp(data.updatedAt, createdAt);
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at, is_deleted, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.title,
      null, // generation_id column kept for historical compatibility
      data.modelConfig.provider,
      data.modelConfig.model,
      data.workingDirectory || null,
      createdAt,
      updatedAt,
      data.isDeleted ? 1 : 0,
      this.resolveSyncedAt(options)
    );
  }

  getSession(sessionId: string, options?: { includeDeleted?: boolean }): StoredSession | null {
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.id = ? AND (? = 1 OR s.is_deleted = 0)
      GROUP BY s.id
    `);

    const row = stmt.get(sessionId, options?.includeDeleted ? 1 : 0) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false): StoredSession[] {
    const filters = ['s.is_deleted = 0'];
    if (!includeArchived) {
      filters.push("s.status != 'archived'");
    }
    const whereClause = `WHERE ${filters.join(' AND ')}`;
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      ${whereClause}
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as SQLiteRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>, options?: SessionWriteOptions & { isDeleted?: boolean }): void {
    // Use COALESCE to avoid read-before-write: only update fields that are provided
    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = COALESCE(?, title),
          generation_id = COALESCE(?, generation_id),
          model_provider = COALESCE(?, model_provider),
          model_name = COALESCE(?, model_name),
          working_directory = COALESCE(?, working_directory),
          updated_at = COALESCE(?, updated_at),
          workspace = COALESCE(?, workspace),
          status = COALESCE(?, status),
          last_token_usage = COALESCE(?, last_token_usage),
          is_deleted = COALESCE(?, is_deleted),
          synced_at = COALESCE(?, synced_at)
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined
      ? JSON.stringify(updates.lastTokenUsage)
      : null; // null means keep existing via COALESCE

    const result = stmt.run(
      updates.title ?? null,
      null, // generation_id column kept for historical compatibility
      updates.modelConfig?.provider ?? null,
      updates.modelConfig?.model ?? null,
      updates.workingDirectory ?? null,
      updates.updatedAt ?? Date.now(),
      updates.workspace !== undefined ? updates.workspace : null,
      updates.status ?? null,
      lastTokenUsage,
      options?.isDeleted !== undefined ? (options.isDeleted ? 1 : 0) : null,
      this.resolveSyncedAt(options) ?? null,
      sessionId
    );

    if (result.changes === 0) throw new Error(`Session not found: ${sessionId}`);
  }

  deleteSession(sessionId: string, options?: SessionWriteOptions & { deletedAt?: number }): void {
    const deletedAt = options?.deletedAt ?? Date.now();
    this.db.prepare(`
      UPDATE sessions
      SET is_deleted = 1, updated_at = ?, synced_at = ?
      WHERE id = ?
    `).run(deletedAt, this.resolveSyncedAt(options), sessionId);
  }

  clearAllSessions(): number {
    const stmt = this.db.prepare('DELETE FROM sessions');
    const result = stmt.run();
    return result.changes;
  }

  clearAllMessages(): number {
    const stmt = this.db.prepare('DELETE FROM messages');
    const result = stmt.run();
    return result.changes;
  }

  hasMessages(sessionId: string): boolean {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return ((row?.count as number) || 0) > 0;
  }

  getLocalCacheStats(): { sessionCount: number; messageCount: number } {
    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;

    return { sessionCount: sessionRow.c as number, messageCount: messageRow.c as number };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message, options?: MessageWriteOptions): void {
    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results, attachments, thinking, effort_level, synced_at, content_parts)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const attachmentsMeta = message.attachments?.map(a => ({
      id: a.id,
      type: a.type,
      category: a.category,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      path: a.path,
      pageCount: a.pageCount,
      language: a.language,
    }));

    const thinkingContent = message.thinking || message.reasoning || null;

    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null,
      attachmentsMeta ? JSON.stringify(attachmentsMeta) : null,
      thinkingContent,
      message.effortLevel || null,
      this.resolveSyncedAt(options),
      message.contentParts ? JSON.stringify(message.contentParts) : null
    );

    if (!options?.skipTimestampUpdate) {
      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(options?.updatedAt ?? Date.now(), sessionId);
    }
  }

  updateMessage(messageId: string, updates: Partial<Message>): void {
    const setClauses: string[] = [];
    const values: unknown[] = [];

    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.toolCalls !== undefined) {
      setClauses.push('tool_calls = ?');
      values.push(JSON.stringify(updates.toolCalls));
    }
    if (updates.toolResults !== undefined) {
      setClauses.push('tool_results = ?');
      values.push(JSON.stringify(updates.toolResults));
    }

    if (setClauses.length === 0) return;

    // Mark as unsynced so pushToCloud picks up the update
    setClauses.push('synced_at = NULL');

    values.push(messageId);
    const sql = `UPDATE messages SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
  }

  getMessages(sessionId: string, limit?: number, offset?: number): Message[] {
    let sql = `
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `;

    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
      if (offset !== undefined) {
        sql += ` OFFSET ${offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row) => this.rowToMessage(row));
  }

  getMessageCount(sessionId: string): number {
    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return (row?.count as number) || 0;
  }

  getRecentMessages(sessionId: string, count: number): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as SQLiteRow[];

    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  getMessagesBefore(sessionId: string, beforeTimestamp: number, limit: number = 30): Message[] {
    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ? AND timestamp < ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, beforeTimestamp, limit) as SQLiteRow[];

    return rows.reverse().map((row) => this.rowToMessage(row));
  }

  // --------------------------------------------------------------------------
  // Episodic FTS search (Workstream D)
  // --------------------------------------------------------------------------

  /**
   * 用 FTS5 全文检索历史会话消息。
   *
   * - 触发器自动同步 messages → session_messages_fts，应用层无感
   * - 按相关性排序（BM25 rank），最近优先作为 tie-breaker
   * - sessionId 过滤可选，限定在当前 session 内搜索
   * - trigram tokenizer 要求查询至少 3 个字符
   * - 默认把查询包成 phrase literal（双引号），避开 `-` / `:` 等 FTS5 运算符；
   *   用户若显式以 `"` 开头则原样透传，保留高级 FTS5 语法
   */
  searchSessionMessagesFts(
    query: string,
    options: {
      limit?: number;
      sessionId?: string;
    } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    const trimmed = query.trim();
    if (trimmed.length < 3) {
      return [];
    }

    const ftsQuery = normalizeFtsQuery(trimmed);
    const limit = Math.max(1, Math.min(options.limit ?? 10, 50));
    const params: unknown[] = [ftsQuery];
    let whereSession = '';
    if (options.sessionId) {
      whereSession = 'AND session_id = ?';
      params.push(options.sessionId);
    }
    params.push(limit);

    try {
      const rows = this.db
        .prepare(
          `
          SELECT message_id, session_id, role, content, timestamp
          FROM session_messages_fts
          WHERE content MATCH ? ${whereSession}
          ORDER BY rank, timestamp DESC
          LIMIT ?
          `,
        )
        .all(...params) as SQLiteRow[];

      return rows.map((row) => ({
        messageId: String(row.message_id ?? ''),
        sessionId: String(row.session_id ?? ''),
        role: String(row.role ?? ''),
        content: String(row.content ?? ''),
        timestamp: Number(row.timestamp ?? 0),
      }));
    } catch (err) {
      logger.warn('[EpisodicFts] search failed', { query: trimmed, error: err });
      return [];
    }
  }

  /**
   * Backfill session_messages_fts from an existing messages table.
   * 只在 FTS 表为空、且 messages 表非空时执行（典型场景：升级后首次启动）。
   * 返回 backfill 的行数；幂等且可重复调用。
   */
  backfillSessionMessagesFts(): number {
    try {
      const ftsRow = this.db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as
        | { c: number }
        | undefined;
      const msgRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as
        | { c: number }
        | undefined;
      const ftsCount = Number(ftsRow?.c ?? 0);
      const msgCount = Number(msgRow?.c ?? 0);

      if (ftsCount > 0 || msgCount === 0) {
        return 0;
      }

      logger.info(`[EpisodicFts] Backfilling FTS from ${msgCount} messages...`);
      const result = this.db
        .prepare(
          `
          INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
          SELECT id, session_id, role, COALESCE(content, ''), timestamp
          FROM messages
          `,
        )
        .run();
      const inserted = Number(result.changes ?? 0);
      logger.info(`[EpisodicFts] Backfill complete: ${inserted} rows`);
      return inserted;
    } catch (err) {
      logger.warn('[EpisodicFts] Backfill failed (non-blocking)', { error: err });
      return 0;
    }
  }

  getUnsyncedSessions(limit: number = 1000): StoredSession[] {
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.synced_at IS NULL
      GROUP BY s.id
      ORDER BY s.updated_at ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as SQLiteRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  markSessionsSynced(sessionIds: string[]): void {
    if (sessionIds.length === 0) return;
    const now = Date.now();
    const placeholders = sessionIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE sessions SET synced_at = ? WHERE id IN (${placeholders})`).run(now, ...sessionIds);
  }

  getUnsyncedMessages(limit: number = 1000): Array<Message & { sessionId: string }> {
    const stmt = this.db.prepare(`
      SELECT m.*
      FROM messages m
      JOIN sessions s ON s.id = m.session_id
      WHERE m.synced_at IS NULL AND s.is_deleted = 0
      ORDER BY m.timestamp ASC
      LIMIT ?
    `);

    const rows = stmt.all(limit) as SQLiteRow[];
    return rows.map((row) => ({
      ...this.rowToMessage(row),
      sessionId: row.session_id as string,
    }));
  }

  markMessagesSynced(messageIds: string[]): void {
    if (messageIds.length === 0) return;
    const now = Date.now();
    const placeholders = messageIds.map(() => '?').join(',');
    this.db.prepare(`UPDATE messages SET synced_at = ? WHERE id IN (${placeholders})`).run(now, ...messageIds);
  }

  private rowToMessage(row: SQLiteRow): Message {
    return {
      id: row.id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : undefined,
      attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
      thinking: (row.thinking as string) || undefined,
      effortLevel: (row.effort_level as Message['effortLevel']) || undefined,
      contentParts: row.content_parts ? JSON.parse(row.content_parts as string) : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Message Truncation (for checkpoint fork)
  // --------------------------------------------------------------------------

  /**
   * Delete all messages after a given message (by timestamp).
   * Used by checkpoint:fork to truncate conversation history.
   */
  truncateMessagesAfter(sessionId: string, messageId: string): number {
    const msg = this.db.prepare(
      'SELECT timestamp FROM messages WHERE id = ? AND session_id = ?'
    ).get(messageId, sessionId) as { timestamp: number } | undefined;

    if (!msg) return 0;

    const result = this.db.prepare(
      'DELETE FROM messages WHERE session_id = ? AND timestamp > ?'
    ).run(sessionId, msg.timestamp);

    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[], updatedAt?: number): void {
    const now = updatedAt ?? Date.now();

    const saveFn = this.db.transaction(() => {
      this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

      const stmt = this.db.prepare(`
        INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
      `);

      for (const todo of todos) {
        stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
      }
    });

    saveFn();
  }

  getTodos(sessionId: string): TodoItem[] {
    const stmt = this.db.prepare(`
      SELECT content, status, active_form FROM todos
      WHERE session_id = ?
      ORDER BY id ASC
    `);

    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row): TodoItem => ({
      content: row.content as string,
      status: row.status as TodoItem['status'],
      activeForm: row.active_form as string,
    }));
  }

  // --------------------------------------------------------------------------
  // Session Archive
  // --------------------------------------------------------------------------

  listArchivedSessions(limit: number = 50, offset: number = 0): StoredSession[] {
    const rows = this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
      FROM sessions s
      WHERE s.status = 'archived' AND s.is_deleted = 0
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as SQLiteRow[];

    return rows.map(row => this.rowToSession(row));
  }

  archiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`).run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  unarchiveSession(sessionId: string, updatedAt?: number): StoredSession | null {
    this.db.prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`).run(updatedAt ?? Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  // --------------------------------------------------------------------------
  // Session Events
  // --------------------------------------------------------------------------

  // Note: session_events table methods are in TelemetryRepository

  // --------------------------------------------------------------------------
  // Private Helpers
  // --------------------------------------------------------------------------

  private rowToSession(row: SQLiteRow): StoredSession {
    let lastTokenUsage: TokenUsage | undefined;
    if (row.last_token_usage) {
      try {
        lastTokenUsage = JSON.parse(row.last_token_usage as string);
      } catch (err: unknown) {
        logger.warn('[DB] Failed to parse last_token_usage JSON:', err instanceof Error ? err.message : String(err));
      }
    }

    const isArchived = row.status === 'archived';
    const isDeleted = Boolean(row.is_deleted);

    return {
      id: row.id as string,
      title: row.title as string,
      modelConfig: {
        provider: row.model_provider as ModelProvider,
        model: row.model_name as string,
      },
      workingDirectory: row.working_directory as string | undefined,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      messageCount: (row.message_count as number) || 0,
      workspace: row.workspace as string | undefined,
      status: (row.status as SessionStatus) || 'idle',
      lastTokenUsage,
      isArchived,
      archivedAt: isArchived ? (row.updated_at as number) : undefined,
      isDeleted,
      gitBranch: row.git_branch as string | undefined,
    };
  }
}

// ----------------------------------------------------------------------------
// FTS query helper
// ----------------------------------------------------------------------------

/**
 * 把用户查询归一化成 FTS5 安全的表达式。
 *
 * - 以 `"` 开头表示用户知道自己在写 FTS5 语法（phrase / prefix / operators），
 *   直接原样透传
 * - 否则把整个查询包成 phrase literal：双引号包裹 + 内部 `"` 转义为 `""`
 *   → 避开 `-` `+` `:` 等 FTS5 操作符被误解释
 */
function normalizeFtsQuery(raw: string): string {
  if (raw.startsWith('"')) {
    return raw;
  }
  return '"' + raw.replace(/"/g, '""') + '"';
}
