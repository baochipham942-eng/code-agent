import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import type { Message } from '../../shared/contract/message';
import type { PermissionDecisionRecord } from '../../host/services/core/repositories/PermissionDecisionRepository';
import type { ToolExecutionEventRecord } from '../../host/services/core/repositories/ToolExecutionEventRepository';
import type { SwarmRunEventRecord, SwarmRunListItem } from '../../shared/contract/swarmTrace';
import type { TaskEventInput } from '../../host/services/core/sessionLedgerProjection';
import type { SessionLedgerCost } from '../../shared/contract/sessionLedger';

type Row = Record<string, unknown>;

export interface SessionListItem {
  id: string;
  title: string;
  modelProvider: string;
  modelName: string;
  project: string | null;
  status: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

export interface TelemetryTurnBoundary {
  turnId: string;
  turnNumber: number;
  startTime: number;
  endTime: number;
  durationMs: number;
  outcomeStatus: string;
  agentId: string | null;
  turnType: string;
}

export interface TelemetryToolRow {
  toolCallId: string;
  turnId: string;
  name: string;
  success: boolean;
  error: string | null;
  durationMs: number;
  timestamp: number;
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (typeof value !== 'string' || value.length === 0) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function rowToMessage(row: Row): Message {
  return {
    id: String(row.id),
    role: String(row.role) as Message['role'],
    content: String(row.content ?? ''),
    timestamp: Number(row.timestamp),
    toolCalls: parseJson(row.tool_calls, undefined),
    toolResults: parseJson(row.tool_results, undefined),
    contentParts: parseJson(row.content_parts, undefined),
    thinking: optionalString(row.thinking),
    metadata: parseJson(row.metadata, undefined),
    ...(Number(row.is_meta ?? 0) !== 0 ? { isMeta: true } : {}),
  };
}

/**
 * Query-only view over the production database. This class never creates a
 * directory, runs schema migrations, changes journal mode, or writes a row.
 */
export class ReadOnlySessionDatabase {
  private readonly db: Database.Database;

  constructor(readonly dbPath: string) {
    if (!fs.existsSync(dbPath)) {
      throw new Error(`数据库不存在: ${dbPath}`);
    }
    this.db = new Database(dbPath, { readonly: true, fileMustExist: true });
    this.db.pragma('query_only = ON');
  }

  close(): void {
    this.db.close();
  }

  getNativeDatabase(): Database.Database {
    return this.db;
  }

  hasTable(table: string): boolean {
    return this.db.prepare(
      `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1`,
    ).get(table) !== undefined;
  }

  private safeAll(sql: string, ...params: unknown[]): Row[] {
    try {
      return this.db.prepare(sql).all(...params) as Row[];
    } catch {
      return [];
    }
  }

  private safeGet(sql: string, ...params: unknown[]): Row | undefined {
    try {
      return this.db.prepare(sql).get(...params) as Row | undefined;
    } catch {
      return undefined;
    }
  }

  getSession(sessionId: string): SessionListItem | null {
    const row = this.safeGet(`
      SELECT s.id, s.title, s.model_provider, s.model_name, s.working_directory,
             s.status, s.created_at, s.updated_at, COUNT(m.id) AS message_count
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
      WHERE s.id = ? GROUP BY s.id
    `, sessionId);
    return row ? this.mapSession(row) : null;
  }

  listSessions(options: { project?: string; limit: number }): SessionListItem[] {
    const project = options.project ? path.resolve(options.project) : undefined;
    const where = project
      ? `WHERE COALESCE(s.status, 'idle') != 'archived' AND (s.working_directory = ? OR s.workspace = ?)`
      : `WHERE COALESCE(s.status, 'idle') != 'archived'`;
    const params = project ? [project, project, options.limit] : [options.limit];
    return this.safeAll(`
      SELECT s.id, s.title, s.model_provider, s.model_name, s.working_directory,
             s.status, s.created_at, s.updated_at, COUNT(m.id) AS message_count
      FROM sessions s LEFT JOIN messages m ON m.session_id = s.id
      ${where}
      GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ?
    `, ...params).map((row) => this.mapSession(row));
  }

  private mapSession(row: Row): SessionListItem {
    return {
      id: String(row.id),
      title: String(row.title ?? ''),
      modelProvider: String(row.model_provider ?? ''),
      modelName: String(row.model_name ?? ''),
      project: optionalString(row.working_directory) ?? null,
      status: String(row.status ?? 'idle'),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      messageCount: Number(row.message_count ?? 0),
    };
  }

  getMessages(sessionId: string, limit = 500): Message[] {
    return this.safeAll(`
      SELECT id, role, content, timestamp, tool_calls, tool_results, content_parts,
             thinking, metadata, is_meta
      FROM messages WHERE session_id = ? ORDER BY timestamp ASC LIMIT ?
    `, sessionId, limit).map(rowToMessage);
  }

  getTaskEvents(sessionId: string, limit = 200): TaskEventInput[] {
    return this.safeAll(`
      SELECT task_id, at, kind, summary, actor FROM session_task_events
      WHERE session_id = ? ORDER BY at ASC, id ASC LIMIT ?
    `, sessionId, limit).map((row) => ({
      taskId: String(row.task_id), at: Number(row.at), kind: String(row.kind),
      summary: optionalString(row.summary), actor: optionalString(row.actor),
    }));
  }

