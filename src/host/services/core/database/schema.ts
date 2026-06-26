import type BetterSqlite3 from 'better-sqlite3';
import { applyTranscriptFtsSchema } from '../../../../shared/transcriptFts.sql';
import { applyMemoriesFtsSchema } from '../../../../shared/memoriesFts.sql';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

function tableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) as
    | { name?: string }
    | undefined;
  return row?.name === tableName;
}

function safeAlter(db: BetterSqlite3.Database, sql: string, logger: Logger): void {
  try {
    db.exec(sql);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes('duplicate column') && !msg.includes('already exists')) {
      logger.warn('[DB] Migration unexpected error:', msg);
    }
  }
}

export function applySchema(db: BetterSqlite3.Database, logger: Logger): void {
  // Sessions 表
  // 注：generation_id 列已废弃（2026-04-15）— 不在新 schema 中声明；
  // 老 DB 的残留列由 migrateSessionsTable 的 DROP COLUMN 清理
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT,
      title TEXT NOT NULL,
      model_provider TEXT NOT NULL,
      model_name TEXT NOT NULL,
      working_directory TEXT,
      session_type TEXT NOT NULL DEFAULT 'chat',
      origin TEXT,
      metadata TEXT,
      parent_session_id TEXT,
      source_run_id TEXT,
      agent_engine TEXT,
      memory_mode TEXT NOT NULL DEFAULT 'auto',
      suppressed_memory_entry_ids TEXT NOT NULL DEFAULT '[]',
      read_only INTEGER NOT NULL DEFAULT 0,
      retry_of_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      workbench_provenance TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      synced_at INTEGER
    )
  `);
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN user_id TEXT`, logger);
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN memory_mode TEXT NOT NULL DEFAULT 'auto'`, logger);
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN suppressed_memory_entry_ids TEXT NOT NULL DEFAULT '[]'`, logger);
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN metadata TEXT`, logger);

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
      compaction TEXT,
      metadata TEXT,
      is_meta INTEGER NOT NULL DEFAULT 0,
      visibility TEXT NOT NULL DEFAULT 'active',
      hidden_by_rewind_id TEXT,
      hidden_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Messages 表迁移（兼容老 DB）
  safeAlter(db, `ALTER TABLE messages ADD COLUMN attachments TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN thinking TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN effort_level TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN synced_at INTEGER`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN content_parts TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN metadata TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN is_meta INTEGER NOT NULL DEFAULT 0`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN compaction TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN visibility TEXT NOT NULL DEFAULT 'active'`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN hidden_by_rewind_id TEXT`, logger);
  safeAlter(db, `ALTER TABLE messages ADD COLUMN hidden_at INTEGER`, logger);

  db.exec(`
    CREATE TABLE IF NOT EXISTS session_rewinds (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      anchor_message_id TEXT NOT NULL,
      anchor_prompt TEXT NOT NULL,
      anchor_timestamp INTEGER NOT NULL,
      checkpoint_message_id TEXT,
      hidden_message_count INTEGER NOT NULL DEFAULT 0,
      hidden_message_ids TEXT NOT NULL DEFAULT '[]',
      files_restored INTEGER NOT NULL DEFAULT 0,
      files_deleted INTEGER NOT NULL DEFAULT 0,
      errors_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Tool Executions 表 (用于缓存和审计)
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

  // User Preferences 表 (用户偏好学习)
  db.exec(`
    CREATE TABLE IF NOT EXISTS user_preferences (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  // Project Knowledge 表 (项目知识库)
  db.exec(`
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

  // Session Tasks 表 (Task tool / planning taskStore 持久化)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_tasks (
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      subject TEXT NOT NULL,
      description TEXT NOT NULL,
      active_form TEXT NOT NULL,
      status TEXT NOT NULL,
      priority TEXT NOT NULL,
      owner TEXT,
      blocks_json TEXT NOT NULL DEFAULT '[]',
      blocked_by_json TEXT NOT NULL DEFAULT '[]',
      metadata_json TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, task_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  // 树状结构（roadmap 2.6）：子任务 id 形如 "1.1"，parent_task_id 指向父
  safeAlter(db, `ALTER TABLE session_tasks ADD COLUMN parent_task_id TEXT`, logger);

  // Session Task 事件日志（roadmap 2.6）— append-only 审计表
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      at INTEGER NOT NULL,
      kind TEXT NOT NULL,
      summary TEXT,
      actor TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_task_events_task ON session_task_events (session_id, task_id, at)`);

  // Permission Decisions 事件账本（ADR-022 第一期，append-only）—
  // 把权限 allow/deny/ask 决策链持久化（原来只在内存环形缓冲 50 条、重启即丢）。
  // 纯增量、不动现有表；只 INSERT/SELECT，永不 UPDATE/DELETE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS permission_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      summary TEXT,
      final_outcome TEXT NOT NULL,
      history_outcome TEXT NOT NULL,
      reason TEXT NOT NULL,
      duration_ms INTEGER NOT NULL,
      recorded_at INTEGER NOT NULL,
      trace_json TEXT
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_decisions_recorded ON permission_decisions (recorded_at)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_permission_decisions_session ON permission_decisions (session_id, recorded_at)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_permission_decisions_tool ON permission_decisions (tool_name, recorded_at)`);

  // Tool Execution Events 事件账本（ADR-022 第二期，append-only · 崩溃重放）—
  // 给账本加"工具执行生命周期"两个不可变事件：begin（放行后即将执行）/ complete（执行返回/抛错/被恢复确认）。
  // "崩溃那一刻正在执行的工具" = 有 begin 无 complete 的 execution_id；重启时 reduce 出未闭合执行即"现场"。
  // 纯增量、不动现有表；只 INSERT/SELECT，永不 UPDATE/DELETE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS tool_execution_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execution_id TEXT NOT NULL,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      summary TEXT,
      params_json TEXT,
      phase TEXT NOT NULL,
      status TEXT,
      error TEXT,
      recorded_at INTEGER NOT NULL
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_execution_events_exec ON tool_execution_events (execution_id)`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_execution_events_session ON tool_execution_events (session_id, recorded_at)`,
  );
  db.exec(`CREATE INDEX IF NOT EXISTS idx_tool_execution_events_phase ON tool_execution_events (phase, recorded_at)`);

  // Swarm Run Ledger 协同事件账本（ADR-022 §四第三期 3b · ADR-023 D2，append-only · 真理源）—
  // 让 append-only 事件流当 Swarm 协同轨迹的真理源，把可变 rollup 表（swarm_runs/swarm_run_agents）
  // 降级为可从本账重建的读优化缓存。事件 kind：run_started / agent_snapshot（末值覆盖）/ run_closed。
  // 与现有 swarm_run_events（timeline，超 2000 丢尾）不同：本表**不丢尾、不截断 rollup 关键字段**，
  // 与存储模式无关。无 FK（真理源不依赖 rollup 缓存表）。只 INSERT/SELECT，永不 UPDATE/DELETE。
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_run_ledger (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      session_id TEXT,
      seq INTEGER NOT NULL,
      event_kind TEXT NOT NULL,
      agent_id TEXT,
      payload_json TEXT,
      recorded_at INTEGER NOT NULL
    )
  `);
  // (run_id, seq) 唯一：账本 append-only 不可篡改的数据库级保护——同 run 同 seq 不得重复写入。
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_swarm_run_ledger_run ON swarm_run_ledger (run_id, seq)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_run_ledger_session ON swarm_run_ledger (session_id, recorded_at)`);

  // Master Tasks 表 (用户级工作单元，跨 session 持久化；P0-c2)
  // status 列保留 TEXT 不加 CHECK，枚举校验由应用层 (src/shared/contract/task.ts) 负责
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

  // Sessions 表加 master_task_id 关联列 (P0-c2; 后续 P0-c3 用)
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN master_task_id TEXT`, logger);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_master_task ON sessions(master_task_id)`);

  // Sessions 表加 plan_title 列：agent 调 TodoWrite 时可显式传 plan_title，
  // 作为单会话任务拆解视图的标题。NULL 时 UI 隐藏 plan title 行只显示
  // checklist。NULL/缺省的 legacy session 不回填——意图就是 "agent 没 plan"。
  safeAlter(db, `ALTER TABLE sessions ADD COLUMN plan_title TEXT`, logger);

  // Context Interventions 表 (pin/exclude/retain 手动上下文选择)
  db.exec(`
    CREATE TABLE IF NOT EXISTS context_interventions (
      session_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'global',
      message_id TEXT NOT NULL,
      action TEXT NOT NULL,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (session_id, agent_id, message_id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Session runtime state 表 (compression state / persistent system context 恢复)
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_runtime_state (
      session_id TEXT PRIMARY KEY,
      compression_state_json TEXT,
      persistent_system_context_json TEXT NOT NULL DEFAULT '[]',
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // Audit Log 表 (审计日志)
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT,
      event_type TEXT NOT NULL,
      event_data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);

  // Memories 表 (记忆存储)
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

  // Memories FTS5 — BM25 检索通道（roadmap 2.5，searchMemories 召回底层）
  // DDL 在 src/shared/memoriesFts.sql.ts（与 CLI / 单测共用）
  applyMemoriesFtsSchema(db);

  // Cron Jobs 表 (定时任务)
  db.exec(`
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
  db.exec(`
    CREATE TABLE IF NOT EXISTS cron_executions (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      scheduled_at INTEGER NOT NULL,
      started_at INTEGER,
      completed_at INTEGER,
      duration INTEGER,
      result TEXT,
      error TEXT,
      retry_attempt INTEGER NOT NULL DEFAULT 0,
      exit_code INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL,
      FOREIGN KEY (job_id) REFERENCES cron_jobs(id) ON DELETE CASCADE
    )
  `);

  safeAlter(db, 'ALTER TABLE cron_executions ADD COLUMN session_id TEXT', logger);

  // Session Automations 表：把 cron / heartbeat / loop / role wake 按 source session 串回原会话
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_automations (
      id TEXT PRIMARY KEY,
      source_session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      cadence_label TEXT,
      next_run_at INTEGER,
      last_run_at INTEGER,
      source_ref_id TEXT,
      result_session_id TEXT,
      config_json TEXT DEFAULT '{}',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (source_session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (result_session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `);
  safeAlter(db, 'ALTER TABLE session_automations ADD COLUMN cadence_label TEXT', logger);
  safeAlter(db, 'ALTER TABLE session_automations ADD COLUMN next_run_at INTEGER', logger);
  safeAlter(db, 'ALTER TABLE session_automations ADD COLUMN last_run_at INTEGER', logger);
  safeAlter(db, 'ALTER TABLE session_automations ADD COLUMN source_ref_id TEXT', logger);
  safeAlter(db, 'ALTER TABLE session_automations ADD COLUMN result_session_id TEXT', logger);
  safeAlter(db, "ALTER TABLE session_automations ADD COLUMN config_json TEXT DEFAULT '{}'", logger);

  // Heartbeats 表 (心跳配置)
  db.exec(`
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
  db.exec(`
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
  db.exec(`
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

  // Captures 表 (知识库采集内容持久化)
  db.exec(`
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

  // Experiments 表 (统一评测数据)
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiments (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      model TEXT,
      provider TEXT,
      scope TEXT DEFAULT 'full',
      config_json TEXT,
      summary_json TEXT NOT NULL,
      source TEXT DEFAULT 'test-runner',
      git_commit TEXT
    )
  `);

  // Experiment Cases 表 (评测用例结果)
  db.exec(`
    CREATE TABLE IF NOT EXISTS experiment_cases (
      id TEXT PRIMARY KEY,
      experiment_id TEXT NOT NULL,
      case_id TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      score INTEGER NOT NULL,
      duration_ms INTEGER,
      data_json TEXT,
      FOREIGN KEY (experiment_id) REFERENCES experiments(id) ON DELETE CASCADE
    )
  `);

  // Experiments 表迁移（必须在建表之后跑；新库建表前 ALTER 会被 SQLite 当成 no such table）。
  safeAlter(db, 'ALTER TABLE experiments ADD COLUMN git_commit TEXT', logger);
  safeAlter(db, 'ALTER TABLE experiment_cases ADD COLUMN session_id TEXT', logger);

  // Artifact Issues / Eval Replay Quality Reports（Agent Neo product closure）
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_issues (
      issue_id TEXT PRIMARY KEY,
      artifact_id TEXT NOT NULL,
      artifact_kind TEXT NOT NULL,
      trace_id TEXT NOT NULL,
      trace_source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replay_key TEXT NOT NULL,
      source TEXT NOT NULL,
      code TEXT NOT NULL,
      severity TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      message TEXT NOT NULL,
      run_id TEXT,
      case_id TEXT,
      owner TEXT,
      repair_instruction TEXT,
      anchors_json TEXT NOT NULL DEFAULT '[]',
      decision_trace_json TEXT,
      admin_review_json TEXT,
      related_issue_ids_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  safeAlter(db, 'ALTER TABLE artifact_issues ADD COLUMN admin_review_json TEXT', logger);

  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_issue_evidence (
      issue_id TEXT NOT NULL,
      evidence_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      ref TEXT NOT NULL,
      summary TEXT NOT NULL,
      data_source TEXT,
      sensitivity TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (issue_id, evidence_id),
      FOREIGN KEY (issue_id) REFERENCES artifact_issues(issue_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_artifact_issues_trace
    ON artifact_issues(trace_id, replay_key)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_artifact_issues_status
    ON artifact_issues(status, severity, updated_at)
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_replay_quality_reports (
      report_id TEXT PRIMARY KEY,
      trace_id TEXT NOT NULL,
      trace_source TEXT NOT NULL,
      session_id TEXT NOT NULL,
      replay_key TEXT NOT NULL,
      status TEXT NOT NULL,
      run_id TEXT,
      case_id TEXT,
      report_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);

  // ========================================================================
  // Swarm Trace 持久化表（ADR-010 #5）
  // ========================================================================

  // swarm_runs - 一行/swarm 运行
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      coordinator TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER,
      total_agents INTEGER NOT NULL DEFAULT 0,
      completed_count INTEGER NOT NULL DEFAULT 0,
      failed_count INTEGER NOT NULL DEFAULT 0,
      parallel_peak INTEGER NOT NULL DEFAULT 0,
      total_tokens_in INTEGER NOT NULL DEFAULT 0,
      total_tokens_out INTEGER NOT NULL DEFAULT 0,
      total_tool_calls INTEGER NOT NULL DEFAULT 0,
      total_cost_usd REAL NOT NULL DEFAULT 0,
      trigger TEXT NOT NULL DEFAULT 'unknown',
      error_summary TEXT,
      aggregation_json TEXT,
      tags_json TEXT NOT NULL DEFAULT '[]'
    )
  `);

  // swarm_run_agents - 每个 agent 的 rollup（以 run_id + agent_id 为复合主键）
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_run_agents (
      run_id TEXT NOT NULL,
      agent_id TEXT NOT NULL,
      name TEXT NOT NULL DEFAULT '',
      role TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL,
      start_time INTEGER,
      end_time INTEGER,
      duration_ms INTEGER,
      tokens_in INTEGER NOT NULL DEFAULT 0,
      tokens_out INTEGER NOT NULL DEFAULT 0,
      tool_calls INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      failure_category TEXT,
      files_changed_json TEXT NOT NULL DEFAULT '[]',
      PRIMARY KEY (run_id, agent_id),
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    )
  `);

  // swarm_run_events - run timeline 事件
  db.exec(`
    CREATE TABLE IF NOT EXISTS swarm_run_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      timestamp INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      agent_id TEXT,
      level TEXT NOT NULL DEFAULT 'info',
      title TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      payload_json TEXT,
      FOREIGN KEY (run_id) REFERENCES swarm_runs(id) ON DELETE CASCADE
    )
  `);

  // pending_approvals - plan/launch gate 待决请求持久化（ADR-010 #2）
  // 一张表统一两类 gate，kind 列区分；payload_json 用于 hydrate 回填内存 Map
  db.exec(`
    CREATE TABLE IF NOT EXISTS pending_approvals (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      agent_id TEXT,
      agent_name TEXT,
      coordinator_id TEXT,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL,
      submitted_at INTEGER NOT NULL,
      resolved_at INTEGER,
      feedback TEXT
    )
  `);

  // Episodic FTS5 index — full-text search over session messages
  // 支持 Hermes 四层记忆里的 episodic recall：LLM 通过 EpisodicRecall 工具
  // 用关键词回查历史会话原文。用 triggers 自动同步 messages 表，应用层无感知。
  // tokenizer trigram —— 同时支持中英文 3+ 字符的子串匹配，避开 unicode61
  // 对 CJK 连续字符当一个 token 的限制
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

  // 自动同步 triggers — 任何往 messages 表写的代码路径都会被 catch
  // Recreate insert/update triggers so existing DBs pick up meta/loop filtering.
  db.exec(`
    DROP TRIGGER IF EXISTS messages_ai_fts;
    DROP TRIGGER IF EXISTS messages_au_fts;
  `);

  // AFTER INSERT：新消息追加到 FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      SELECT new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp
      WHERE COALESCE(new.is_meta, 0) = 0
        AND COALESCE(new.content, '') NOT LIKE '%【循环模式 · 第%轮】%'
        AND COALESCE(new.content, '') NOT LIKE '%[[LOOP_WAIT]]%';
    END
  `);

  // AFTER DELETE：级联删除 FTS 行
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END
  `);

  // AFTER UPDATE OF content/is_meta：刷新 FTS；tool_calls / tool_results 更新不触发，
  // 避免流式调用时的无效写。is_meta 变化时必须能把旧索引删掉。
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

  // Clean stale rows inserted before the triggers learned about hidden/meta loop turns.
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

  // Transcript FTS5 — 按 kind 分解的转录全文索引（roadmap 2.1，History 工具底层）
  // 表 + triggers 的 DDL 在 src/shared/transcriptFts.sql.ts（与 CLI / 单测共用）
  applyTranscriptFtsSchema(db);

  // Turn Snapshots — 调试快照（与 CLIDatabaseService 共用同一张表）
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

  // Compaction Snapshots — 上下文压缩前后快照
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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);

  // ========================================================================
  // dynamic-workflow resumable journal（P4-B）
  // ========================================================================
  // workflow_runs (1) ──< workflow_run_calls (N)
  // resumable 重放靠逐 agent() 调用的「位置序 call_index + prompt/opts 内容 hash」缓存命中。
  // 不 FK 到 sessions：workflow journal 独立于会话生命周期（会话删了仍可 resume / 审计）。

  // workflow_runs - 一行/workflow run 的元数据 + 终态结果
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_runs (
      run_id TEXT PRIMARY KEY,
      script_hash TEXT NOT NULL,
      goal TEXT,
      session_id TEXT,
      status TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      tokens_spent INTEGER NOT NULL DEFAULT 0,
      result_json TEXT,
      error TEXT,
      working_directory TEXT
    )
  `);
  // 旧 DB 补列：删除 run 记录前可据此抢救工作目录的文件改动成 patch
  safeAlter(db, `ALTER TABLE workflow_runs ADD COLUMN working_directory TEXT`, logger);

  // workflow_run_calls - 逐 agent() 调用的结果缓存（仅成功调用），按 run_id + call_index 复合主键
  db.exec(`
    CREATE TABLE IF NOT EXISTS workflow_run_calls (
      run_id TEXT NOT NULL,
      call_index INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'done',
      label TEXT,
      result_json TEXT NOT NULL,
      tokens_used INTEGER NOT NULL DEFAULT 0,
      ts INTEGER NOT NULL,
      PRIMARY KEY (run_id, call_index),
      FOREIGN KEY (run_id) REFERENCES workflow_runs(run_id) ON DELETE CASCADE
    )
  `);

  // Projects 表 (P0-2 项目空间容器) — 项目 = 目标 + 产物 + 角色 + 会话
  // 1:1 绑定 workspace（独立 ID）；workspace_key 接管项目记忆目录（内部文档 §3.1）
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      workspace_path TEXT,
      workspace_key TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      description TEXT,
      is_deleted INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER
    )
  `);
  db.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_key ON projects(workspace_key) WHERE workspace_key IS NOT NULL`,
  );

  // Project Goals 表 — 一个项目多个并行 goal，各自带状态
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_goals (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      goal TEXT NOT NULL,
      verify TEXT,
      review TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      last_run_session_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_project_goals_project ON project_goals(project_id)`);

  // Project Roles 表 — 角色入驻项目（join 表，D6）
  db.exec(`
    CREATE TABLE IF NOT EXISTS project_roles (
      project_id TEXT NOT NULL,
      role_id TEXT NOT NULL,
      joined_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, role_id),
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);
}
