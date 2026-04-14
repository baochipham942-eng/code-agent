// ============================================================================
// SwarmTraceRepository — Swarm 运行/agent/事件三表持久化（ADR-010 #5）
// ============================================================================
//
// 表关系：
//   swarm_runs (1) ──< swarm_run_agents (N)
//   swarm_runs (1) ──< swarm_run_events (N)
//
// 写入路径要求 fire-and-forget 不阻塞主流程，外层 SwarmTraceWriter 串行
// 调度本 repo 的方法。本 repo 内部不做异步调度，只做同步 SQLite 操作。
// ============================================================================

import type BetterSqlite3 from 'better-sqlite3';
import { SWARM_TRACE } from '../../../../shared/constants/storage';
import type {
  SwarmRunRecord,
  SwarmRunAgentRecord,
  SwarmRunEventRecord,
  SwarmRunListItem,
  SwarmRunDetail,
  SwarmRunStatus,
  SwarmRunCoordinator,
  SwarmRunTrigger,
  SwarmEventLevel,
} from '../../../../shared/contract/swarmTrace';

type SQLiteRow = Record<string, unknown>;

function safeJSONParse<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function clampPayloadJson(payload: unknown): string {
  let json: string;
  try {
    json = JSON.stringify(payload ?? null);
  } catch {
    json = 'null';
  }
  if (json.length <= SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES) return json;
  return JSON.stringify({
    _truncated: true,
    _originalBytes: json.length,
    preview: json.slice(0, SWARM_TRACE.MAX_EVENT_PAYLOAD_BYTES - 64),
  });
}

export interface StartRunInput {
  id: string;
  sessionId: string | null;
  coordinator: SwarmRunCoordinator;
  startedAt: number;
  totalAgents: number;
  trigger: SwarmRunTrigger;
}

export interface CloseRunInput {
  id: string;
  status: SwarmRunStatus;
  endedAt: number;
  completedCount: number;
  failedCount: number;
  parallelPeak: number;
  totalTokensIn: number;
  totalTokensOut: number;
  totalToolCalls: number;
  totalCostUsd: number;
  errorSummary: string | null;
  aggregation: SwarmRunRecord['aggregation'];
}

export interface UpsertAgentInput {
  runId: string;
  agentId: string;
  name: string;
  role: string;
  status: SwarmRunAgentRecord['status'];
  startTime: number | null;
  endTime: number | null;
  durationMs: number | null;
  tokensIn: number;
  tokensOut: number;
  toolCalls: number;
  costUsd: number;
  error: string | null;
  failureCategory: string | null;
  filesChanged: string[];
}

export interface AppendEventInput {
  runId: string;
  seq: number;
  timestamp: number;
  eventType: string;
  agentId: string | null;
  level: SwarmEventLevel;
  title: string;
  summary: string;
  payload: unknown;
}

export class SwarmTraceRepository {
  constructor(private db: BetterSqlite3.Database) {}

  // --------------------------------------------------------------------------
  // 写入 API
  // --------------------------------------------------------------------------

  startRun(input: StartRunInput): void {
    this.db.prepare(`
      INSERT OR REPLACE INTO swarm_runs (
        id, session_id, coordinator, status, started_at, ended_at,
        total_agents, completed_count, failed_count, parallel_peak,
        total_tokens_in, total_tokens_out, total_tool_calls, total_cost_usd,
        trigger, error_summary, aggregation_json, tags_json
      ) VALUES (?, ?, ?, 'running', ?, NULL, ?, 0, 0, 0, 0, 0, 0, 0, ?, NULL, NULL, '[]')
    `).run(
      input.id,
      input.sessionId,
      input.coordinator,
      input.startedAt,
      input.totalAgents,
      input.trigger,
    );
  }

