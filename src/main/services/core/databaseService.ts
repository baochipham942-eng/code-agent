// ============================================================================
// Database Service - SQLite 数据持久化层（薄门面，委托给 Repository）
// ============================================================================

import path from 'path';
import fs from 'fs';
import { app } from 'electron';
import { createLogger } from '../infra/logger';
import { getServiceRegistry } from '../serviceRegistry';

const logger = createLogger('DatabaseService');
// 延迟加载 better-sqlite3，CLI 模式下原生模块为 Electron 编译，ABI 不匹配
// 降级后数据库功能不可用，CLI 使用自己的 CLIDatabaseService
import type BetterSqlite3 from 'better-sqlite3';
let Database: typeof BetterSqlite3 | null = null;
if (!process.env.CODE_AGENT_CLI_MODE || process.env.CODE_AGENT_WEB_MODE) {
  // Web/Tauri 模式: 系统 Node.js 运行，Electron ABI 的 .node 文件不兼容
  // 优先从 dist/native/ 加载为系统 Node 编译的版本
  const nativePaths = [
    path.join(__dirname, '../../native/better-sqlite3'),    // dist/web/ → dist/native/
    path.join(process.cwd(), 'dist/native/better-sqlite3'), // cwd fallback
  ];
  for (const nativePath of nativePaths) {
    if (!Database) {
      try {
        Database = require(nativePath);
        logger.info(`[DatabaseService] Loaded better-sqlite3 from ${nativePath}`);
      } catch {
        // 继续尝试下一个路径
      }
    }
  }
  // 回退到默认路径（Electron 模式或 node_modules）
  if (!Database) {
    try {
      Database = require('better-sqlite3');
    } catch (error) {
      const err = error as Error;
      console.warn('[DatabaseService] better-sqlite3 not available:', err.message?.split('\n')[0]);
      if (err.stack) console.warn('[DatabaseService] Stack:', err.stack);
    }
  }
}
import type {
  Session,
  Message,
  ToolResult,
  ModelProvider,
  TodoItem,
} from '../../../shared/types';
import type { CaptureItem, CaptureSource, CaptureStats } from '../../../shared/types/capture';

// Re-export types from repositories（保持外部调用方零修改）
export type {
  StoredSession,
  StoredMessage,
  MemoryRecord,
  RelationQueryOptions,
  EntityRelation,
  UserPreference,
  ProjectKnowledge,
  ToolExecution,
} from './repositories';

import {
  SessionRepository,
  MemoryRepository,
  ConfigRepository,
  CaptureRepository,
  ExperimentRepository,
} from './repositories';

// ----------------------------------------------------------------------------
// Database Service
// ----------------------------------------------------------------------------

export class DatabaseService {
  private db: BetterSqlite3.Database | null = null;
  private dbPath: string;
  private _initPromise: Promise<void> | null = null;

  // Repositories
  private sessionRepo!: SessionRepository;
  private memoryRepo!: MemoryRepository;
  private configRepo!: ConfigRepository;
  private captureRepo!: CaptureRepository;
  private experimentRepo!: ExperimentRepository;

  constructor() {
    const userDataPath = app?.getPath?.('userData') || process.cwd();
    this.dbPath = path.join(userDataPath, 'code-agent.db');
  }

  // --------------------------------------------------------------------------
  // Initialization
  // --------------------------------------------------------------------------

  /**
   * 是否已初始化完成
   */
  get isReady(): boolean {
    return this.db !== null;
  }

  /**
   * 等待数据库初始化完成（供其他服务在启动时等待）
   * 如果尚未开始初始化，返回立即 resolve 的 Promise（不会自动触发初始化）
   */
  async waitForInit(): Promise<boolean> {
    if (this.db) return true;
    if (this._initPromise) {
      try {
        await this._initPromise;
        return this.db !== null;
      } catch {
        return false;
      }
    }
    return false;
  }

  async initialize(): Promise<void> {
    // 防止重复初始化
    if (this._initPromise) return this._initPromise;

    this._initPromise = this._doInitialize();
    return this._initPromise;
  }

