// ============================================================================
// CLI Database schema — 从 database.ts 纯结构性拆出（零行为改动）
// 建表 / 索引 / 迁移 DDL；CLIDatabaseService 各方法委托调用。
// ============================================================================

import { applyTranscriptFtsSchema, runTranscriptFtsBackfill } from '../shared/transcriptFts.sql';
import { applyMemoriesFtsSchema, runMemoriesFtsBackfill } from '../shared/memoriesFts.sql';
import { loopInternalMessageWhere } from './cliDatabaseSql';

type CliDb = import('better-sqlite3').Database | null;

export function migrateCliSessionsTable(db: CliDb): void {
  if (!db) return;

  const migrations = [
    { column: 'status', sql: "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'idle'" },
    { column: 'workspace', sql: 'ALTER TABLE sessions ADD COLUMN workspace TEXT' },
    { column: 'last_token_usage', sql: 'ALTER TABLE sessions ADD COLUMN last_token_usage TEXT' },
    { column: 'master_task_id', sql: 'ALTER TABLE sessions ADD COLUMN master_task_id TEXT' },
  ];

  for (const migration of migrations) {
    try {
      db.exec(migration.sql);
    } catch {
      // 列已存在，忽略
    }
  }

  // 2026-04-15: 彻底移除废弃的 sessions.generation_id 列（见 databaseService.ts 同名迁移）
  try {
    db.exec('ALTER TABLE sessions DROP COLUMN generation_id');
  } catch {
    // 列不存在（新装或已迁移），忽略
  }
}

/**
 * 幂等加列：只吞「列已存在」错误，其余（锁/损坏/表缺失）上抛——
 * 否则迁移静默失败后首次 INSERT 会因缺列硬崩（Codex audit R1-MED1）。
 */
export function addColumnIfMissing(db: CliDb, ddl: string): void {
  if (!db) return;
  try {
    db.exec(ddl);
  } catch (error) {
    if (!/duplicate column name/i.test(error instanceof Error ? error.message : String(error))) {
      throw error;
    }
  }
}

