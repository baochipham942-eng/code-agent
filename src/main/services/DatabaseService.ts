// ============================================================================
// Database Service - SQLite 数据持久化层
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import Database from 'better-sqlite3';
import type {
  Session,
  Message,
  ToolResult,
  GenerationId,
  ModelProvider,
  TodoItem,
} from '../../shared/types';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

export interface StoredSession extends Session {
  messageCount: number;
}

export interface StoredMessage extends Message {
  sessionId: string;
}

export interface ToolExecution {
  id: string;
  sessionId: string;
  messageId: string;
  toolName: string;
  arguments: string; // JSON
  result: string; // JSON
  success: boolean;
  duration: number;
  createdAt: number;
}

export interface UserPreference {
  key: string;
  value: string;
  updatedAt: number;
}

export interface ProjectKnowledge {
  id: string;
  projectPath: string;
  key: string;
  value: string;
  source: 'learned' | 'explicit' | 'inferred';
  confidence: number;
  createdAt: number;
  updatedAt: number;
}

// ----------------------------------------------------------------------------
// Database Service
// ----------------------------------------------------------------------------

export class DatabaseService {
  private db: Database.Database | null = null;
  private dbPath: string;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.dbPath = path.join(userDataPath, 'code-agent.db');
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // 确保目录存在
    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.createIndexes();
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
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Tool Executions 表 (用于缓存和审计)
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

