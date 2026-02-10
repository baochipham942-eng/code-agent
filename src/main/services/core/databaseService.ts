// ============================================================================
// Database Service - SQLite 数据持久化层
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
// 延迟加载 better-sqlite3，CLI 模式下原生模块为 Electron 编译，ABI 不匹配
// 降级后数据库功能不可用，CLI 使用自己的 CLIDatabaseService
import type BetterSqlite3 from 'better-sqlite3';
let Database: typeof BetterSqlite3 | null = null;
if (!process.env.CODE_AGENT_CLI_MODE) {
  try {
    Database = require('better-sqlite3');
  } catch (error) {
    console.warn('[DatabaseService] better-sqlite3 not available:', (error as Error).message?.split('\n')[0]);
  }
}
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
import type { CaptureItem, CaptureSource, CaptureStats } from '../../../shared/types/capture';

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

// SQLite 行类型（better-sqlite3 返回的原始行结构）
// 使用 Record<string, unknown> 代替 any，但具体字段访问仍需类型断言
type SQLiteRow = Record<string, unknown>;

// ----------------------------------------------------------------------------
// Database Service
// ----------------------------------------------------------------------------

export class DatabaseService {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.dbPath = path.join(userDataPath, 'code-agent.db');
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  async initialize(): Promise<void> {
    // 确保目录存在（异步，性能优化）
    const dir = path.dirname(this.dbPath);
    await fs.promises.mkdir(dir, { recursive: true }).catch((err) => {
      // EEXIST 表示目录已存在，不是错误
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
        throw err;
      }
    });

    if (!Database) {
      throw new Error('better-sqlite3 not available (CLI mode or native module missing)');
    }
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');

    this.createTables();
    this.migrateSessionsTable();
    this.migrateTelemetryTurnsTable();
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

