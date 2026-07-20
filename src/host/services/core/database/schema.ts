 
import type BetterSqlite3 from 'better-sqlite3';
import { applyTelemetrySchema } from './schemaTelemetry';
import { safeAlter, type Logger } from './schemaHelpers';
import { applyTranscriptFtsSchema } from '../../../../shared/transcriptFts.sql';
import { applyMemoriesFtsSchema } from '../../../../shared/memoriesFts.sql';



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
  // (execution_id, phase) 复合索引前缀覆盖旧的单列 execution_id 索引，并让启动时
  // getOpenExecutions 的 NOT EXISTS 反连接走 execution_id 探测——缺它时 planner 选
  // phase 索引，begin×complete 全交叉，大账本上实测 1.8s（启动关键路径）。
  db.exec(`DROP INDEX IF EXISTS idx_tool_execution_events_exec`);
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_tool_execution_events_exec_phase ON tool_execution_events (execution_id, phase)`,
  );
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

  applyTelemetrySchema(db, logger);

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

  // queued_inputs - queued next-turn input durable ledger (ADR-044 D1)
  db.exec(`
    CREATE TABLE IF NOT EXISTS queued_inputs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      envelope_json TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_queued_inputs_session
    ON queued_inputs (session_id, status, created_at)
  `);

  // Agent Neo native Generative UI. Mutable state remains local by design;
  // the source message's neo_ui fence is the cross-device initial truth.
  db.exec(`
    CREATE TABLE IF NOT EXISTS generative_ui_instances (
      instance_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      source_message_id TEXT NOT NULL,
      source_ordinal INTEGER NOT NULL,
      source_key TEXT NOT NULL UNIQUE,
      spec_hash TEXT NOT NULL,
      spec_json TEXT NOT NULL,
      state_json TEXT NOT NULL,
      state_revision INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      error TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (source_message_id) REFERENCES messages(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS generative_ui_events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      node_id TEXT NOT NULL,
      spec_hash TEXT NOT NULL,
      base_state_revision INTEGER NOT NULL,
      intent TEXT NOT NULL,
      payload_json TEXT,
      idempotency_key TEXT NOT NULL UNIQUE,
      result_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES generative_ui_instances(instance_id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS execution_manifests (
      manifest_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      instance_id TEXT NOT NULL,
      nonce TEXT NOT NULL,
      scope_hash TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      items_json TEXT NOT NULL,
      status TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      resolved_at INTEGER,
      invalidation_reason TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (instance_id) REFERENCES generative_ui_instances(instance_id) ON DELETE CASCADE
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
  // 一次性历史补救，用 user_version 做门：这条 DELETE 的子查询要全表扫 messages 的
  // content（双 LIKE），大库上实测 ~4s，曾是启动 health-ready 的最大单项。跑过一次
  // 之后 triggers 已保证增量正确，无需每次启动重扫。
  const cleanupVersion = db.pragma('user_version', { simple: true }) as number;
  if (cleanupVersion < 1) {
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
    db.pragma('user_version = 1');
  }

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
      shape_hash_before TEXT,
      shape_hash_after TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `);
  // WP2-2b prefixHash 归因：请求前缀 shape hash（仅 telemetry 诊断）
  safeAlter(db, 'ALTER TABLE compaction_snapshots ADD COLUMN shape_hash_before TEXT', logger);
  safeAlter(db, 'ALTER TABLE compaction_snapshots ADD COLUMN shape_hash_after TEXT', logger);

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

  // Neo Tag Work Cards (P0) - project-scoped shared work contracts.
  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_work_cards (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      source_conversation_id TEXT NOT NULL,
      source_turn_id TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      title TEXT NOT NULL,
      status TEXT NOT NULL,
      current_revision_id TEXT NOT NULL,
      approved_revision_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived_at INTEGER,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_work_card_revisions (
      id TEXT PRIMARY KEY,
      work_card_id TEXT NOT NULL,
      revision_number INTEGER NOT NULL,
      intent TEXT NOT NULL,
      task_summary TEXT NOT NULL,
      read_scope_json TEXT NOT NULL,
      write_scope_json TEXT NOT NULL,
      model_intent_json TEXT NOT NULL,
      memory_plan_json TEXT NOT NULL,
      expected_outputs_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      assumptions_json TEXT NOT NULL DEFAULT '[]',
      created_by_user_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      UNIQUE(work_card_id, revision_number),
      FOREIGN KEY (work_card_id) REFERENCES neo_work_cards(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_work_card_approvals (
      id TEXT PRIMARY KEY,
      work_card_id TEXT NOT NULL,
      revision_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      requester_user_id TEXT NOT NULL,
      approved_by_user_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      approved_read_scope_json TEXT NOT NULL,
      approved_write_scope_json TEXT NOT NULL,
      approved_model_intent_json TEXT NOT NULL,
      approved_memory_plan_json TEXT NOT NULL,
      feedback TEXT,
      expires_at INTEGER,
      created_at INTEGER NOT NULL,
      revoked_at INTEGER,
      superseded_by_revision_id TEXT,
      FOREIGN KEY (work_card_id) REFERENCES neo_work_cards(id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id) REFERENCES neo_work_card_revisions(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_work_card_deltas (
      id TEXT PRIMARY KEY,
      work_card_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      conversation_id TEXT,
      completed_json TEXT NOT NULL DEFAULT '[]',
      changed_files_json TEXT NOT NULL DEFAULT '[]',
      decisions_json TEXT NOT NULL DEFAULT '[]',
      open_questions_json TEXT NOT NULL DEFAULT '[]',
      risks_json TEXT NOT NULL DEFAULT '[]',
      memory_candidates_json TEXT NOT NULL DEFAULT '[]',
      next_step TEXT,
      created_at INTEGER NOT NULL,
      FOREIGN KEY (work_card_id) REFERENCES neo_work_cards(id) ON DELETE CASCADE
    )
  `);
  // 跨会话 topic（ADR-035）：老库补轮会话归属列（新库上面 CREATE 已含）
  safeAlter(db, `ALTER TABLE neo_work_card_deltas ADD COLUMN conversation_id TEXT`, logger);

  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_work_card_result_reviews (
      id TEXT PRIMARY KEY,
      work_card_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      actor_user_id TEXT NOT NULL,
      decision TEXT NOT NULL,
      feedback TEXT,
      open_questions_json TEXT NOT NULL DEFAULT '[]',
      created_at INTEGER NOT NULL,
      FOREIGN KEY (work_card_id) REFERENCES neo_work_cards(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS neo_memory_candidates (
      id TEXT PRIMARY KEY,
      work_card_id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      revision_id TEXT,
      delta_id TEXT,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      decided_by_user_id TEXT,
      decided_at INTEGER,
      rejection_reason TEXT,
      written_at INTEGER,
      written_memory_key TEXT,
      FOREIGN KEY (work_card_id) REFERENCES neo_work_cards(id) ON DELETE CASCADE,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
      FOREIGN KEY (revision_id) REFERENCES neo_work_card_revisions(id) ON DELETE SET NULL,
      FOREIGN KEY (delta_id) REFERENCES neo_work_card_deltas(id) ON DELETE SET NULL
    )
  `);
}