  private async _doInitialize(): Promise<void> {
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

    // 初始化 Repositories
    this.sessionRepo = new SessionRepository(this.db);
    this.memoryRepo = new MemoryRepository(this.db);
    this.configRepo = new ConfigRepository(this.db);
    this.captureRepo = new CaptureRepository(this.db);
    this.experimentRepo = new ExperimentRepository(this.db);
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
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
          logger.warn('[DB] Migration unexpected error:', msg);
        }
      }
    }
  }

  private migrateTelemetryTurnsTable(): void {
    if (!this.db) return;
    try {
      this.db.exec("ALTER TABLE telemetry_turns ADD COLUMN agent_id TEXT DEFAULT 'main'");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }

    // Add turn_type and parent_turn_id for turn granularity tracking
    try {
      this.db.exec("ALTER TABLE telemetry_turns ADD COLUMN turn_type TEXT NOT NULL DEFAULT 'user'");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }
    try {
      this.db.exec("ALTER TABLE telemetry_turns ADD COLUMN parent_turn_id TEXT");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }

    // telemetry_model_calls 新增 prompt/completion 列（用于评测系统重放）
    const modelCallMigrations = [
      'ALTER TABLE telemetry_model_calls ADD COLUMN prompt TEXT',
      'ALTER TABLE telemetry_model_calls ADD COLUMN completion TEXT',
    ];
    for (const sql of modelCallMigrations) {
      try {
        this.db.exec(sql);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
          logger.warn('[DB] Migration unexpected error:', msg);
        }
      }
    }

    // telemetry_tool_calls 新增 error_category 列（错误分类）
    try {
      this.db.exec('ALTER TABLE telemetry_tool_calls ADD COLUMN error_category TEXT');
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
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
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }

    // 迁移：为旧表添加 thinking 和 effort_level 列（如果不存在）
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN thinking TEXT`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }
    try {
      this.db.exec(`ALTER TABLE messages ADD COLUMN effort_level TEXT`);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
    }

    // Experiments 表: 添加 git_commit 列
    try {
      this.db.exec("ALTER TABLE experiments ADD COLUMN git_commit TEXT");
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
        logger.warn('[DB] Migration unexpected error:', msg);
      }
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
,
        turn_type TEXT NOT NULL DEFAULT 'user',
        parent_turn_id TEXT
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
        error_category TEXT,
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

// Entity relations table (for proactive context)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS entity_relations (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        target_id TEXT NOT NULL,
        relation_type TEXT NOT NULL,
        confidence REAL NOT NULL DEFAULT 1.0,
        evidence TEXT DEFAULT '',
        created_at INTEGER NOT NULL
      )
    `);

    // Experiments 表 (统一评测数据)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        model TEXT,
        provider TEXT,
        scope TEXT DEFAULT 'full',
        config_json TEXT,
        summary_json TEXT NOT NULL,
        source TEXT DEFAULT 'test-runner'
      )
    `);

    // Experiment Cases 表 (评测用例结果)
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS experiment_cases (
        id TEXT PRIMARY KEY,
        experiment_id TEXT NOT NULL,
        case_id TEXT NOT NULL,
        status TEXT NOT NULL,
        score INTEGER NOT NULL,
        duration_ms INTEGER,
        data_json TEXT,
        FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
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

    // Entity relations indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_entity_relations_source ON entity_relations(source_id);
      CREATE INDEX IF NOT EXISTS idx_entity_relations_target ON entity_relations(target_id);
      CREATE INDEX IF NOT EXISTS idx_entity_relations_type ON entity_relations(relation_type);
    `);

    // Experiment indexes
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_experiments_timestamp ON experiments(timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_experiments_source ON experiments(source);
      CREATE INDEX IF NOT EXISTS idx_experiment_cases_experiment ON experiment_cases(experiment_id);
    `);

    // 性能优化：复合索引（首轮响应加速）
    this.db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)`);
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
  // Utility
  // --------------------------------------------------------------------------

  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  async dispose(): Promise<void> {
    this.close();
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

    const sessionRow = this.db.prepare('SELECT COUNT(*) as c FROM sessions').get() as Record<string, unknown>;
    const messageRow = this.db.prepare('SELECT COUNT(*) as c FROM messages').get() as Record<string, unknown>;
    const toolRow = this.db.prepare('SELECT COUNT(*) as c FROM tool_executions').get() as Record<string, unknown>;
    const knowledgeRow = this.db.prepare('SELECT COUNT(*) as c FROM project_knowledge').get() as Record<string, unknown>;

    return {
      sessionCount: sessionRow.c as number,
      messageCount: messageRow.c as number,
      toolExecutionCount: toolRow.c as number,
      knowledgeCount: knowledgeRow.c as number,
    };
  }

  // ==========================================================================
  // Facade Methods — 委托给 Repository
  // ==========================================================================

  private _ensureDbWarned = false;
  private ensureDb(): void {
    if (!this.db) {
      if (!this._ensureDbWarned) {
        this._ensureDbWarned = true;
        logger.warn('Database not initialized — operations will be skipped until init completes');
      }
      throw new Error('Database not initialized');
    }
  }

  // --- SessionRepository ---
  createSession(session: Session): void { this.ensureDb(); this.sessionRepo.createSession(session); }
  createSessionWithId(id: string, data: { title: string; generationId?: string; modelConfig: { provider: ModelProvider; model: string }; workingDirectory?: string }): void { this.ensureDb(); this.sessionRepo.createSessionWithId(id, data); }
  getSession(sessionId: string): import('./repositories').StoredSession | null { this.ensureDb(); return this.sessionRepo.getSession(sessionId); }
  listSessions(limit: number = 50, offset: number = 0, includeArchived: boolean = false): import('./repositories').StoredSession[] { this.ensureDb(); return this.sessionRepo.listSessions(limit, offset, includeArchived); }
  updateSession(sessionId: string, updates: Partial<Session>): void { this.ensureDb(); this.sessionRepo.updateSession(sessionId, updates); }
  deleteSession(sessionId: string): void { this.ensureDb(); this.sessionRepo.deleteSession(sessionId); }
  clearAllSessions(): number { this.ensureDb(); return this.sessionRepo.clearAllSessions(); }
  clearAllMessages(): number { this.ensureDb(); return this.sessionRepo.clearAllMessages(); }
  hasMessages(sessionId: string): boolean { this.ensureDb(); return this.sessionRepo.hasMessages(sessionId); }
  getLocalCacheStats(): { sessionCount: number; messageCount: number } { this.ensureDb(); return this.sessionRepo.getLocalCacheStats(); }
  addMessage(sessionId: string, message: Message): void { this.ensureDb(); this.sessionRepo.addMessage(sessionId, message); }
  updateMessage(messageId: string, updates: Partial<Message>): void { this.ensureDb(); this.sessionRepo.updateMessage(messageId, updates); }
  getMessages(sessionId: string, limit?: number, offset?: number): Message[] { this.ensureDb(); return this.sessionRepo.getMessages(sessionId, limit, offset); }
  getMessageCount(sessionId: string): number { this.ensureDb(); return this.sessionRepo.getMessageCount(sessionId); }
  getRecentMessages(sessionId: string, count: number): Message[] { this.ensureDb(); return this.sessionRepo.getRecentMessages(sessionId, count); }
  getMessagesBefore(sessionId: string, beforeTimestamp: number, limit: number = 30): Message[] { this.ensureDb(); return this.sessionRepo.getMessagesBefore(sessionId, beforeTimestamp, limit); }
  saveTodos(sessionId: string, todos: TodoItem[]): void { this.ensureDb(); this.sessionRepo.saveTodos(sessionId, todos); }
  getTodos(sessionId: string): TodoItem[] { this.ensureDb(); return this.sessionRepo.getTodos(sessionId); }
  listArchivedSessions(limit: number = 50, offset: number = 0): import('./repositories').StoredSession[] { this.ensureDb(); return this.sessionRepo.listArchivedSessions(limit, offset); }
  archiveSession(sessionId: string): import('./repositories').StoredSession | null { this.ensureDb(); return this.sessionRepo.archiveSession(sessionId); }
  unarchiveSession(sessionId: string): import('./repositories').StoredSession | null { this.ensureDb(); return this.sessionRepo.unarchiveSession(sessionId); }

  // --- MemoryRepository ---
  createMemory(data: Omit<import('./repositories').MemoryRecord, 'id' | 'accessCount' | 'createdAt' | 'updatedAt'>): import('./repositories').MemoryRecord { this.ensureDb(); return this.memoryRepo.createMemory(data); }
  getMemory(id: string): import('./repositories').MemoryRecord | null { this.ensureDb(); return this.memoryRepo.getMemory(id); }
  listMemories(options?: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string; limit?: number; offset?: number; orderBy?: string; orderDir?: 'ASC' | 'DESC' }): import('./repositories').MemoryRecord[] { this.ensureDb(); return this.memoryRepo.listMemories(options); }
  updateMemory(id: string, updates: Partial<import('./repositories').MemoryRecord>): import('./repositories').MemoryRecord | null { this.ensureDb(); return this.memoryRepo.updateMemory(id, updates); }
  deleteMemory(id: string): boolean { this.ensureDb(); return this.memoryRepo.deleteMemory(id); }
  deleteMemories(filter: { type?: string; category?: string; source?: string; projectPath?: string; sessionId?: string }): number { this.ensureDb(); return this.memoryRepo.deleteMemories(filter); }
  searchMemories(query: string, options?: { type?: string; category?: string; limit?: number }): import('./repositories').MemoryRecord[] { this.ensureDb(); return this.memoryRepo.searchMemories(query, options); }
  getMemoryStats(): { total: number; byType: Record<string, number>; bySource: Record<string, number>; byCategory: Record<string, number> } { this.ensureDb(); return this.memoryRepo.getMemoryStats(); }
  recordMemoryAccess(id: string): void { this.ensureDb(); this.memoryRepo.recordMemoryAccess(id); }
  addRelation(params: { sourceId: string; targetId: string; relationType: 'calls' | 'imports' | 'similar_to' | 'solves' | 'depends_on' | 'modifies' | 'references'; confidence: number; evidence: string; sessionId: string }): void { if (!this.db) return; this.memoryRepo.addRelation(params); }
  getRelationsFor(entityId: string, direction?: 'source' | 'target' | 'both', options?: import('./repositories').RelationQueryOptions): import('./repositories').EntityRelation[] { if (!this.db) return []; return this.memoryRepo.getRelationsFor(entityId, direction, options); }
  updateRelationConfidence(id: string, confidence: number, evidence?: string): void { if (!this.db) return; this.memoryRepo.updateRelationConfidence(id, confidence, evidence); }

  // --- ConfigRepository ---
  setPreference(key: string, value: unknown): void { this.ensureDb(); this.configRepo.setPreference(key, value); }
  getPreference<T>(key: string, defaultValue?: T): T | undefined { this.ensureDb(); return this.configRepo.getPreference(key, defaultValue); }
  getAllPreferences(): Record<string, unknown> { this.ensureDb(); return this.configRepo.getAllPreferences(); }
  deletePreference(key: string): boolean { this.ensureDb(); return this.configRepo.deletePreference(key); }
  saveProjectKnowledge(projectPath: string, key: string, value: unknown, source?: 'learned' | 'explicit' | 'inferred', confidence?: number): void { this.ensureDb(); this.configRepo.saveProjectKnowledge(projectPath, key, value, source, confidence); }
  getProjectKnowledge(projectPath: string, key?: string): import('./repositories').ProjectKnowledge[] { this.ensureDb(); return this.configRepo.getProjectKnowledge(projectPath, key); }
  getAllProjectKnowledge(): import('./repositories').ProjectKnowledge[] { this.ensureDb(); return this.configRepo.getAllProjectKnowledge(); }
  updateProjectKnowledge(id: string, content: string): boolean { this.ensureDb(); return this.configRepo.updateProjectKnowledge(id, content); }
  deleteProjectKnowledge(id: string): boolean { this.ensureDb(); return this.configRepo.deleteProjectKnowledge(id); }
  deleteProjectKnowledgeBySource(source: string): number { this.ensureDb(); return this.configRepo.deleteProjectKnowledgeBySource(source); }
  logAuditEvent(eventType: string, eventData: Record<string, unknown>, sessionId?: string): void { this.ensureDb(); this.configRepo.logAuditEvent(eventType, eventData, sessionId); }
  getAuditLog(options?: { sessionId?: string; eventType?: string; limit?: number; since?: number }): Array<{ id: number; sessionId: string | null; eventType: string; eventData: Record<string, unknown>; createdAt: number }> { this.ensureDb(); return this.configRepo.getAuditLog(options); }
  saveToolExecution(sessionId: string, messageId: string | null, toolName: string, args: Record<string, unknown>, result: ToolResult, ttlMs?: number): void { this.ensureDb(); this.configRepo.saveToolExecution(sessionId, messageId, toolName, args, result, ttlMs); }
  getCachedToolResult(toolName: string, args: Record<string, unknown>): ToolResult | null { this.ensureDb(); return this.configRepo.getCachedToolResult(toolName, args); }
  cleanExpiredCache(): number { this.ensureDb(); return this.configRepo.cleanExpiredCache(); }
  clearToolCache(): number { this.ensureDb(); return this.configRepo.clearToolCache(); }
  getToolCacheCount(): number { this.ensureDb(); return this.configRepo.getToolCacheCount(); }

  // --- CaptureRepository ---
  createCapture(item: CaptureItem): void { this.ensureDb(); this.captureRepo.createCapture(item); }
  listCaptures(opts?: { source?: CaptureSource; limit?: number; offset?: number }): CaptureItem[] { this.ensureDb(); return this.captureRepo.listCaptures(opts); }
  getCapture(id: string): CaptureItem | undefined { this.ensureDb(); return this.captureRepo.getCapture(id); }
  deleteCapture(id: string): boolean { this.ensureDb(); return this.captureRepo.deleteCapture(id); }
  getCaptureStats(): CaptureStats { this.ensureDb(); return this.captureRepo.getCaptureStats(); }
  searchCaptures(query: string, limit?: number): CaptureItem[] { this.ensureDb(); return this.captureRepo.searchCaptures(query, limit); }

  // --- ExperimentRepository ---
  insertExperiment(experiment: { id: string; name: string; timestamp: number; model?: string; provider?: string; scope?: string; config_json?: string; summary_json: string; source?: string; git_commit?: string }): void { this.ensureDb(); this.experimentRepo.insertExperiment(experiment); }
  insertExperimentCases(experimentId: string, cases: Array<{ id: string; case_id: string; status: string; score: number; duration_ms?: number; data_json?: string }>): void { this.ensureDb(); this.experimentRepo.insertExperimentCases(experimentId, cases); }
  listExperiments(limit?: number): Array<{ id: string; name: string; timestamp: number; model: string | null; provider: string | null; scope: string; config_json: string | null; summary_json: string; source: string; git_commit: string | null }> { this.ensureDb(); return this.experimentRepo.listExperiments(limit); }
  loadExperiment(id: string): { experiment: { id: string; name: string; timestamp: number; model: string | null; provider: string | null; scope: string; config_json: string | null; summary_json: string; source: string; git_commit: string | null }; cases: Array<{ id: string; experiment_id: string; case_id: string; status: string; score: number; duration_ms: number | null; data_json: string | null }> } | undefined { this.ensureDb(); return this.experimentRepo.loadExperiment(id); }
  updateExperimentSummary(id: string, summaryJson: string): void { this.ensureDb(); this.experimentRepo.updateExperimentSummary(id, summaryJson); }
  deleteExperiment(id: string): boolean { this.ensureDb(); return this.experimentRepo.deleteExperiment(id); }
}

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let dbInstance: DatabaseService | null = null;

export function getDatabase(): DatabaseService {
  if (!dbInstance) {
    dbInstance = new DatabaseService();
    getServiceRegistry().register('DatabaseService', dbInstance);
  }
  return dbInstance;
}

export async function initDatabase(): Promise<DatabaseService> {
  const db = getDatabase();
  await db.initialize();
  return db;
}