export function createCliTables(db: CliDb): void {
  if (!db) return;

  // Sessions 表
  // 注：generation_id 列已废弃（2026-04-15）— 老 DB 的残留列由 migrateSessionsTable
  // 的 DROP COLUMN 清理
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      tool_calls TEXT,
      tool_results TEXT,
      attachments TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  addColumnIfMissing(db, `ALTER TABLE messages ADD COLUMN attachments TEXT`);

  // content_parts 列：保留 text/tool_call 的交错顺序。缺失时 renderer 落 fallback
  // （正文恒在工具组之上），会把"先搜索后总结"的时序倒过来。
  addColumnIfMissing(db, `ALTER TABLE messages ADD COLUMN content_parts TEXT`);

  addColumnIfMissing(db, `ALTER TABLE messages ADD COLUMN is_meta INTEGER NOT NULL DEFAULT 0`);

  // thinking 列：持久化模型推理/思考过程。缺失时 webServer/CLI 落库会丢 thinking，
  // 刷新后实时态显示过的 ▶思考 凭空消失（与持久态不一致）。
  addColumnIfMissing(db, `ALTER TABLE messages ADD COLUMN thinking TEXT`);

  // metadata 列：持久化消息级 metadata（turnQuality 安静徽标等）。缺失时 web 生产
  // 路径（AgentLoop → CLISessionManager 落库）会丢 metadata，reload 后徽标消失。
  addColumnIfMissing(db, `ALTER TABLE messages ADD COLUMN metadata TEXT`);

  // 添加 pr_link 列（如果不存在）
  addColumnIfMissing(db, `ALTER TABLE sessions ADD COLUMN pr_link TEXT`);

  // Tool Executions 表 (缓存)
  db.exec(`
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
  db.exec(`
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
  db.exec(`
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

  // Memories FTS5 — BM25 检索通道（roadmap 2.5），DDL 与桌面侧共用
  applyMemoriesFtsSchema(db);
  try {
    const mFtsCount = (db.prepare('SELECT COUNT(*) as c FROM memories_fts').get() as { c: number } | undefined)?.c ?? 0;
    const mCount = (db.prepare('SELECT COUNT(*) as c FROM memories').get() as { c: number } | undefined)?.c ?? 0;
    if (mFtsCount === 0 && mCount > 0) {
      runMemoriesFtsBackfill(db);
    }
  } catch {
    // backfill 失败不阻塞 CLI 启动；原子回滚保证下次启动重试
  }

  // Turn Snapshots — 调试快照（每个 agent turn 落一行，给 debug session/context 用）
  // CLI 与 Electron 都指向同一张表（共享 ~/.code-agent/code-agent.db）
  db.exec(`
    CREATE TABLE IF NOT EXISTS turn_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      turn_index INTEGER NOT NULL,
      context_chunks TEXT,
      token_breakdown TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Compaction Snapshots — 上下文压缩前后快照（CLI ↔ Electron 共用）
  db.exec(`
    CREATE TABLE IF NOT EXISTS compaction_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      strategy TEXT,
      pre_message_count INTEGER NOT NULL,
      post_message_count INTEGER NOT NULL,
      pre_tokens INTEGER NOT NULL,
      post_tokens INTEGER NOT NULL,
      saved_tokens INTEGER NOT NULL,
      usage_percent REAL,
      pre_messages_summary TEXT,
      post_messages_summary TEXT,
      byte_size INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      shape_hash_before TEXT,
      shape_hash_after TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  // WP2-2b：共库迁移（Electron 侧 safeAlter 同款，双侧幂等）
  for (const sql of [
    'ALTER TABLE compaction_snapshots ADD COLUMN shape_hash_before TEXT',
    'ALTER TABLE compaction_snapshots ADD COLUMN shape_hash_after TEXT',
  ]) {
    try {
      db.exec(sql);
    } catch {
      // 列已存在，忽略
    }
  }

  // Episodic FTS5 index — 与 Electron DatabaseService 的 schema 保持一致，
  // 使 CLI 与桌面应用共享同一张 FTS 虚拟表（两者都指向 ~/.code-agent/code-agent.db）
  // CREATE VIRTUAL TABLE IF NOT EXISTS 幂等，谁先跑都行
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
      message_id UNINDEXED,
      session_id UNINDEXED,
      role UNINDEXED,
      content,
      timestamp UNINDEXED,
      tokenize = 'trigram'
    )
  `);
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai_fts;
    DROP TRIGGER IF EXISTS messages_au_fts;
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END
  `);
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content, is_meta ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END
  `);
  db.exec(`
    DELETE FROM session_messages_fts
    WHERE message_id IN (
      SELECT id
      FROM messages
      WHERE COALESCE(is_meta, 0) != 0
        OR COALESCE(content, '') LIKE '%【循环模式 · 第%轮】%'
        OR COALESCE(content, '') LIKE '%[[LOOP_WAIT]]%'
    )
  `);

  // 首次升级后从已有 messages backfill（幂等：只在 FTS 空 + messages 非空时跑）
  try {
    const ftsCount = (db.prepare('SELECT COUNT(*) as c FROM session_messages_fts').get() as { c: number } | undefined)?.c ?? 0;
    const msgCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number } | undefined)?.c ?? 0;
    if (ftsCount === 0 && msgCount > 0) {
      db.exec(`
        INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
        SELECT id, session_id, role, COALESCE(content, ''), timestamp FROM messages
        WHERE COALESCE(is_meta, 0) = 0
          AND ${loopInternalMessageWhere('messages')}
      `);
    }
  } catch {
    // backfill 失败不阻塞 CLI 启动
  }

  // Transcript FTS5 — 按 kind 分解的转录索引（roadmap 2.1），DDL 与 Electron 共用
  applyTranscriptFtsSchema(db);
  try {
    const tFtsCount = (db.prepare('SELECT COUNT(*) as c FROM transcript_fts').get() as { c: number } | undefined)?.c ?? 0;
    const tMsgCount = (db.prepare('SELECT COUNT(*) as c FROM messages').get() as { c: number } | undefined)?.c ?? 0;
    if (tFtsCount === 0 && tMsgCount > 0) {
      // 原子 backfill：中途失败整体回滚，避免半截索引被幂等检查永久跳过
      runTranscriptFtsBackfill(db);
    }
  } catch {
    // backfill 失败不阻塞 CLI 启动
  }

  // Master Tasks 表 (P0-c2; 用户级工作单元，跨 session 持久化)
  // status 列保留 TEXT 不加 CHECK，枚举校验由应用层 (src/shared/contract/task.ts) 负责
  // CLI 与 Electron 共享同一张表（都指向 ~/.code-agent/code-agent.db）
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      workspace_uri TEXT NOT NULL,
      plan_progress TEXT NOT NULL DEFAULT '',
      sandbox_id TEXT,
      parent_task_id TEXT,
      owner_user_id TEXT NOT NULL DEFAULT 'local',
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      finished_at INTEGER,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (parent_task_id) REFERENCES master_tasks(id) ON DELETE SET NULL
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_master_tasks_status ON master_tasks(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_master_tasks_workspace ON master_tasks(workspace_uri)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_master_tasks_owner_status ON master_tasks(owner_user_id, status)`);

  // Master Task Plan Events 表 (P0-c2; MasterTask 计划流的 append-only 事件流)
  db.exec(`
    CREATE TABLE IF NOT EXISTS master_task_plan_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      master_task_id TEXT NOT NULL,
      chunk TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (master_task_id) REFERENCES master_tasks(id) ON DELETE CASCADE
    )
  `);

  db.exec(`CREATE INDEX IF NOT EXISTS idx_mtpe_master_task ON master_task_plan_events(master_task_id, created_at)`);
}

export function createCliIndexes(db: CliDb): void {
  if (!db) return;

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_hash ON tool_executions(arguments_hash);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_expires ON tool_executions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_turn_snapshots_session ON turn_snapshots(session_id);
    CREATE INDEX IF NOT EXISTS idx_turn_snapshots_created ON turn_snapshots(created_at);
    CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_session ON compaction_snapshots(session_id);
    CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_created ON compaction_snapshots(created_at);
    CREATE INDEX IF NOT EXISTS idx_sessions_master_task ON sessions(master_task_id);
  `);
}
