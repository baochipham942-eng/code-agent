// ============================================================================
// CLI Database Service - 独立于 Electron 的数据库层
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import Database from 'better-sqlite3';
import type {
  Session,
  SessionStatus,
  Message,
  ToolResult,
  GenerationId,
  ModelProvider,
  TodoItem,
  TokenUsage,
} from '../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface StoredSession extends Session {
  messageCount: number;
}

type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// CLI Database Service
// ----------------------------------------------------------------------------

export class CLIDatabaseService {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor() {
    const dataDir = this.getDataDir();
    this.dbPath = path.join(dataDir, 'code-agent.db');
  }

  /**
   * 获取数据目录
   */
  private getDataDir(): string {
    const dataDir = process.env.CODE_AGENT_DATA_DIR || path.join(os.homedir(), '.code-agent');
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    return dataDir;
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.migrateSessionsTable();
    this.createIndexes();
  }

  private migrateSessionsTable(): void {
    if (!this.db) return;

    const migrations = [
      { column: 'status', sql: "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'idle'" },
      { column: 'workspace', sql: 'ALTER TABLE sessions ADD COLUMN workspace TEXT' },
      { column: 'last_token_usage', sql: 'ALTER TABLE sessions ADD COLUMN last_token_usage TEXT' },
    ];

    for (const migration of migrations) {
      try {
        this.db.exec(migration.sql);
      } catch {
        // 列已存在，忽略
      }
    }
  }

  private createTables(): void {
    if (!this.db) return;

    // Sessions 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        working_directory TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Messages 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        tool_calls TEXT,
        tool_results TEXT,
        attachments TEXT,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
    } catch {
      // 列已存在
    }

    // Tool Executions 表 (缓存)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS tool_executions (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT,
        tool_name TEXT NOT NULL,
        arguments TEXT NOT NULL,
        arguments_hash TEXT NOT NULL,
        result TEXT NOT NULL,
        success INTEGER NOT NULL,
        duration INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Todos 表
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL,
        active_form TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);
  }

  private createIndexes(): void {
    if (!this.db) return;

    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
      CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_hash ON tool_executions(arguments_hash);
      CREATE INDEX IF NOT EXISTS idx_tool_executions_expires ON tool_executions(expires_at);
      CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
      CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp DESC);
    `);
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  createSession(session: Session): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at, workspace, status, last_token_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

  getSession(sessionId: string): StoredSession | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.id = ?
      GROUP BY s.id
    `);

    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessions(limit: number = 50, offset: number = 0): StoredSession[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      WHERE s.status != 'archived'
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as SQLiteRow[];
    return rows.map((row) => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    if (!this.db) throw new Error('Database not initialized');

    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, generation_id = ?, model_provider = ?, model_name = ?,
          working_directory = ?, updated_at = ?, workspace = ?, status = ?, last_token_usage = ?
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined
      ? JSON.stringify(updates.lastTokenUsage)
      : (session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null);

    stmt.run(
      updates.title ?? session.title,
      updates.generationId ?? session.generationId,
      updates.modelConfig?.provider ?? session.modelConfig.provider,
      updates.modelConfig?.model ?? session.modelConfig.model,
      updates.workingDirectory ?? session.workingDirectory,
      Date.now(),
      updates.workspace !== undefined ? updates.workspace : session.workspace,
      updates.status ?? session.status ?? 'idle',
      lastTokenUsage,
      sessionId
    );
  }

  deleteSession(sessionId: string): void {
    if (!this.db) throw new Error('Database not initialized');
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  private rowToSession(row: SQLiteRow): StoredSession {
    let lastTokenUsage: TokenUsage | undefined;
    if (row.last_token_usage) {
      try {
        lastTokenUsage = JSON.parse(row.last_token_usage as string);
      } catch {
        // 忽略解析错误
      }
    }

    return {
      id: row.id as string,
      title: row.title as string,
      generationId: row.generation_id as GenerationId,
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
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results, attachments)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const attachmentsMeta = message.attachments?.map(a => ({
      id: a.id,
      type: a.type,
      category: a.category,
      name: a.name,
      size: a.size,
      mimeType: a.mimeType,
      path: a.path,
    }));

    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null,
      attachmentsMeta ? JSON.stringify(attachmentsMeta) : null
    );

    // 更新 session 的 updated_at
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  getMessages(sessionId: string, limit?: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    let sql = `
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
    `;

    if (limit !== undefined) {
      sql += ` LIMIT ${limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row): Message => ({
      id: row.id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : undefined,
      attachments: row.attachments ? JSON.parse(row.attachments as string) : undefined,
    }));
  }

  getRecentMessages(sessionId: string, count: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as SQLiteRow[];

    return rows.reverse().map((row): Message => ({
      id: row.id as string,
      role: row.role as Message['role'],
      content: row.content as string,
      timestamp: row.timestamp as number,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls as string) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results as string) : undefined,
    }));
  }

  // --------------------------------------------------------------------------
  // Tool Cache
  // --------------------------------------------------------------------------

  private hashArguments(toolName: string, args: Record<string, unknown>): string {
    const str = `${toolName}:${JSON.stringify(args)}`;
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
      const char = str.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  }

  saveToolExecution(
    sessionId: string,
    messageId: string | null,
    toolName: string,
    args: Record<string, unknown>,
    result: ToolResult,
    ttlMs?: number
  ): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const expiresAt = ttlMs ? now + ttlMs : null;

    const stmt = this.db.prepare(`
      INSERT INTO tool_executions (id, session_id, message_id, tool_name, arguments, arguments_hash, result, success, duration, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      `te_${now}_${Math.random().toString(36).substr(2, 9)}`,
      sessionId,
      messageId,
      toolName,
      JSON.stringify(args),
      this.hashArguments(toolName, args),
      JSON.stringify(result),
      result.success ? 1 : 0,
      result.duration || 0,
      now,
      expiresAt
    );
  }

  getCachedToolResult(toolName: string, args: Record<string, unknown>): ToolResult | null {
    if (!this.db) throw new Error('Database not initialized');

    const hash = this.hashArguments(toolName, args);
    const now = Date.now();

    const stmt = this.db.prepare(`
      SELECT result FROM tool_executions
      WHERE arguments_hash = ? AND tool_name = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY created_at DESC
      LIMIT 1
    `);

    const row = stmt.get(hash, toolName, now) as SQLiteRow | undefined;
    if (!row) return null;

    return JSON.parse(row.result as string);
  }

  cleanExpiredCache(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      DELETE FROM tool_executions
      WHERE expires_at IS NOT NULL AND expires_at < ?
    `);

    const result = stmt.run(Date.now());
    return result.changes;
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[]): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

    const stmt = this.db.prepare(`
      INSERT INTO todos (session_id, content, status, active_form, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    for (const todo of todos) {
      stmt.run(sessionId, todo.content, todo.status, todo.activeForm, now, now);
    }
  }

  getTodos(sessionId: string): TodoItem[] {
    if (!this.db) throw new Error('Database not initialized');

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
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolExecutionCount: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as SQLiteRow;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
    };
  }
}

// ----------------------------------------------------------------------------
// Singleton
// ----------------------------------------------------------------------------

let dbInstance: CLIDatabaseService | null = null;

export function getCLIDatabase(): CLIDatabaseService {
  if (!dbInstance) {
    dbInstance = new CLIDatabaseService();
  }
  return dbInstance;
}

export async function initCLIDatabase(): Promise<CLIDatabaseService> {
  const db = getCLIDatabase();
  await db.initialize();
  return db;
}
