// ============================================================================
// CLI Database Service - 独立于 Electron 的数据库层
// ============================================================================

import path from 'path';
import fs from 'fs';
import os from 'os';
import type {
  Session,
  SessionStatus,
  Message,
  ToolResult,
  ModelProvider,
  TodoItem,
  TokenUsage,
  PRLink,
} from '../shared/contract';

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

// 延迟加载 better-sqlite3，避免 native 模块版本冲突
let Database: typeof import('better-sqlite3') | null = null;

export class CLIDatabaseService {
  private db: import('better-sqlite3').Database | null = null;
  private dbPath: string;
  private _initialized = false;
  private _initPromise: Promise<void> | null = null;

  constructor() {
    const dataDir = this.getDataDir();
    this.dbPath = path.join(dataDir, 'code-agent.db');
  }

  get isInitialized(): boolean {
    return this._initialized;
  }

  /**
   * 等待数据库初始化完成（供 SessionManager 等在需要时等待）
   */
  async waitForInit(): Promise<boolean> {
    if (this._initialized) return true;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this._initialized;
      } catch {
        return false;
      }
    }
    return false;
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
    // 防止重复初始化
    if (this._initPromise) return this._initPromise;
    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
    // 延迟加载 better-sqlite3
    if (!Database) {
      try {
        Database = require('better-sqlite3');
      } catch (error) {
        throw new Error(`Failed to load better-sqlite3: ${error instanceof Error ? error.message : error}`);
      }
    }

    const dir = path.dirname(this.dbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    this.db = new Database!(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.migrateSessionsTable();
    this.createIndexes();
    this._initialized = true;
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

    // 2026-04-15: 彻底移除废弃的 sessions.generation_id 列（见 databaseService.ts 同名迁移）
    try {
      this.db.exec('ALTER TABLE sessions DROP COLUMN generation_id');
    } catch {
      // 列不存在（新装或已迁移），忽略
    }
  }

  private createTables(): void {
    if (!this.db) return;

    // Sessions 表
    // 注：generation_id 列已废弃（2026-04-15）— 老 DB 的残留列由 migrateSessionsTable
    // 的 DROP COLUMN 清理
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
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

    // 添加 pr_link 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE sessions ADD COLUMN pr_link TEXT`);
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

    // Memories 表 — 与 Electron DatabaseService 的 schema 保持一致。
    // Workstream A 的 preCompact flush 通过 createMemory 写入这张表，CLI 模式
    // 和桌面模式共享同一张表（都指向 ~/.code-agent/code-agent.db）
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        category TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        source TEXT NOT NULL,
        project_path TEXT,
        session_id TEXT,
        confidence REAL NOT NULL DEFAULT 1.0,
        metadata TEXT DEFAULT '{}',
        access_count INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_accessed_at INTEGER
      )
    `);

    // Episodic FTS5 index — 与 Electron DatabaseService 的 schema 保持一致，
    // 使 CLI 与桌面应用共享同一张 FTS 虚拟表（两者都指向 ~/.code-agent/code-agent.db）
    // CREATE VIRTUAL TABLE IF NOT EXISTS 幂等，谁先跑都行
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        message_id UNINDEXED,
        session_id UNINDEXED,
        role UNINDEXED,
        content,
        timestamp UNINDEXED,
        tokenize = 'trigram'
      )
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
        INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
        VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
        DELETE FROM session_messages_fts WHERE message_id = old.id;
      END
    `);
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content ON messages BEGIN
        DELETE FROM session_messages_fts WHERE message_id = old.id;
        INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
        VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
      END
    `);

    // 首次升级后从已有 messages backfill（幂等：只在 FTS 空 + messages 非空时跑）
    try {
      const ftsCount = (this.db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as { c: number } | undefined)?.c ?? 0;
      const msgCount = (this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number } | undefined)?.c ?? 0;
      if (ftsCount === 0 && msgCount > 0) {
        this.db.exec(`
          INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
          SELECT id, session_id, role, COALESCE(content, ''), timestamp FROM messages
        `);
      }
    } catch {
      // backfill 失败不阻塞 CLI 启动
    }
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
      INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at, workspace, status, last_token_usage)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      session.id,
      session.title,
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
      SET title = ?, model_provider = ?, model_name = ?,
          working_directory = ?, updated_at = ?, workspace = ?, status = ?, last_token_usage = ?,
          pr_link = ?
      WHERE id = ?
    `);

    const lastTokenUsage = updates.lastTokenUsage !== undefined
      ? JSON.stringify(updates.lastTokenUsage)
      : (session.lastTokenUsage ? JSON.stringify(session.lastTokenUsage) : null);

    const prLink = updates.prLink !== undefined
      ? JSON.stringify(updates.prLink)
      : (session.prLink ? JSON.stringify(session.prLink) : null);

    stmt.run(
      updates.title ?? session.title,
      updates.modelConfig?.provider ?? session.modelConfig.provider,
      updates.modelConfig?.model ?? session.modelConfig.model,
      updates.workingDirectory ?? session.workingDirectory,
      Date.now(),
      updates.workspace !== undefined ? updates.workspace : session.workspace,
      updates.status ?? session.status ?? 'idle',
      lastTokenUsage,
      prLink,
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

    let prLink: PRLink | undefined;
    if (row.pr_link) {
      try {
        prLink = JSON.parse(row.pr_link as string);
      } catch {
        // 忽略解析错误
      }
    }

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
      prLink,
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
  // Memories (Workstream A — preCompact flush target)
  // --------------------------------------------------------------------------

  createMemory(data: {
    type: string;
    category: string;
    content: string;
    summary?: string;
    source: string;
    projectPath?: string;
    sessionId?: string;
    confidence: number;
    metadata?: Record<string, unknown>;
  }): { id: string; createdAt: number; updatedAt: number } {
    if (!this.db) throw new Error('Database not initialized');
    const id = `mem_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`;
    const now = Date.now();

    this.db
      .prepare(
        `
        INSERT INTO memories (id, type, category, content, summary, source, project_path, session_id, confidence, metadata, access_count, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
        `,
      )
      .run(
        id,
        data.type,
        data.category,
        data.content,
        data.summary ?? null,
        data.source,
        data.projectPath ?? null,
        data.sessionId ?? null,
        data.confidence,
        JSON.stringify(data.metadata ?? {}),
        now,
        now,
      );

    return { id, createdAt: now, updatedAt: now };
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
  } = {}): Array<{
    id: string;
    type: string;
    category: string;
    content: string;
    summary: string | null;
    source: string;
    projectPath: string | null;
    sessionId: string | null;
    confidence: number;
    metadata: Record<string, unknown>;
    accessCount: number;
    createdAt: number;
    updatedAt: number;
  }> {
    if (!this.db) return [];
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
    const orderBy = ['created_at', 'updated_at', 'confidence', 'access_count'].includes(
      options.orderBy ?? '',
    )
      ? options.orderBy
      : 'created_at';
    const orderDir = options.orderDir === 'ASC' ? 'ASC' : 'DESC';
    const limit = options.limit ?? 100;
    const offset = options.offset ?? 0;

    const rows = this.db
      .prepare(
        `SELECT * FROM memories ${where} ORDER BY ${orderBy} ${orderDir} LIMIT ? OFFSET ?`,
      )
      .all(...params, limit, offset) as SQLiteRow[];

    return rows.map((row) => ({
      id: String(row.id),
      type: String(row.type),
      category: String(row.category),
      content: String(row.content),
      summary: row.summary == null ? null : String(row.summary),
      source: String(row.source),
      projectPath: row.project_path == null ? null : String(row.project_path),
      sessionId: row.session_id == null ? null : String(row.session_id),
      confidence: Number(row.confidence ?? 1),
      metadata: row.metadata ? JSON.parse(String(row.metadata)) : {},
      accessCount: Number(row.access_count ?? 0),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  /**
   * FTS5 全文搜索历史会话消息（与 Electron SessionRepository.searchSessionMessagesFts 对齐）
   * - 查询默认包成 phrase literal，避免 `-` / `:` 之类 FTS5 运算符误解释
   * - sessionId 参数限定搜索作用域
   */
  searchSessionMessagesFts(
    query: string,
    options: { limit?: number; sessionId?: string } = {},
  ): Array<{
    messageId: string;
    sessionId: string;
    role: string;
    content: string;
    timestamp: number;
  }> {
    if (!this.db) return [];
    const trimmed = query.trim();
    if (trimmed.length < 3) return [];

    const ftsQuery = trimmed.startsWith('"')
      ? trimmed
      : '"' + trimmed.replace(/"/g, '""') + '"';
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
    } catch {
      // FTS 表不存在或查询失败 — 返回空，不阻塞调用方
      return [];
    }
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
