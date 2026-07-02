// ============================================================================
// Telemetry Schema - 会话遥测系统的表定义
// ============================================================================
// 从 schema.ts 平移抽出（纯代码搬移，无行为变更）。
// applySchema 在原有位置调用 applyTelemetrySchema，建表顺序不变。

import type BetterSqlite3 from 'better-sqlite3';
import { safeAlter, type Logger } from './schemaHelpers';

export function applyTelemetrySchema(db: BetterSqlite3.Database, logger: Logger): void {
  // ========================================================================
  // Telemetry Tables (会话遥测系统)
  // ========================================================================

  // Telemetry Sessions - 一行/会话，聚合指标
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
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
      status TEXT DEFAULT 'recording',
      agent_version TEXT,
      prompt_version TEXT,
      tool_schema_version TEXT
    )
  `);
  safeAlter(db, `ALTER TABLE telemetry_sessions ADD COLUMN user_id TEXT`, logger);

  // Telemetry Turns - 一行/轮次
  db.exec(`
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
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS telemetry_tool_calls (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          name TEXT NOT NULL,
          arguments TEXT,
          actual_arguments TEXT,
          result_summary TEXT,
      success INTEGER DEFAULT 0,
      error TEXT,
      error_category TEXT,
      computer_surface_failure_kind TEXT,
      computer_surface_mode TEXT,
      computer_surface_target_app TEXT,
      computer_surface_action TEXT,
      computer_surface_ax_quality_score REAL,
      computer_surface_ax_quality_grade TEXT,
      duration_ms INTEGER DEFAULT 0,
      timestamp INTEGER NOT NULL,
      idx INTEGER DEFAULT 0,
      parallel INTEGER DEFAULT 0
    )
  `);

  // Telemetry Events - 一行/时间线事件
  db.exec(`
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

  // Telemetry Raw Payloads - 诊断原始内容旁表（仅密钥掩码、不截断/不 PII）
  // 用于脱离用户机器复现 agent 轨迹；与聚合表分离，独立滚动淘汰，避免本地无限膨胀。
  db.exec(`
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
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_raw_payloads_session ON telemetry_raw_payloads(session_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_raw_payloads_turn ON telemetry_raw_payloads(turn_id)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_raw_payloads_created ON telemetry_raw_payloads(created_at)');

  // Telemetry Diagnostic Bundles - 本地排队表:失败 session 的脱敏诊断包,待上传
  db.exec(`
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
  `);
  db.exec('CREATE INDEX IF NOT EXISTS idx_diag_bundles_synced ON telemetry_diagnostic_bundles(synced_at)');
  db.exec('CREATE INDEX IF NOT EXISTS idx_diag_bundles_session ON telemetry_diagnostic_bundles(session_id)');

  // Telemetry Feedback - 用户对某次回复/轮次的显式质量反馈，云端仅 admin 可读
  db.exec(`
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
  `);

  // Renderer bundle hot-update attempts - 系统级热更状态上报，不混入 chat turn
  db.exec(`
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
  `);

}
