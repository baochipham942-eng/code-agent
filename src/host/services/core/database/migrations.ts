import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

function safeExec(db: BetterSqlite3.Database, sql: string, logger: Logger): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isIdempotentDropColumn =
      /\bDROP\s+COLUMN\b/i.test(sql) &&
      (msg.includes('no such column') || msg.includes('does not exist'));
    if (isIdempotentDropColumn) {
      return;
    }
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      logger.warn('[DB] Migration unexpected error:', msg);
    }
  }
}

export function applySessionsMigrations(db: BetterSqlite3.Database, logger: Logger): void {
  const migrations = [
    "ALTER TABLE sessions ADD COLUMN status TEXT DEFAULT 'idle'",
    'ALTER TABLE sessions ADD COLUMN workspace TEXT',
    'ALTER TABLE sessions ADD COLUMN workbench_provenance TEXT',
    'ALTER TABLE sessions ADD COLUMN last_token_usage TEXT',
    'ALTER TABLE sessions ADD COLUMN is_deleted INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN synced_at INTEGER',
    'ALTER TABLE sessions ADD COLUMN git_branch TEXT',
    "ALTER TABLE sessions ADD COLUMN session_type TEXT NOT NULL DEFAULT 'chat'",
    'ALTER TABLE sessions ADD COLUMN origin TEXT',
    'ALTER TABLE sessions ADD COLUMN parent_session_id TEXT',
    'ALTER TABLE sessions ADD COLUMN source_run_id TEXT',
    'ALTER TABLE sessions ADD COLUMN agent_engine TEXT',
    'ALTER TABLE sessions ADD COLUMN read_only INTEGER NOT NULL DEFAULT 0',
    'ALTER TABLE sessions ADD COLUMN retry_of_session_id TEXT',
    // P0-2 项目空间：session 归属的 project（可空，存量由 ProjectRepository.backfillSessions 回填归桶）
    'ALTER TABLE sessions ADD COLUMN project_id TEXT',
  ];

  for (const sql of migrations) {
    safeExec(db, sql, logger);
  }

  // 2026-04-15: 彻底移除废弃的 sessions.generation_id 列
  // 背景：2026-04-12 的 refactor (8a68ee85) 把运行时会话分代字段抹掉了，
  // 但 sessions 表的 `generation_id TEXT NOT NULL` 没跟着放宽；SessionRepository
  // 往新 session 里插 null 触发 NOT NULL constraint failed → 桌面端点"新会话"
  // 无响应。SQLite 3.35+ 支持 DROP COLUMN，幂等 try/catch。
  try {
    db.exec('ALTER TABLE sessions DROP COLUMN generation_id');
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('no such column') && !msg.includes('does not exist')) {
      logger.warn('[DB] Drop generation_id migration unexpected error:', msg);
    }
  }
}

