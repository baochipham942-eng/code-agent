import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

function safeExec(db: BetterSqlite3.Database, sql: string, logger: Logger): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
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
  ];

  for (const sql of migrations) {
    safeExec(db, sql, logger);
  }

  // 2026-04-15: 彻底移除废弃的 sessions.generation_id 列
  // 背景：2026-04-12 的 refactor (8a68ee85) 把运行时 generationId 概念抹掉了，
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

  // telemetry_model_calls 新增 prompt/completion 列（用于评测系统重放）
  const modelCallMigrations = [
    'ALTER TABLE telemetry_model_calls ADD COLUMN prompt TEXT',
    'ALTER TABLE telemetry_model_calls ADD COLUMN completion TEXT',
  ];
  for (const sql of modelCallMigrations) {
    safeExec(db, sql, logger);
  }

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
}