  closeRun(input: CloseRunInput): void {
    this.db.prepare(`
      UPDATE swarm_runs SET
        status = ?,
        ended_at = ?,
        completed_count = ?,
        failed_count = ?,
        parallel_peak = ?,
        total_tokens_in = ?,
        total_tokens_out = ?,
        total_tool_calls = ?,
        total_cost_usd = ?,
        error_summary = ?,
        aggregation_json = ?
      WHERE id = ?
    `).run(
      input.status,
      input.endedAt,
      input.completedCount,
      input.failedCount,
      input.parallelPeak,
      input.totalTokensIn,
      input.totalTokensOut,
      input.totalToolCalls,
      input.totalCostUsd,
      input.errorSummary,
      input.aggregation ? JSON.stringify(input.aggregation) : null,
      input.id,
    );
  }

  upsertAgent(input: UpsertAgentInput): void {
    this.db.prepare(`
      INSERT INTO swarm_run_agents (
        run_id, agent_id, name, role, status,
        start_time, end_time, duration_ms,
        tokens_in, tokens_out, tool_calls, cost_usd,
        error, failure_category, files_changed_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(run_id, agent_id) DO UPDATE SET
        name = excluded.name,
        role = excluded.role,
        status = excluded.status,
        start_time = excluded.start_time,
        end_time = excluded.end_time,
        duration_ms = excluded.duration_ms,
        tokens_in = excluded.tokens_in,
        tokens_out = excluded.tokens_out,
        tool_calls = excluded.tool_calls,
        cost_usd = excluded.cost_usd,
        error = excluded.error,
        failure_category = excluded.failure_category,
        files_changed_json = excluded.files_changed_json
    `).run(
      input.runId,
      input.agentId,
      input.name,
      input.role,
      input.status,
      input.startTime,
      input.endTime,
      input.durationMs,
      input.tokensIn,
      input.tokensOut,
      input.toolCalls,
      input.costUsd,
      input.error,
      input.failureCategory,
      JSON.stringify(input.filesChanged ?? []),
    );
  }