export function applyTelemetryTurnsMigrations(db: BetterSqlite3.Database, logger: Logger): void {
  safeExec(db, "ALTER TABLE telemetry_turns ADD COLUMN agent_id TEXT DEFAULT 'main'", logger);
  safeExec(db, "ALTER TABLE telemetry_turns ADD COLUMN turn_type TEXT NOT NULL DEFAULT 'user'", logger);
  safeExec(db, "ALTER TABLE telemetry_turns ADD COLUMN parent_turn_id TEXT", logger);

  // Fleet observability: 标记会话遥测是否已回传到云端（NULL = 未上传），镜像 sessions.synced_at
  safeExec(db, 'ALTER TABLE telemetry_sessions ADD COLUMN synced_at INTEGER', logger);
  // 诊断版本指纹：知道每条会话跑的是哪版构建/提示词/工具集（按版本归因，替代盲打补丁）
  safeExec(db, 'ALTER TABLE telemetry_sessions ADD COLUMN agent_version TEXT', logger);
  safeExec(db, 'ALTER TABLE telemetry_sessions ADD COLUMN prompt_version TEXT', logger);
  safeExec(db, 'ALTER TABLE telemetry_sessions ADD COLUMN tool_schema_version TEXT', logger);
  // Runtime 会话分代已不再是会话维度；旧 telemetry 表里保留的列会让后续 insert 继续写假值。
  safeExec(db, 'ALTER TABLE telemetry_sessions DROP COLUMN generation_id', logger);
  safeExec(
    db,
    `
      CREATE TABLE IF NOT EXISTS telemetry_feedback (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        message_id TEXT,
        rating INTEGER NOT NULL CHECK (rating IN (-1, 1)),
        comment TEXT,
        full_content TEXT,
        created_at INTEGER NOT NULL,
        synced_at INTEGER
      )
    `,
    logger,
  );

  // telemetry_model_calls 新增 prompt/completion 列（用于评测系统重放）
  const modelCallMigrations = [
    'ALTER TABLE telemetry_model_calls ADD COLUMN prompt TEXT',
    'ALTER TABLE telemetry_model_calls ADD COLUMN completion TEXT',
  ];
  for (const sql of modelCallMigrations) {
    safeExec(db, sql, logger);
  }

  // 诊断原始内容旁表（仅密钥掩码、不截断/不 PII），与聚合表分离、独立滚动淘汰
  safeExec(
    db,
    `
      CREATE TABLE IF NOT EXISTS telemetry_raw_payloads (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        turn_id TEXT,
        ref_kind TEXT NOT NULL,
        ref_id TEXT NOT NULL,
        field TEXT NOT NULL,
        content TEXT,
        byte_len INTEGER NOT NULL,
        truncated INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      )
    `,
    logger,
  );
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_raw_payloads_session ON telemetry_raw_payloads(session_id)', logger);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_raw_payloads_turn ON telemetry_raw_payloads(turn_id)', logger);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_raw_payloads_created ON telemetry_raw_payloads(created_at)', logger);

  // 诊断包本地排队表:失败 session 的脱敏诊断包,待上传(synced_at NULL = 未上传)
  safeExec(
    db,
    `
      CREATE TABLE IF NOT EXISTS telemetry_diagnostic_bundles (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        agent_version TEXT,
        prompt_version TEXT,
        tool_schema_version TEXT,
        trigger_reason TEXT NOT NULL,
        bundle_version INTEGER NOT NULL DEFAULT 1,
        built_at INTEGER NOT NULL,
        bundle TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        synced_at INTEGER
      )
    `,
    logger,
  );
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_diag_bundles_synced ON telemetry_diagnostic_bundles(synced_at)', logger);
  safeExec(db, 'CREATE INDEX IF NOT EXISTS idx_diag_bundles_session ON telemetry_diagnostic_bundles(session_id)', logger);

  // telemetry_tool_calls 新增错误分类与 Computer Surface 可靠性字段
  const toolCallMigrations = [
    'ALTER TABLE telemetry_tool_calls ADD COLUMN actual_arguments TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN error_category TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_failure_kind TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_mode TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_target_app TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_action TEXT',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_ax_quality_score REAL',
    'ALTER TABLE telemetry_tool_calls ADD COLUMN computer_surface_ax_quality_grade TEXT',
  ];
  for (const sql of toolCallMigrations) {
    safeExec(db, sql, logger);
  }

  safeExec(
    db,
    `
      CREATE TABLE IF NOT EXISTS telemetry_renderer_bundle_attempts (
        id TEXT PRIMARY KEY,
        checked_at INTEGER NOT NULL,
        manifest_url TEXT NOT NULL,
        source_channel TEXT,
        source_manifest_url_override INTEGER NOT NULL DEFAULT 0,
        source_error_reason TEXT,
        source_error_message TEXT,
        source_error_target TEXT,
        current_shell_version TEXT NOT NULL,
        active_version TEXT,
        active_content_hash TEXT,
        outcome TEXT NOT NULL,
        reason TEXT,
        manifest_version TEXT,
        manifest_content_hash TEXT,
        manifest_min_shell_version TEXT,
        manifest_bundle_url TEXT,
        required_shell_capabilities_count INTEGER NOT NULL DEFAULT 0,
        rollback_to_builtin INTEGER NOT NULL DEFAULT 0,
        rollback_reason TEXT,
        missing_shell_capabilities TEXT NOT NULL DEFAULT '[]',
        missing_runtime_assets TEXT NOT NULL DEFAULT '[]',
        missing_resources TEXT NOT NULL DEFAULT '[]',
        diagnostics TEXT NOT NULL DEFAULT '[]',
        error_message TEXT,
        synced_at INTEGER
      )
    `,
    logger,
  );
  safeExec(db, 'ALTER TABLE telemetry_renderer_bundle_attempts ADD COLUMN missing_runtime_assets TEXT NOT NULL DEFAULT \'[]\'', logger);
  safeExec(db, 'ALTER TABLE telemetry_renderer_bundle_attempts ADD COLUMN missing_resources TEXT NOT NULL DEFAULT \'[]\'', logger);
}

export function applyEvaluationCleanupMigration(db: BetterSqlite3.Database, logger: Logger): void {
  // 2026-05-19: 评测中心子系统下线，drop 不再使用的评测/审阅/反馈表 + 索引。
  // 保留 experiments / experiment_cases / session_events / telemetry_* 表 (testRunner 和 bug report 复现仍在用)。
  const sqlStatements = [
    'DROP TABLE IF EXISTS review_queue_failure_assets',
    'DROP TABLE IF EXISTS review_queue_items',
    'DROP TABLE IF EXISTS preview_feedback_items',
    'DROP TABLE IF EXISTS eval_snapshots',
    'DROP TABLE IF EXISTS evaluations',
    'DROP INDEX IF EXISTS idx_evaluations_session',
    'DROP INDEX IF EXISTS idx_evaluations_user_timestamp',
    'DROP INDEX IF EXISTS idx_evaluations_timestamp',
  ];
  for (const sql of sqlStatements) {
    safeExec(db, sql, logger);
  }
}
