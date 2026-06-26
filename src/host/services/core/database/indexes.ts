import type BetterSqlite3 from 'better-sqlite3';

export function applyIndexes(db: BetterSqlite3.Database): void {
  // 基础索引
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);
    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_session ON tool_executions(session_id);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_hash ON tool_executions(arguments_hash);
    CREATE INDEX IF NOT EXISTS idx_tool_executions_expires ON tool_executions(expires_at);
    CREATE INDEX IF NOT EXISTS idx_project_knowledge_path ON project_knowledge(project_path);
    CREATE INDEX IF NOT EXISTS idx_todos_session ON todos(session_id);
    CREATE INDEX IF NOT EXISTS idx_session_tasks_session ON session_tasks(session_id);
    CREATE INDEX IF NOT EXISTS idx_context_interventions_session_agent ON context_interventions(session_id, agent_id);
    CREATE INDEX IF NOT EXISTS idx_session_runtime_state_updated ON session_runtime_state(updated_at);
    CREATE INDEX IF NOT EXISTS idx_audit_log_session ON audit_log(session_id);
    CREATE INDEX IF NOT EXISTS idx_audit_log_type ON audit_log(event_type);
    CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(type);
    CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
    CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
    CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project_path);
    CREATE INDEX IF NOT EXISTS idx_memories_session ON memories(session_id);
  `);

  // Experiment indexes
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_experiments_timestamp ON experiments(timestamp DESC);
    CREATE INDEX IF NOT EXISTS idx_experiments_source ON experiments(source);
    CREATE INDEX IF NOT EXISTS idx_experiment_cases_experiment ON experiment_cases(experiment_id);
  `);

  // 性能优化：复合索引（首轮响应加速）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_status_updated ON sessions(status, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_user_updated ON sessions(user_id, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_type_updated ON sessions(session_type, updated_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_timestamp ON messages(session_id, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_session_visibility_timestamp ON messages(session_id, visibility, timestamp DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_messages_hidden_by_rewind ON messages(hidden_by_rewind_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_rewinds_session_created ON session_rewinds(session_id, created_at DESC)`);

  // Cron 相关索引
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_jobs_enabled ON cron_jobs(enabled)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_job ON cron_executions(job_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_session ON cron_executions(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_status ON cron_executions(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cron_executions_scheduled ON cron_executions(scheduled_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_automations_source ON session_automations(source_session_id, status, next_run_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_automations_ref ON session_automations(type, source_ref_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_heartbeats_enabled ON heartbeats(enabled)`);

  // Sync optimization: index for finding unsynced sessions
  db.exec(`CREATE INDEX IF NOT EXISTS idx_sessions_synced_at ON sessions(synced_at)`);

  // Session Events indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_session ON session_events(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_type ON session_events(event_type)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_session_events_timestamp ON session_events(session_id, timestamp)`);

  // Turn Snapshots indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_snapshots_session ON turn_snapshots(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_turn_snapshots_created ON turn_snapshots(created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_session ON compaction_snapshots(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_compaction_snapshots_created ON compaction_snapshots(created_at)`);

  // File Checkpoints indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_session ON file_checkpoints(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_message ON file_checkpoints(message_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_file_checkpoints_created ON file_checkpoints(created_at)`);

  // Telemetry indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_start ON telemetry_sessions(start_time DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_sessions_user_start ON telemetry_sessions(user_id, start_time DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_turns_session ON telemetry_turns(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_turns_session_num ON telemetry_turns(session_id, turn_number)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_model_calls_turn ON telemetry_model_calls(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_model_calls_session ON telemetry_model_calls(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_turn ON telemetry_tool_calls(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_session ON telemetry_tool_calls(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_tool_calls_name ON telemetry_tool_calls(name)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_turn ON telemetry_events(turn_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_events_session ON telemetry_events(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_feedback_session ON telemetry_feedback(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_feedback_synced ON telemetry_feedback(synced_at, created_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_renderer_bundle_attempts_checked ON telemetry_renderer_bundle_attempts(checked_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_renderer_bundle_attempts_synced ON telemetry_renderer_bundle_attempts(synced_at, checked_at)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_telemetry_renderer_bundle_attempts_outcome ON telemetry_renderer_bundle_attempts(outcome, reason)`);

  // Captures indexes
  db.exec(`CREATE INDEX IF NOT EXISTS idx_captures_source ON captures(source)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_captures_created ON captures(created_at DESC)`);

  // Swarm trace indexes（ADR-010 #5）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_runs_started ON swarm_runs(started_at DESC)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_runs_session ON swarm_runs(session_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_runs_status ON swarm_runs(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_run_agents_run ON swarm_run_agents(run_id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_swarm_run_events_run_seq ON swarm_run_events(run_id, seq)`);

  // Pending approvals indexes（ADR-010 #2）
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_approvals_status ON pending_approvals(status)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_pending_approvals_kind_status ON pending_approvals(kind, status)`);
}