    // User Preferences 表 (用户偏好学习)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_preferences (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Project Knowledge 表 (项目知识库)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS project_knowledge (
        id TEXT PRIMARY KEY,
        project_path TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        source TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(project_path, key)
      )
    `);

    // Todos 表 (待办事项持久化)
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

    // Audit Log 表 (审计日志)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT,
        event_type TEXT NOT NULL,
        event_data TEXT NOT NULL,
        created_at INTEGER NOT NULL
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
      CREATE INDEX IF NOT EXISTS idx_project_knowledge_path ON project_knowledge(project_path);
      CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);
      CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log(event_type);
    `);
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  createSession(session: Session): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.title,
      session.generationId,
      session.modelConfig.provider,
      session.modelConfig.model,
      session.workingDirectory || null,
      session.createdAt,
      session.updatedAt
    );
  }

  /**
   * Create a session with a specific ID (for sync from cloud)
   */
  createSessionWithId(
    id: string,
    data: {
      title: string;
      generationId: GenerationId;
      modelConfig: { provider: ModelProvider; model: string };
      workingDirectory?: string;
    }
  ): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const stmt = this.db.prepare(`
      INSERT INTO sessions (id, title, generation_id, model_provider, model_name, working_directory, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      data.title,
      data.generationId,
      data.modelConfig.provider,
      data.modelConfig.model,
      data.workingDirectory || null,
      now,
      now
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

    const row = stmt.get(sessionId) as any;
    if (!row) return null;

    return this.rowToSession(row);
  }

  listSessions(limit: number = 50, offset: number = 0): StoredSession[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      GROUP BY s.id
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `);

    const rows = stmt.all(limit, offset) as any[];
    return rows.map((row) => this.rowToSession(row));
  }

  updateSession(sessionId: string, updates: Partial<Session>): void {
    if (!this.db) throw new Error('Database not initialized');

    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const stmt = this.db.prepare(`
      UPDATE sessions
      SET title = ?, generation_id = ?, model_provider = ?, model_name = ?,
          working_directory = ?, updated_at = ?
      WHERE id = ?
    `);

    stmt.run(
      updates.title ?? session.title,
      updates.generationId ?? session.generationId,
      updates.modelConfig?.provider ?? session.modelConfig.provider,
      updates.modelConfig?.model ?? session.modelConfig.model,
      updates.workingDirectory ?? session.workingDirectory,
      Date.now(),
      sessionId
    );
  }

  deleteSession(sessionId: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(sessionId);
  }

  private rowToSession(row: any): StoredSession {
    return {
      id: row.id,
      title: row.title,
      generationId: row.generation_id as GenerationId,
      modelConfig: {
        provider: row.model_provider as ModelProvider,
        model: row.model_name,
      },
      workingDirectory: row.working_directory,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      messageCount: row.message_count || 0,
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      message.id,
      sessionId,
      message.role,
      message.content,
      message.timestamp,
      message.toolCalls ? JSON.stringify(message.toolCalls) : null,
      message.toolResults ? JSON.stringify(message.toolResults) : null
    );

    // 更新 session 的 updated_at
    this.db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  getMessages(sessionId: string, limit?: number, offset?: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

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
    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
    }));
  }

  getMessageCount(sessionId: string): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as any;
    return row?.count || 0;
  }

  getRecentMessages(sessionId: string, count: number): Message[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      SELECT * FROM messages
      WHERE session_id = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(sessionId, count) as any[];

    return rows.reverse().map((row) => ({
      id: row.id,
      role: row.role,
      content: row.content,
      timestamp: row.timestamp,
      toolCalls: row.tool_calls ? JSON.parse(row.tool_calls) : undefined,
      toolResults: row.tool_results ? JSON.parse(row.tool_results) : undefined,
    }));
  }

  // --------------------------------------------------------------------------
  // Tool Execution Cache
  // --------------------------------------------------------------------------

  /**
   * 生成参数哈希用于缓存查找
   */
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

  /**
   * 从缓存获取工具执行结果
   */
  getCachedToolResult(
    toolName: string,
    args: Record<string, unknown>
  ): ToolResult | null {
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

    const row = stmt.get(hash, toolName, now) as any;
    if (!row) return null;

    return JSON.parse(row.result);
  }

  /**
   * 清理过期缓存
   */
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
  // User Preferences
  // --------------------------------------------------------------------------

  setPreference(key: string, value: unknown): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO user_preferences (key, value, updated_at)
      VALUES (?, ?, ?)
    `);

    stmt.run(key, JSON.stringify(value), Date.now());
  }

  getPreference<T>(key: string, defaultValue?: T): T | undefined {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT value FROM user_preferences WHERE key = ?');
    const row = stmt.get(key) as any;

    if (!row) return defaultValue;
    return JSON.parse(row.value);
  }

  getAllPreferences(): Record<string, unknown> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT key, value FROM user_preferences');
    const rows = stmt.all() as any[];

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key] = JSON.parse(row.value);
    }
    return result;
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
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const id = `pk_${now}_${Math.random().toString(36).substr(2, 9)}`;

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
    if (!this.db) throw new Error('Database not initialized');

    let sql = 'SELECT * FROM project_knowledge WHERE project_path = ?';
    const params: any[] = [projectPath];

    if (key) {
      sql += ' AND key = ?';
      params.push(key);
    }

    sql += ' ORDER BY confidence DESC, updated_at DESC';

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      id: row.id,
      projectPath: row.project_path,
      key: row.key,
      value: JSON.parse(row.value),
      source: row.source,
      confidence: row.confidence,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  // --------------------------------------------------------------------------
  // Todos
  // --------------------------------------------------------------------------

  saveTodos(sessionId: string, todos: TodoItem[]): void {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();

    // 删除旧的 todos
    this.db.prepare('DELETE FROM todos WHERE session_id = ?').run(sessionId);

    // 插入新的 todos
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

    const rows = stmt.all(sessionId) as any[];

    return rows.map((row) => ({
      content: row.content,
      status: row.status,
      activeForm: row.active_form,
    }));
  }

  // --------------------------------------------------------------------------
  // Audit Log
  // --------------------------------------------------------------------------

  logAuditEvent(
    eventType: string,
    eventData: Record<string, unknown>,
    sessionId?: string
  ): void {
    if (!this.db) throw new Error('Database not initialized');

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
  ): Array<{ id: number; sessionId: string | null; eventType: string; eventData: any; createdAt: number }> {
    if (!this.db) throw new Error('Database not initialized');

    let sql = 'SELECT * FROM audit_log WHERE 1=1';
    const params: any[] = [];

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
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      id: row.id,
      sessionId: row.session_id,
      eventType: row.event_type,
      eventData: JSON.parse(row.event_data),
      createdAt: row.created_at,
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

  /**
   * 获取数据库统计信息
   */
  getStats(): {
    sessionCount: number;
    messageCount: number;
    toolExecutionCount: number;
    knowledgeCount: number;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionCount = (this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as any).c;
    const messageCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as any).c;
    const toolExecutionCount = (this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as any).c;
    const knowledgeCount = (this.db.prepare('SELECT COUNT(*) as c FROM project_knowledge').get() as any).c;

    return { sessionCount, messageCount, toolExecutionCount, knowledgeCount };
  }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
  }
  return dbInstance;
}

export async function initDatabase(): Promise<DatabaseService> {
  const db = getDatabase();
  await db.initialize();
  return db;
}
