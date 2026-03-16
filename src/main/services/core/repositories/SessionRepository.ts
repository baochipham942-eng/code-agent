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
} from '../../../../shared/types';
import { createLogger } from '../../infra/logger';

const logger = createLogger('SessionRepository');

// SQLite 行类型
type SQLiteRow = Record<string, unknown>;

export interface StoredSession extends Session {
  messageCount: number;
  isDeleted?: boolean;
}

export interface StoredMessage extends Message {
  sessionId: string;
}

type SyncOrigin = 'local' | 'remote';

interface SessionWriteOptions {
  syncOrigin?: SyncOrigin;
}

interface MessageWriteOptions {
  skipTimestampUpdate?: boolean;
  syncOrigin?: SyncOrigin;
  syncedAt?: number | null;
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
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at, workspace, status, last_token_usage, is_deleted, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)
    `);

    stmt.run(
      session.id,
      session.title,
      session.generationId,
      session.modelConfig.provider,
      session.modelConfig.model,
      session.workingDirectory || null,
      session.createdAt,
      session.updatedAt,
      session.workspace || null,
      session.status || 'idle',
      session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null
    );
  }

  createSessionWithId(
    id: string,
    data: {
      title: string;
      generationId?: string;
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
      data.generationId,
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
      updates.generationId ?? null,
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
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results, attachments, thinking, effort_level, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      this.resolveSyncedAt(options)
    );

    if (!options?.skipTimestampUpdate) {
      this.db.prepare('UPDATE sessions SET updated_at = ?, synced_at = NULL WHERE id = ?').run(Date.now(), sessionId);
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
    };
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[]): void {
    const now = Date.now();

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
      generationId: row.generation_id as string,
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
    };
  }
}