  getPermissionDecisions(sessionId: string, limit = 200): PermissionDecisionRecord[] {
    return this.safeAll(`
      SELECT * FROM permission_decisions WHERE session_id = ?
      ORDER BY recorded_at ASC, id ASC LIMIT ?
    `, sessionId, limit).map((row) => ({
      id: Number(row.id), sessionId: optionalString(row.session_id) ?? null,
      toolName: String(row.tool_name), summary: optionalString(row.summary) ?? null,
      finalOutcome: String(row.final_outcome), historyOutcome: String(row.history_outcome),
      reason: String(row.reason ?? ''), durationMs: Number(row.duration_ms ?? 0),
      recordedAt: Number(row.recorded_at), trace: parseJson(row.trace_json, null),
    }));
  }

  getExecutionEvents(sessionId: string, limit = 200): ToolExecutionEventRecord[] {
    return this.safeAll(`
      SELECT * FROM tool_execution_events WHERE session_id = ?
      ORDER BY recorded_at ASC, id ASC LIMIT ?
    `, sessionId, limit).map((row) => ({
      id: Number(row.id), executionId: String(row.execution_id),
      sessionId: optionalString(row.session_id) ?? null, toolName: String(row.tool_name),
      summary: optionalString(row.summary) ?? null, params: parseJson(row.params_json, null),
      phase: String(row.phase), status: optionalString(row.status) ?? null,
      error: optionalString(row.error) ?? null, recordedAt: Number(row.recorded_at),
    }));
  }

  getSwarmRuns(sessionId: string, limit = 200): SwarmRunListItem[] {
    return this.safeAll(`
      SELECT * FROM swarm_runs WHERE session_id = ? ORDER BY started_at ASC, id ASC LIMIT ?
    `, sessionId, limit).map((row) => {
      const startedAt = Number(row.started_at);
      const endedAt = row.ended_at == null ? null : Number(row.ended_at);
      return {
        id: String(row.id), sessionId: optionalString(row.session_id) ?? null,
        status: String(row.status) as SwarmRunListItem['status'],
        coordinator: String(row.coordinator) as SwarmRunListItem['coordinator'],
        startedAt, endedAt, durationMs: endedAt == null ? null : endedAt - startedAt,
        totalAgents: Number(row.total_agents ?? 0), completedCount: Number(row.completed_count ?? 0),
        failedCount: Number(row.failed_count ?? 0), totalCostUsd: Number(row.total_cost_usd ?? 0),
        totalTokensIn: Number(row.total_tokens_in ?? 0), totalTokensOut: Number(row.total_tokens_out ?? 0),
        trigger: String(row.trigger) as SwarmRunListItem['trigger'],
      };
    });
  }

  getSwarmEvents(runIds: string[], limit = 2_000): SwarmRunEventRecord[] {
    if (runIds.length === 0) return [];
    const placeholders = runIds.map(() => '?').join(',');
    return this.safeAll(`
      SELECT * FROM swarm_run_events WHERE run_id IN (${placeholders})
      ORDER BY timestamp ASC, id ASC LIMIT ?
    `, ...runIds, limit).map((row) => ({
      id: Number(row.id), runId: String(row.run_id), seq: Number(row.seq),
      timestamp: Number(row.timestamp), eventType: String(row.event_type),
      agentId: optionalString(row.agent_id) ?? null,
      level: String(row.level) as SwarmRunEventRecord['level'],
      title: String(row.title ?? ''), summary: String(row.summary ?? ''),
      payload: parseJson(row.payload_json, null),
    }));
  }

  getCost(sessionId: string): SessionLedgerCost {
    const row = this.safeGet(`
      SELECT estimated_cost, total_input_tokens, total_output_tokens
      FROM telemetry_sessions WHERE id = ?
    `, sessionId);
    return {
      estimatedCost: Number(row?.estimated_cost ?? 0),
      tokensIn: Number(row?.total_input_tokens ?? 0),
      tokensOut: Number(row?.total_output_tokens ?? 0),
    };
  }

  getTelemetryTurns(sessionId: string): TelemetryTurnBoundary[] {
    return this.safeAll(`
      SELECT id, turn_number, start_time, end_time, duration_ms, outcome_status,
             agent_id, turn_type FROM telemetry_turns
      WHERE session_id = ? ORDER BY start_time ASC, id ASC
    `, sessionId).map((row) => ({
      turnId: String(row.id), turnNumber: Number(row.turn_number),
      startTime: Number(row.start_time), endTime: Number(row.end_time),
      durationMs: Number(row.duration_ms), outcomeStatus: String(row.outcome_status ?? 'unknown'),
      agentId: optionalString(row.agent_id) ?? null, turnType: String(row.turn_type ?? 'user'),
    }));
  }

  getTelemetryTools(sessionId: string, turnId?: string): TelemetryToolRow[] {
    const filter = turnId ? 'session_id = ? AND turn_id = ?' : 'session_id = ?';
    const params = turnId ? [sessionId, turnId] : [sessionId];
    return this.safeAll(`
      SELECT tool_call_id, turn_id, name, success, error, duration_ms, timestamp
      FROM telemetry_tool_calls WHERE ${filter}
      ORDER BY timestamp DESC, idx DESC LIMIT 20
    `, ...params).map((row) => ({
      toolCallId: String(row.tool_call_id), turnId: String(row.turn_id), name: String(row.name),
      success: Number(row.success) !== 0, error: optionalString(row.error) ?? null,
      durationMs: Number(row.duration_ms ?? 0), timestamp: Number(row.timestamp),
    }));
  }

  getVersions(sessionId: string): Record<string, string | null> {
    const row = this.safeGet(`
      SELECT agent_version, prompt_version, tool_schema_version
      FROM telemetry_sessions WHERE id = ?
    `, sessionId);
    return {
      appVersion: optionalString(row?.agent_version) ?? null,
      promptVersion: optionalString(row?.prompt_version) ?? null,
      toolSchemaVersion: optionalString(row?.tool_schema_version) ?? null,
    };
  }
}