  private migrateTelemetryTurnsTable(): void {
    if (!this.db) return;
    try {
      this.db.exec("ALTER TABLE telemetry_turns ADD COLUMN agent_id TEXT DEFAULT 'main'");
    } catch {
      // 列已存在，忽略
    }

    // telemetry_model_calls 新增 prompt/completion 列（用于评测系统重放）
    const modelCallMigrations = [
      'ALTER TABLE telemetry_model_calls ADD COLUMN prompt TEXT',
      'ALTER TABLE telemetry_model_calls ADD COLUMN completion TEXT',
    ];
    for (const sql of modelCallMigrations) {
      try {
        this.db.exec(sql);
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

    // 迁移：为旧表添加 thinking 和 effort_level 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`);
    } catch {
      // 列已存在，忽略
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN effort_level TEXT`);
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

    // Memories 表 (记忆存储)
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

    // Cron Jobs 表 (定时任务)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_jobs (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT,
        schedule_type TEXT NOT NULL,
        schedule TEXT NOT NULL,
        action TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1,
        max_retries INTEGER DEFAULT 0,
        retry_delay INTEGER DEFAULT 5000,
        timeout INTEGER DEFAULT 60000,
        tags TEXT,
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // Cron Executions 表 (任务执行记录)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cron_executions (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        status TEXT NOT NULL,
        scheduled_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        duration INTEGER,
        result TEXT,
        error TEXT,
        retry_attempt INTEGER NOT NULL DEFAULT 0,
        exit_code INTEGER,
        FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
      )
    `);

    // Heartbeats 表 (心跳配置)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS heartbeats (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        interval INTEGER NOT NULL,
        check_config TEXT NOT NULL,
        expectation TEXT,
        alert TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        failure_threshold INTEGER DEFAULT 3,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);

    // File Checkpoints 表 (文件回滚检查点)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS file_checkpoints (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_content TEXT,
        file_existed INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // Session Events 表 (完整 SSE 事件日志，用于评测分析)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS session_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        event_data TEXT,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
      )
    `);

    // ========================================================================
    // Telemetry Tables (会话遥测系统)
    // ========================================================================

    // Telemetry Sessions - 一行/会话，聚合指标
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_sessions (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        generation_id TEXT NOT NULL,
        model_provider TEXT NOT NULL,
        model_name TEXT NOT NULL,
        working_directory TEXT NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER,
        duration_ms INTEGER,
        turn_count INTEGER DEFAULT 0,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        total_tokens INTEGER DEFAULT 0,
        estimated_cost REAL DEFAULT 0,
        total_tool_calls INTEGER DEFAULT 0,
        tool_success_rate REAL DEFAULT 0,
        total_errors INTEGER DEFAULT 0,
        session_type TEXT,
        status TEXT DEFAULT 'recording'
      )
    `);

    // Telemetry Turns - 一行/轮次
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_turns (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_number INTEGER NOT NULL,
        start_time INTEGER NOT NULL,
        end_time INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        user_prompt TEXT,
        user_prompt_tokens INTEGER DEFAULT 0,
        has_attachments INTEGER DEFAULT 0,
        attachment_count INTEGER DEFAULT 0,
        system_prompt_hash TEXT,
        agent_mode TEXT DEFAULT 'normal',
        active_skills TEXT,
        active_mcp_servers TEXT,
        effort_level TEXT DEFAULT 'high',
        assistant_response TEXT,
        assistant_response_tokens INTEGER DEFAULT 0,
        thinking_content TEXT,
        total_input_tokens INTEGER DEFAULT 0,
        total_output_tokens INTEGER DEFAULT 0,
        intent_primary TEXT DEFAULT 'unknown',
        intent_secondary TEXT,
        intent_confidence REAL DEFAULT 0,
        intent_method TEXT DEFAULT 'rule',
        intent_keywords TEXT,
        outcome_status TEXT DEFAULT 'unknown',
        outcome_confidence REAL DEFAULT 0,
        outcome_method TEXT DEFAULT 'rule',
        quality_signals TEXT,
        compaction_occurred INTEGER DEFAULT 0,
        compaction_saved_tokens INTEGER,
        iteration_count INTEGER DEFAULT 1
      )
    `);

    // Telemetry Model Calls - 一行/模型调用
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_model_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        temperature REAL,
        max_tokens INTEGER,
        input_tokens INTEGER DEFAULT 0,
        output_tokens INTEGER DEFAULT 0,
        latency_ms INTEGER DEFAULT 0,
        response_type TEXT,
        tool_call_count INTEGER DEFAULT 0,
        truncated INTEGER DEFAULT 0,
        error TEXT,
        fallback_info TEXT
      )
    `);

    // Telemetry Tool Calls - 一行/工具调用
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_tool_calls (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        tool_call_id TEXT NOT NULL,
        name TEXT NOT NULL,
        arguments TEXT,
        result_summary TEXT,
        success INTEGER DEFAULT 0,
        error TEXT,
        duration_ms INTEGER DEFAULT 0,
        timestamp INTEGER NOT NULL,
        idx INTEGER DEFAULT 0,
        parallel INTEGER DEFAULT 0
      )
    `);

    // Telemetry Events - 一行/时间线事件
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS telemetry_events (
        id TEXT PRIMARY KEY,
        turn_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        summary TEXT,
        data TEXT,
        duration_ms INTEGER
      )
    `);

    // Captures 表 (知识库采集内容持久化)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS captures (
        id TEXT PRIMARY KEY,
        url TEXT,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        summary TEXT,
        source TEXT NOT NULL DEFAULT 'browser_extension',
        tags TEXT DEFAULT '[]',
        metadata TEXT DEFAULT '{}',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
  }

  private createIndexes(): void {
    if (!this.db) return;

    // 基础索引
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
      CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
      CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
      CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
    `);

    // 性能优化：复合索引（首轮响应加速）
    // 会话列表查询：按状态过滤 + 按更新时间排序
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)`);
    // 消息懒加载：按会话 + 时间戳排序（覆盖索引，避免回表）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp DESC)`);

    // Cron 相关索引
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(job_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_status ON cron_executions(status)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_scheduled ON cron_executions(scheduled_at DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_heartbeats_enabled ON heartbeats(enabled)`);

    // Session Events indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(session_id, timestamp)`);

    // File Checkpoints indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_session ON file_checkpoints(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_message ON file_checkpoints(message_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_created ON file_checkpoints(created_at)`);

    // Telemetry indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_start ON telemetry_sessions(start_time DESC)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_turns_session ON telemetry_turns(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_turns_session_num ON telemetry_turns(session_id, turn_number)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_model_calls_turn ON telemetry_model_calls(turn_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_model_calls_session ON telemetry_model_calls(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_turn ON telemetry_tool_calls(turn_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_session ON telemetry_tool_calls(session_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_name ON telemetry_tool_calls(name)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn ON telemetry_events(turn_id)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id)`);

    // Captures indexes
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_captures_source ON captures(source)`);
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC)`);
  }

  // --------------------------------------------------------------------------
  // Raw Database Access
  // --------------------------------------------------------------------------

  /**
   * 获取原始的 better-sqlite3 数据库实例
   * 仅用于需要直接执行 SQL 的特殊场景
   */
  getDb(): BetterSqlite3.Database | null {
    return this.db;
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

  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false): StoredSession[] {
    if (!this.db) throw new Error('Database not initialized');

    const statusCondition = includeArchived ? '' : "WHERE s.status != 'archived'";
    const stmt = this.db.prepare(`
      SELECT s.*, COUNT(m.id) as message_count
      FROM sessions s
      LEFT JOIN messages m ON s.id = m.session_id
      ${statusCondition}
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

    const isArchived = row.status === 'archived';

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
      // 归档状态：从 status 字段派生
      isArchived,
      archivedAt: isArchived ? (row.updated_at as number) : undefined,
    };
  }

  // --------------------------------------------------------------------------
  // Message CRUD
  // --------------------------------------------------------------------------

  addMessage(sessionId: string, message: Message): void {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      INSERT INTO messages (id, session_id, role, content, timestamp, tool_calls, tool_results, attachments, thinking, effort_level)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // thinking 和 reasoning 合并存储到 thinking 列
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
      message.effortLevel || null
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
      thinking: (row.thinking as string) || undefined,
      effortLevel: (row.effort_level as Message['effortLevel']) || undefined,
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

  deletePreference(key: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

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

  getAllProjectKnowledge(): ProjectKnowledge[] {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(
      'SELECT * FROM project_knowledge ORDER BY updated_at DESC'
    );
    const rows = stmt.all() as SQLiteRow[];

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

  updateProjectKnowledge(id: string, content: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare(`
      UPDATE project_knowledge
      SET value = ?, updated_at = ?
      WHERE id = ?
    `);

    const result = stmt.run(JSON.stringify(content), Date.now(), id);
    return result.changes > 0;
  }

  deleteProjectKnowledge(id: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM project_knowledge WHERE id = ?');
    const result = stmt.run(id);
    return result.changes > 0;
  }

  deleteProjectKnowledgeBySource(source: string): number {
    if (!this.db) throw new Error('Database not initialized');

    const stmt = this.db.prepare('DELETE FROM project_knowledge WHERE source = ?');
    const result = stmt.run(source);
    return result.changes;
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

  // --------------------------------------------------------------------------
  // Memory Methods (Phase 2/3)
  // --------------------------------------------------------------------------

  /**
   * 创建记忆
   */
  createMemory(data: Omit<MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): MemoryRecord {
    if (!this.db) throw new Error('Database not initialized');

    const id = `mem_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
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

  /**
   * 获取单个记忆
   */
  getMemory(id: string): MemoryRecord | null {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT * FROM memories WHERE id = ?').get(id) as SQLiteRow | undefined;
    if (!row) return null;

    return this.rowToMemoryRecord(row);
  }

  /**
   * 列出记忆
   */
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
    if (!this.db) throw new Error('Database not initialized');

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

  /**
   * 更新记忆
   */
  updateMemory(id: string, updates: Partial<MemoryRecord>): MemoryRecord | null {
    if (!this.db) throw new Error('Database not initialized');

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

  /**
   * 删除单个记忆
   */
  deleteMemory(id: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    return result.changes > 0;
  }

  /**
   * 批量删除记忆
   */
  deleteMemories(filter: {
    type?: string;
    category?: string;
    source?: string;
    projectPath?: string;
    sessionId?: string;
  }): number {
    if (!this.db) throw new Error('Database not initialized');

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
   * 搜索记忆
   */
  searchMemories(query: string, options: { type?: string; category?: string; limit?: number } = {}): MemoryRecord[] {
    if (!this.db) throw new Error('Database not initialized');

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

  /**
   * 获取记忆统计
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

  /**
   * 记录记忆访问
   */
  recordMemoryAccess(id: string): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`
      UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?
    `).run(Date.now(), id);
  }

  /**
   * 行数据转 MemoryRecord
   */
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

  // --------------------------------------------------------------------------
  // Capture CRUD (知识库采集内容)
  // --------------------------------------------------------------------------

  createCapture(item: CaptureItem): void {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`
      INSERT OR REPLACE INTO captures (id, url, title, content, summary, source, tags, metadata, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      item.id,
      item.url || null,
      item.title,
      item.content,
      item.summary || null,
      item.source,
      JSON.stringify(item.tags),
      JSON.stringify(item.metadata),
      item.createdAt,
      item.updatedAt,
    );
  }

  listCaptures(opts?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] {
    if (!this.db) throw new Error('Database not initialized');

    const conditions: string[] = [];
    const params: unknown[] = [];

    if (opts?.source) {
      conditions.push('source = ?');
      params.push(opts.source);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = opts?.limit || 50;
    const offset = opts?.offset || 0;

    const rows = this.db.prepare(`
      SELECT * FROM captures ${where}
      ORDER BY created_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, limit, offset) as SQLiteRow[];

    return rows.map(row => this.rowToCaptureItem(row));
  }

  getCapture(id: string): CaptureItem | undefined {
    if (!this.db) throw new Error('Database not initialized');

    const row = this.db.prepare('SELECT * FROM captures WHERE id = ?').get(id) as SQLiteRow | undefined;
    return row ? this.rowToCaptureItem(row) : undefined;
  }

  deleteCapture(id: string): boolean {
    if (!this.db) throw new Error('Database not initialized');

    const result = this.db.prepare('DELETE FROM captures WHERE id = ?').run(id);
    return result.changes > 0;
  }

  getCaptureStats(): CaptureStats {
    if (!this.db) throw new Error('Database not initialized');

    const totalRow = this.db.prepare('SELECT COUNT(*) as c FROM captures').get() as SQLiteRow;
    const total = totalRow.c as number;

    const bySource: Record<CaptureSource, number> = {
      browser_extension: 0,
      manual: 0,
      wechat: 0,
      local_file: 0,
    };
    const sourceRows = this.db.prepare('SELECT source, COUNT(*) as c FROM captures GROUP BY source').all() as SQLiteRow[];
    for (const row of sourceRows) {
      bySource[row.source as CaptureSource] = row.c as number;
    }

    const weekAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentRow = this.db.prepare('SELECT COUNT(*) as c FROM captures WHERE created_at > ?').get(weekAgo) as SQLiteRow;

    return {
      total,
      bySource,
      recentlyAdded: recentRow.c as number,
    };
  }

  searchCaptures(query: string, limit: number = 20): CaptureItem[] {
    if (!this.db) throw new Error('Database not initialized');

    const pattern = `%${query}%`;
    const rows = this.db.prepare(`
      SELECT * FROM captures
      WHERE title LIKE ? OR content LIKE ? OR tags LIKE ?
      ORDER BY created_at DESC
      LIMIT ?
    `).all(pattern, pattern, pattern, limit) as SQLiteRow[];

    return rows.map(row => this.rowToCaptureItem(row));
  }

  private rowToCaptureItem(row: SQLiteRow): CaptureItem {
    return {
      id: row.id as string,
      url: (row.url as string) || undefined,
      title: row.title as string,
      content: row.content as string,
      summary: (row.summary as string) || undefined,
      source: row.source as CaptureSource,
      tags: JSON.parse((row.tags as string) || '[]'),
      metadata: JSON.parse((row.metadata as string) || '{}'),
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  // --------------------------------------------------------------------------
  // Session Archive Methods
  // --------------------------------------------------------------------------

  /**
   * 列出已归档会话
   */
  listArchivedSessions(limit: number = 50, offset: number = 0): StoredSession[] {
    if (!this.db) throw new Error('Database not initialized');

    const rows = this.db.prepare(`
      SELECT s.*, (SELECT COUNT(*) FROM messages WHERE session_id = s.id) as message_count
      FROM sessions s
      WHERE s.status = 'archived'
      ORDER BY s.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset) as SQLiteRow[];

    return rows.map(row => this.rowToSession(row));
  }

  /**
   * 归档会话
   */
  archiveSession(sessionId: string): StoredSession | null {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`UPDATE sessions SET status = 'archived', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    return this.getSession(sessionId);
  }

  /**
   * 取消归档会话
   */
  unarchiveSession(sessionId: string): StoredSession | null {
    if (!this.db) throw new Error('Database not initialized');

    this.db.prepare(`UPDATE sessions SET status = 'idle', updated_at = ? WHERE id = ?`).run(Date.now(), sessionId);
    return this.getSession(sessionId);
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
