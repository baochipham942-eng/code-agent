import type BetterSqlite3 from 'better-sqlite3';
import type { createLogger } from '../../infra/logger';

type Logger = ReturnType<typeof createLogger>;

function tableExists(db: BetterSqlite3.Database, tableName: string): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name = ?").get(tableName) as { name?: string } | undefined;
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
      parent_session_id TEXT,
      source_run_id TEXT,
      agent_engine TEXT,
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

  // Experiments 表迁移
  safeAlter(db, 'ALTER TABLE experiments ADD COLUMN git_commit TEXT', logger);
  safeAlter(db, 'ALTER TABLE experiment_cases ADD COLUMN session_id TEXT', logger);

  // Evaluations 表版本化扩展
  if (tableExists(db, 'evaluations')) {
    const evalMigrations = ['ALTER TABLE evaluations ADD COLUMN snapshot_id TEXT', "ALTER TABLE evaluations ADD COLUMN eval_version TEXT DEFAULT 'legacy'", 'ALTER TABLE evaluations ADD COLUMN rubric_version TEXT', 'ALTER TABLE evaluations ADD COLUMN judge_model TEXT', 'ALTER TABLE evaluations ADD COLUMN judge_prompt_hash TEXT'];
    for (const sql of evalMigrations) {
      safeAlter(db, sql, logger);
    }
  } else {
    logger.debug('[DB] Skipping evaluation migrations because evaluations table does not exist yet');
  }

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

  // Entity relations table (for proactive context)
  db.exec(`
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

  // Eval Snapshots 表 (统一评测快照)
  db.exec(`
    CREATE TABLE IF NOT EXISTS eval_snapshots (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      data_json TEXT NOT NULL,
      hash TEXT NOT NULL
    )
  `);

  // Evaluations 表 (评测结果)
  db.exec(`
    CREATE TABLE IF NOT EXISTS evaluations (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      user_id TEXT,
      timestamp INTEGER NOT NULL,
      score INTEGER NOT NULL,
      grade TEXT NOT NULL,
      data TEXT NOT NULL
    )
  `);
  safeAlter(db, `ALTER TABLE evaluations ADD COLUMN user_id TEXT`, logger);

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
      source TEXT DEFAULT 'test-runner'
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
  // AFTER INSERT：新消息追加到 FTS
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ai_fts AFTER INSERT ON messages BEGIN
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
    END
  `);

  // AFTER DELETE：级联删除 FTS 行
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_ad_fts AFTER DELETE ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
    END
  `);

  // AFTER UPDATE OF content：只在 content 变化时刷新 FTS（tool_calls / tool_results
  // 更新不触发，避免流式调用时的无效写）
  db.exec(`
    CREATE TRIGGER IF NOT EXISTS messages_au_fts AFTER UPDATE OF content ON messages BEGIN
      DELETE FROM session_messages_fts WHERE message_id = old.id;
      INSERT INTO session_messages_fts (message_id, session_id, role, content, timestamp)
      VALUES (new.id, new.session_id, new.role, COALESCE(new.content, ''), new.timestamp);
    END
  `);

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
}