  appendEvent(input: AppendEventInput): void {
    // 超过单 run 事件上限时丢弃尾部事件，保住 head（reproducer 友好）。
    const countRow = this.db
      .prepare('SELECT COUNT(*) as c FROM swarm_run_events WHERE run_id = ?')
      .get(input.runId) as { c: number } | undefined;
    if ((countRow?.c ?? 0) >= SWARM_TRACE.MAX_EVENTS_PER_RUN) return;

    this.db.prepare(`
      INSERT INTO swarm_run_events (
        run_id, seq, timestamp, event_type, agent_id, level, title, summary, payload_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      input.runId,
      input.seq,
      input.timestamp,
      input.eventType,
      input.agentId,
      input.level,
      input.title,
      input.summary,
      clampPayloadJson(input.payload),
    );
  }

  // --------------------------------------------------------------------------
  // 读取 API
  // --------------------------------------------------------------------------

  listRuns(limit: number): SwarmRunListItem[] {
    const safeLimit = Math.max(1, Math.min(limit, SWARM_TRACE.MAX_LIST_LIMIT));
    const rows = this.db.prepare(`
      SELECT id, session_id, status, coordinator,
             started_at, ended_at,
             total_agents, completed_count, failed_count,
             total_cost_usd, total_tokens_in, total_tokens_out, trigger
      FROM swarm_runs
      ORDER BY started_at DESC
      LIMIT ?
    `).all(safeLimit) as SQLiteRow[];

    return rows.map((row): SwarmRunListItem => {
      const startedAt = row.started_at as number;
      const endedAt = (row.ended_at as number | null) ?? null;
      return {
        id: row.id as string,
        sessionId: (row.session_id as string | null) ?? null,
        status: row.status as SwarmRunStatus,
        coordinator: row.coordinator as SwarmRunCoordinator,
        startedAt,
        endedAt,
        durationMs: endedAt != null ? endedAt - startedAt : null,
        totalAgents: (row.total_agents as number) ?? 0,
        completedCount: (row.completed_count as number) ?? 0,
        failedCount: (row.failed_count as number) ?? 0,
        totalCostUsd: (row.total_cost_usd as number) ?? 0,
        totalTokensIn: (row.total_tokens_in as number) ?? 0,
        totalTokensOut: (row.total_tokens_out as number) ?? 0,
        trigger: row.trigger as SwarmRunTrigger,
      };
    });
  }

  getRunDetail(runId: string): SwarmRunDetail | null {
    const runRow = this.db.prepare('SELECT * FROM swarm_runs WHERE id = ?').get(runId) as
      | SQLiteRow
      | undefined;
    if (!runRow) return null;

    const run = this.mapRunRow(runRow);

    const agentRows = this.db
      .prepare('SELECT * FROM swarm_run_agents WHERE run_id = ? ORDER BY start_time ASC NULLS LAST')
      .all(runId) as SQLiteRow[];
    const agents = agentRows.map((row) => this.mapAgentRow(row));

    const eventRows = this.db
      .prepare('SELECT * FROM swarm_run_events WHERE run_id = ? ORDER BY seq ASC')
      .all(runId) as SQLiteRow[];
    const events = eventRows.map((row) => this.mapEventRow(row));

    return { run, agents, events };
  }

  deleteRun(runId: string): boolean {
    const result = this.db.prepare('DELETE FROM swarm_runs WHERE id = ?').run(runId);
    return result.changes > 0;
  }

  /** 仅供测试/维护使用：清空所有 swarm trace 数据 */
  clearAll(): void {
    this.db.exec('DELETE FROM swarm_run_events');
    this.db.exec('DELETE FROM swarm_run_agents');
    this.db.exec('DELETE FROM swarm_runs');
  }

  // --------------------------------------------------------------------------
  // 行映射
  // --------------------------------------------------------------------------

  private mapRunRow(row: SQLiteRow): SwarmRunRecord {
    return {
      id: row.id as string,
      sessionId: (row.session_id as string | null) ?? null,
      coordinator: row.coordinator as SwarmRunCoordinator,
      status: row.status as SwarmRunStatus,
      startedAt: row.started_at as number,
      endedAt: (row.ended_at as number | null) ?? null,
      totalAgents: (row.total_agents as number) ?? 0,
      completedCount: (row.completed_count as number) ?? 0,
      failedCount: (row.failed_count as number) ?? 0,
      parallelPeak: (row.parallel_peak as number) ?? 0,
      totalTokensIn: (row.total_tokens_in as number) ?? 0,
      totalTokensOut: (row.total_tokens_out as number) ?? 0,
      totalToolCalls: (row.total_tool_calls as number) ?? 0,
      totalCostUsd: (row.total_cost_usd as number) ?? 0,
      trigger: (row.trigger as SwarmRunTrigger) ?? 'unknown',
      errorSummary: (row.error_summary as string | null) ?? null,
      aggregation: safeJSONParse(row.aggregation_json, null as SwarmRunRecord['aggregation']),
      tags: safeJSONParse<string[]>(row.tags_json, []),
    };
  }

  private mapAgentRow(row: SQLiteRow): SwarmRunAgentRecord {
    return {
      runId: row.run_id as string,
      agentId: row.agent_id as string,
      name: (row.name as string) ?? '',
      role: (row.role as string) ?? '',
      status: row.status as SwarmRunAgentRecord['status'],
      startTime: (row.start_time as number | null) ?? null,
      endTime: (row.end_time as number | null) ?? null,
      durationMs: (row.duration_ms as number | null) ?? null,
      tokensIn: (row.tokens_in as number) ?? 0,
      tokensOut: (row.tokens_out as number) ?? 0,
      toolCalls: (row.tool_calls as number) ?? 0,
      costUsd: (row.cost_usd as number) ?? 0,
      error: (row.error as string | null) ?? null,
      failureCategory: (row.failure_category as string | null) ?? null,
      filesChanged: safeJSONParse<string[]>(row.files_changed_json, []),
    };
  }

  private mapEventRow(row: SQLiteRow): SwarmRunEventRecord {
    return {
      id: row.id as number,
      runId: row.run_id as string,
      seq: row.seq as number,
      timestamp: row.timestamp as number,
      eventType: row.event_type as string,
      agentId: (row.agent_id as string | null) ?? null,
      level: (row.level as SwarmEventLevel) ?? 'info',
      title: (row.title as string) ?? '',
      summary: (row.summary as string) ?? '',
      payload: safeJSONParse(row.payload_json, null),
    };
  }
}
