// ============================================================================
// Database Service - SQLite 数据持久化层
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import Database from 'better-sqlite3';
import type {
  Session,
  SessionStatus,
  TokenUsage,
  Message,
  ToolResult,
  GenerationId,
  ModelProvider,
  TodoItem,
} from '../../../shared/types';

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

/**
 * Memory 记录类型 - 用于记忆可视化
 * 支持用户偏好、代码模式、项目知识等多种类型
 */
export interface MemoryRecord {
  id: string;
  type: 'user_preference' | 'code_pattern' | 'project_knowledge' | 'conversation' | 'tool_usage';
  category: string;
  content: string;
  summary: string;
  source: 'auto_learned' | 'user_defined' | 'session_extracted';
  projectPath: string | null;
  sessionId: string | null;
  confidence: number;
  accessCount: number;
  lastAccessedAt: number | null;
  createdAt: number;
  updatedAt: number;
  metadata: Record<string, unknown>;
}

// SQLite 行类型（better-sqlite3 返回的原始行结构）
// 使用 Record<string, unknown> 代替 any，但具体字段访问仍需类型断言
type SQLiteRow = Record<string, unknown>;

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
    this.migrateSessionsTable();
    this.createIndexes();
  }

  /**
   * Sessions 表迁移 - 添加 Wave 3 新字段
   * 使用 try-catch 模式，列已存在时静默忽略
   */
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

    // 迁移：为旧表添加 attachments 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN attachments TEXT`);
    } catch {
      // 列已存在，忽略
    }

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

    // Memories 表 (Gen5 记忆可视化)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT NOT NULL,
        source TEXT NOT NULL,
        project_path TEXT,
        session_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        access_count INTEGER NOT NULL DEFAULT 0,
        last_accessed_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
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
      CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
      CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_updated ON memories(updated_at);
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

    // better-sqlite3 返回 unknown 类型的行数据
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

    // 处理 lastTokenUsage：如果更新中有新值则使用，否则保留旧值
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

    const stmt = this.db.prepare('DELETE FROM sessions WHERE id = ?');
    stmt.run(sessionId);
  }

  /**
   * 清空所有本地会话缓存 (用于清空缓存操作)
   * 会话数据可从云端重新拉取
   */
  clearAllSessions(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM sessions');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * 清空所有本地消息缓存 (用于清空缓存操作)
   * 消息数据可从云端重新拉取
   */
  clearAllMessages(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM messages');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * 检查会话是否有本地缓存的消息
   */
  hasMessages(sessionId: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return ((row?.count as number) || 0) > 0;
  }

  /**
   * 获取本地会话和消息统计
   */
  getLocalCacheStats(): { sessionCount: number; messageCount: number } {
    if (!this.db) throw new Error('Database not initialized');

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;

    return { sessionCount: sessionRow.c as number, messageCount: messageRow.c as number };
  }

  private rowToSession(row: SQLiteRow): StoredSession {
    // 解析 lastTokenUsage JSON
    let lastTokenUsage: TokenUsage | undefined;
    if (row.last_token_usage) {
      try {
        lastTokenUsage = JSON.parse(row.last_token_usage as string);
      } catch {
        // 解析失败时忽略
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
      // Wave 3 新字段
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

    // 保存附件元信息（不含 data 和 thumbnail，节省空间）
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

  updateMessage(messageId: string, updates: Partial<Message>): void {
    if (!this.db) throw new Error('Database not initialized');

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

    values.push(messageId);
    const sql = `UPDATE messages SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);
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

  getMessageCount(sessionId: string): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM messages WHERE session_id = ?');
    const row = stmt.get(sessionId) as SQLiteRow | undefined;
    return (row?.count as number) || 0;
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

    const row = stmt.get(hash, toolName, now) as SQLiteRow | undefined;
    if (!row) return null;

    return JSON.parse(row.result as string);
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

  /**
   * 清除所有工具执行缓存 (Level 1 缓存)
   * 用于用户手动清空缓存操作
   */
  clearToolCache(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM tool_executions');
    const result = stmt.run();
    return result.changes;
  }

  /**
   * 获取工具缓存条目数
   */
  getToolCacheCount(): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT COUNT(*) as count FROM tool_executions');
    const row = stmt.get() as SQLiteRow | undefined;
    return (row?.count as number) || 0;
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
    const row = stmt.get(key) as SQLiteRow | undefined;

    if (!row) return defaultValue;
    return JSON.parse(row.value as string);
  }

  getAllPreferences(): Record<string, unknown> {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT key, value FROM user_preferences');
    const rows = stmt.all() as SQLiteRow[];

    const result: Record<string, unknown> = {};
    for (const row of rows) {
      result[row.key as string] = JSON.parse(row.value as string);
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
      value: JSON.parse(row.value as string),
      source: row.source as ProjectKnowledge['source'],
      confidence: row.confidence as number,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
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

    const rows = stmt.all(sessionId) as SQLiteRow[];

    return rows.map((row): TodoItem => ({
      content: row.content as string,
      status: row.status as TodoItem['status'],
      activeForm: row.active_form as string,
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
  ): Array<{ id: number; sessionId: string | null; eventType: string; eventData: Record<string, unknown>; createdAt: number }> {
    if (!this.db) throw new Error('Database not initialized');

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
      eventData: JSON.parse(row.event_data as string),
      createdAt: row.created_at as number,
    }));
  }

  // --------------------------------------------------------------------------
  // Memories CRUD (Gen5 记忆可视化)
  // --------------------------------------------------------------------------

  /**
   * 创建记忆记录
   */
  createMemory(memory: Omit<MemoryRecord, 'id' | 'accessCount' | 'lastAccessedAt' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    if (!this.db) throw new Error('Database not initialized');

    const now = Date.now();
    const id = `mem_${now}_${Math.random().toString(36).substr(2, 9)}`;

    const stmt = this.db.prepare(`
      INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, access_count, last_accessed_at, created_at, updated_at, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      id,
      memory.type,
      memory.category,
      memory.content,
      memory.summary,
      memory.source,
      memory.projectPath,
      memory.sessionId,
      memory.confidence,
      0,
      null,
      now,
      now,
      JSON.stringify(memory.metadata || {})
    );

    return {
      id,
      ...memory,
      accessCount: 0,
      lastAccessedAt: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  /**
   * 获取单个记忆记录
   */
  getMemory(id: string): MemoryRecord | null {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('SELECT * FROM memories WHERE id = ?');
    const row = stmt.get(id) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToMemory(row);
  }

  /**
   * 列出记忆记录（支持过滤和分页）
   */
  listMemories(options: {
    type?: MemoryRecord['type'];
    category?: string;
    source?: MemoryRecord['source'];
    projectPath?: string;
    sessionId?: string;
    limit?: number;
    offset?: number;
    orderBy?: 'created_at' | 'updated_at' | 'access_count' | 'confidence';
    orderDir?: 'ASC' | 'DESC';
  } = {}): MemoryRecord[] {
    if (!this.db) throw new Error('Database not initialized');

    let sql = 'SELECT * FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    if (options.category) {
      sql += ' AND category = ?';
      params.push(options.category);
    }

    if (options.source) {
      sql += ' AND source = ?';
      params.push(options.source);
    }

    if (options.projectPath) {
      sql += ' AND project_path = ?';
      params.push(options.projectPath);
    }

    if (options.sessionId) {
      sql += ' AND session_id = ?';
      params.push(options.sessionId);
    }

    const orderBy = options.orderBy || 'updated_at';
    const orderDir = options.orderDir || 'DESC';
    sql += ` ORDER BY ${orderBy} ${orderDir}`;

    if (options.limit !== undefined) {
      sql += ` LIMIT ${options.limit}`;
      if (options.offset !== undefined) {
        sql += ` OFFSET ${options.offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * 更新记忆记录
   */
  updateMemory(id: string, updates: Partial<Omit<MemoryRecord, 'id' | 'createdAt'>>): MemoryRecord | null {
    if (!this.db) throw new Error('Database not initialized');

    const existing = this.getMemory(id);
    if (!existing) return null;

    const setClauses: string[] = ['updated_at = ?'];
    const values: unknown[] = [Date.now()];

    if (updates.type !== undefined) {
      setClauses.push('type = ?');
      values.push(updates.type);
    }
    if (updates.category !== undefined) {
      setClauses.push('category = ?');
      values.push(updates.category);
    }
    if (updates.content !== undefined) {
      setClauses.push('content = ?');
      values.push(updates.content);
    }
    if (updates.summary !== undefined) {
      setClauses.push('summary = ?');
      values.push(updates.summary);
    }
    if (updates.source !== undefined) {
      setClauses.push('source = ?');
      values.push(updates.source);
    }
    if (updates.projectPath !== undefined) {
      setClauses.push('project_path = ?');
      values.push(updates.projectPath);
    }
    if (updates.sessionId !== undefined) {
      setClauses.push('session_id = ?');
      values.push(updates.sessionId);
    }
    if (updates.confidence !== undefined) {
      setClauses.push('confidence = ?');
      values.push(updates.confidence);
    }
    if (updates.accessCount !== undefined) {
      setClauses.push('access_count = ?');
      values.push(updates.accessCount);
    }
    if (updates.lastAccessedAt !== undefined) {
      setClauses.push('last_accessed_at = ?');
      values.push(updates.lastAccessedAt);
    }
    if (updates.metadata !== undefined) {
      setClauses.push('metadata = ?');
      values.push(JSON.stringify(updates.metadata));
    }

    values.push(id);
    const sql = `UPDATE memories SET ${setClauses.join(', ')} WHERE id = ?`;
    this.db.prepare(sql).run(...values);

    return this.getMemory(id);
  }

  /**
   * 删除记忆记录
   */
  deleteMemory(id: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM memories WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  /**
   * 批量删除记忆记录
   */
  deleteMemories(filter: {
    type?: MemoryRecord['type'];
    category?: string;
    source?: MemoryRecord['source'];
    projectPath?: string;
    sessionId?: string;
  }): number {
    if (!this.db) throw new Error('Database not initialized');

    let sql = 'DELETE FROM memories WHERE 1=1';
    const params: unknown[] = [];

    if (filter.type) {
      sql += ' AND type = ?';
      params.push(filter.type);
    }
    if (filter.category) {
      sql += ' AND category = ?';
      params.push(filter.category);
    }
    if (filter.source) {
      sql += ' AND source = ?';
      params.push(filter.source);
    }
    if (filter.projectPath) {
      sql += ' AND project_path = ?';
      params.push(filter.projectPath);
    }
    if (filter.sessionId) {
      sql += ' AND session_id = ?';
      params.push(filter.sessionId);
    }

    const stmt = this.db.prepare(sql);
    const result = stmt.run(...params);
    return result.changes;
  }

  /**
   * 记录记忆访问（更新 access_count 和 last_accessed_at）
   */
  recordMemoryAccess(id: string): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      UPDATE memories
      SET access_count = access_count + 1, last_accessed_at = ?
      WHERE id = ?
    `);

    stmt.run(Date.now(), id);
  }

  /**
   * 搜索记忆（简单文本搜索）
   */
  searchMemories(query: string, options: {
    type?: MemoryRecord['type'];
    category?: string;
    limit?: number;
  } = {}): MemoryRecord[] {
    if (!this.db) throw new Error('Database not initialized');

    let sql = `
      SELECT * FROM memories
      WHERE (content LIKE ? OR summary LIKE ? OR category LIKE ?)
    `;
    const searchTerm = `%${query}%`;
    const params: unknown[] = [searchTerm, searchTerm, searchTerm];

    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }

    if (options.category) {
      sql += ' AND category = ?';
      params.push(options.category);
    }

    sql += ' ORDER BY confidence DESC, updated_at DESC';

    if (options.limit) {
      sql += ` LIMIT ${options.limit}`;
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as SQLiteRow[];

    return rows.map((row) => this.rowToMemory(row));
  }

  /**
   * 获取记忆统计信息
   */
  getMemoryStats(): {
    total: number;
    byType: Record<string, number>;
    bySource: Record<string, number>;
    byCategory: Record<string, number>;
  } {
    if (!this.db) throw new Error('Database not initialized');

    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM memories').get() as SQLiteRow;
    const total = totalRow.c as number;

    const byTypeRows = this.db.prepare('SELECT type, COUNT(*) as c FROM memories GROUP BY type').all() as SQLiteRow[];
    const byType: Record<string, number> = {};
    for (const row of byTypeRows) {
      byType[row.type as string] = row.c as number;
    }

    const bySourceRows = this.db.prepare('SELECT source, COUNT(*) as c FROM memories GROUP BY source').all() as SQLiteRow[];
    const bySource: Record<string, number> = {};
    for (const row of bySourceRows) {
      bySource[row.source as string] = row.c as number;
    }

    const byCategoryRows = this.db.prepare('SELECT category, COUNT(*) as c FROM memories GROUP BY category').all() as SQLiteRow[];
    const byCategory: Record<string, number> = {};
    for (const row of byCategoryRows) {
      byCategory[row.category as string] = row.c as number;
    }

    return { total, byType, bySource, byCategory };
  }

  private rowToMemory(row: SQLiteRow): MemoryRecord {
    return {
      id: row.id as string,
      type: row.type as MemoryRecord['type'],
      category: row.category as string,
      content: row.content as string,
      summary: row.summary as string,
      source: row.source as MemoryRecord['source'],
      projectPath: row.project_path as string | null,
      sessionId: row.session_id as string | null,
      confidence: row.confidence as number,
      accessCount: row.access_count as number,
      lastAccessedAt: row.last_accessed_at as number | null,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
      metadata: row.metadata ? JSON.parse(row.metadata as string) : {},
    };
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

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as SQLiteRow;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as SQLiteRow;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as SQLiteRow;
    const knowledgeRow = this.db.prepare('SELECT COUNT(*) as c FROM project_knowledge').get() as SQLiteRow;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
      knowledgeCount: knowledgeRow.c as number,
    };
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
