// ============================================================================
// Telemetry Storage - SQLite 持久化层
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import type {
  TelemetrySession,
  TelemetryTurn,
  TelemetryModelCall,
  TelemetryToolCall,
  TelemetryTimelineEvent,
  TelemetrySessionListItem,
  TelemetryToolStat,
  TelemetryIntentStat,
} from '../../shared/types/telemetry';
import type Database from 'better-sqlite3';

const logger = createLogger('TelemetryStorage');

export class TelemetryStorage {
  private static instance: TelemetryStorage | null = null;
  private stmtCache = new Map<string, Database.Statement>();

  static getInstance(): TelemetryStorage {
    if (!this.instance) {
      this.instance = new TelemetryStorage();
    }
    return this.instance;
  }

  private getDb(): Database.Database {
    const db = getDatabase().getDb();
    if (!db) throw new Error('Database not initialized');
    return db;
  }

  private getStmt(key: string, sql: string): Database.Statement {
    let stmt = this.stmtCache.get(key);
    if (!stmt) {
      stmt = this.getDb().prepare(sql);
      this.stmtCache.set(key, stmt);
    }
    return stmt;
  }

  // --------------------------------------------------------------------------
  // Session CRUD
  // --------------------------------------------------------------------------

  insertSession(session: TelemetrySession): void {
    try {
      const stmt = this.getStmt('insert_session', `
        INSERT OR REPLACE INTO telemetry_sessions (
          id, title, generation_id, model_provider, model_name,
          working_directory, start_time, end_time, duration_ms,
          turn_count, total_input_tokens, total_output_tokens, total_tokens,
          estimated_cost, total_tool_calls, tool_success_rate,
          total_errors, session_type, status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        session.id, session.title, session.generationId,
        session.modelProvider, session.modelName, session.workingDirectory,
        session.startTime, session.endTime ?? null, session.durationMs ?? null,
        session.turnCount, session.totalInputTokens, session.totalOutputTokens,
        session.totalTokens, session.estimatedCost, session.totalToolCalls,
        session.toolSuccessRate, session.totalErrors,
        session.sessionType ?? null, session.status
      );
    } catch (error) {
      logger.error('Failed to insert telemetry session:', error);
    }
  }

  updateSession(sessionId: string, updates: Partial<TelemetrySession>): void {
    try {
      const fields: string[] = [];
      const values: unknown[] = [];

      const fieldMap: Record<string, string> = {
        title: 'title', endTime: 'end_time', durationMs: 'duration_ms',
        turnCount: 'turn_count', totalInputTokens: 'total_input_tokens',
        totalOutputTokens: 'total_output_tokens', totalTokens: 'total_tokens',
        estimatedCost: 'estimated_cost', totalToolCalls: 'total_tool_calls',
        toolSuccessRate: 'tool_success_rate', totalErrors: 'total_errors',
        sessionType: 'session_type', status: 'status',
      };

      for (const [key, col] of Object.entries(fieldMap)) {
        if (key in updates) {
          fields.push(`${col} = ?`);
          values.push((updates as Record<string, unknown>)[key]);
        }
      }

      if (fields.length === 0) return;
      values.push(sessionId);

      const sql = `UPDATE telemetry_sessions SET ${fields.join(', ')} WHERE id = ?`;
      this.getDb().prepare(sql).run(...values);
    } catch (error) {
      logger.error('Failed to update telemetry session:', error);
    }
  }

  getSession(sessionId: string): TelemetrySession | null {
    try {
      const row = this.getStmt('get_session', `
        SELECT * FROM telemetry_sessions WHERE id = ?
      `).get(sessionId) as Record<string, unknown> | undefined;

      if (!row) return null;
      return this.rowToSession(row);
    } catch (error) {
      logger.error('Failed to get telemetry session:', error);
      return null;
    }
  }

  listSessions(limit = 50, offset = 0): TelemetrySessionListItem[] {
    try {
      const rows = this.getStmt('list_sessions', `
        SELECT id, title, model_provider, model_name, start_time, end_time,
               turn_count, total_tokens, estimated_cost, status
        FROM telemetry_sessions
        ORDER BY start_time DESC
        LIMIT ? OFFSET ?
      `).all(limit, offset) as Record<string, unknown>[];

      return rows.map(row => ({
        id: row.id as string,
        title: row.title as string,
        modelProvider: row.model_provider as string,
        modelName: row.model_name as string,
        startTime: row.start_time as number,
        endTime: row.end_time as number | undefined,
        turnCount: row.turn_count as number,
        totalTokens: row.total_tokens as number,
        estimatedCost: row.estimated_cost as number,
        status: row.status as string,
      }));
    } catch (error) {
      logger.error('Failed to list telemetry sessions:', error);
      return [];
    }
  }

  deleteSession(sessionId: string): void {
    try {
      const db = this.getDb();
      db.transaction(() => {
        db.prepare('DELETE FROM telemetry_events WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_tool_calls WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_model_calls WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_turns WHERE session_id = ?').run(sessionId);
        db.prepare('DELETE FROM telemetry_sessions WHERE id = ?').run(sessionId);
      })();
    } catch (error) {
      logger.error('Failed to delete telemetry session:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Turn CRUD
  // --------------------------------------------------------------------------

  insertTurn(turn: TelemetryTurn): void {
    try {
      const stmt = this.getStmt('insert_turn', `
        INSERT OR REPLACE INTO telemetry_turns (
          id, session_id, turn_number, start_time, end_time, duration_ms,
          user_prompt, user_prompt_tokens, has_attachments, attachment_count,
          system_prompt_hash, agent_mode, active_skills, active_mcp_servers, effort_level,
          assistant_response, assistant_response_tokens, thinking_content,
          total_input_tokens, total_output_tokens,
          intent_primary, intent_secondary, intent_confidence, intent_method, intent_keywords,
          outcome_status, outcome_confidence, outcome_method, quality_signals,
          compaction_occurred, compaction_saved_tokens, iteration_count, agent_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      stmt.run(
        turn.id, turn.sessionId, turn.turnNumber,
        turn.startTime, turn.endTime, turn.durationMs,
        turn.userPrompt.substring(0, 10000), // truncate for storage
        turn.userPromptTokens, turn.hasAttachments ? 1 : 0, turn.attachmentCount,
        turn.systemPromptHash ?? null, turn.agentMode,
        JSON.stringify(turn.activeSkills ?? []),
        JSON.stringify(turn.activeMcpServers ?? []),
        turn.effortLevel,
        turn.assistantResponse.substring(0, 10000), // truncate for storage
        turn.assistantResponseTokens, turn.thinkingContent?.substring(0, 5000) ?? null,
        turn.totalInputTokens, turn.totalOutputTokens,
        turn.intent.primary, turn.intent.secondary ?? null,
        turn.intent.confidence, turn.intent.method,
        JSON.stringify(turn.intent.keywords),
        turn.outcome.status, turn.outcome.confidence, turn.outcome.method,
        JSON.stringify(turn.outcome.signals),
        turn.compactionOccurred ? 1 : 0, turn.compactionSavedTokens ?? null,
        turn.iterationCount, turn.agentId || 'main'
      );
    } catch (error) {
      logger.error('Failed to insert telemetry turn:', error);
    }
  }

  getTurnsBySession(sessionId: string, agentId?: string): TelemetryTurn[] {
    try {
      if (agentId) {
        const rows = this.getDb().prepare(
          'SELECT * FROM telemetry_turns WHERE session_id = ? AND agent_id = ? ORDER BY start_time ASC'
        ).all(sessionId, agentId) as Record<string, unknown>[];
        return rows.map(row => this.rowToTurn(row));
      }
      const rows = this.getStmt('get_turns', `
        SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY start_time ASC
      `).all(sessionId) as Record<string, unknown>[];

      return rows.map(row => this.rowToTurn(row));
    } catch (error) {
      logger.error('Failed to get telemetry turns:', error);
      return [];
    }
  }

  getTurnDetail(turnId: string): {
    turn: TelemetryTurn;
    modelCalls: TelemetryModelCall[];
    toolCalls: TelemetryToolCall[];
    events: TelemetryTimelineEvent[];
  } | null {
    try {
      const turnRow = this.getStmt('get_turn', `
        SELECT * FROM telemetry_turns WHERE id = ?
      `).get(turnId) as Record<string, unknown> | undefined;

      if (!turnRow) return null;

      const modelCalls = (this.getStmt('get_model_calls', `
        SELECT * FROM telemetry_model_calls WHERE turn_id = ? ORDER BY timestamp ASC
      `).all(turnId) as Record<string, unknown>[]).map(r => this.rowToModelCall(r));

      const toolCalls = (this.getStmt('get_tool_calls', `
        SELECT * FROM telemetry_tool_calls WHERE turn_id = ? ORDER BY idx ASC
      `).all(turnId) as Record<string, unknown>[]).map(r => this.rowToToolCall(r));

      const events = (this.getStmt('get_events', `
        SELECT * FROM telemetry_events WHERE turn_id = ? ORDER BY timestamp ASC
      `).all(turnId) as Record<string, unknown>[]).map(r => this.rowToEvent(r));

      const turn = this.rowToTurn(turnRow);
      turn.modelCalls = modelCalls;
      turn.toolCalls = toolCalls;
      turn.events = events;

      return { turn, modelCalls, toolCalls, events };
    } catch (error) {
      logger.error('Failed to get turn detail:', error);
      return null;
    }
  }

  // --------------------------------------------------------------------------
  // Batch Insert (for collector flush)
  // --------------------------------------------------------------------------

  batchInsert(data: {
    modelCalls?: Array<TelemetryModelCall & { turnId: string; sessionId: string }>;
    toolCalls?: Array<TelemetryToolCall & { turnId: string; sessionId: string }>;
    events?: Array<TelemetryTimelineEvent & { turnId: string; sessionId: string }>;
  }): void {
    try {
      const db = this.getDb();
      db.transaction(() => {
        if (data.modelCalls?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_model_calls (
              id, turn_id, session_id, timestamp, provider, model,
              temperature, max_tokens, input_tokens, output_tokens,
              latency_ms, response_type, tool_call_count, truncated,
              error, fallback_info
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const mc of data.modelCalls) {
            stmt.run(
              mc.id, mc.turnId, mc.sessionId, mc.timestamp,
              mc.provider, mc.model, mc.temperature ?? null, mc.maxTokens ?? null,
              mc.inputTokens, mc.outputTokens, mc.latencyMs,
              mc.responseType, mc.toolCallCount, mc.truncated ? 1 : 0,
              mc.error ?? null, mc.fallbackUsed ? JSON.stringify(mc.fallbackUsed) : null
            );
          }
        }

        if (data.toolCalls?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_tool_calls (
              id, turn_id, session_id, tool_call_id, name, arguments,
              result_summary, success, error, duration_ms,
              timestamp, idx, parallel
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const tc of data.toolCalls) {
            stmt.run(
              tc.id, tc.turnId, tc.sessionId, tc.toolCallId,
              tc.name, tc.arguments.substring(0, 2048),
              tc.resultSummary.substring(0, 500),
              tc.success ? 1 : 0, tc.error ?? null, tc.durationMs,
              tc.timestamp, tc.index, tc.parallel ? 1 : 0
            );
          }
        }

        if (data.events?.length) {
          const stmt = db.prepare(`
            INSERT OR IGNORE INTO telemetry_events (
              id, turn_id, session_id, timestamp, event_type,
              summary, data, duration_ms
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          `);
          for (const ev of data.events) {
            stmt.run(
              ev.id, ev.turnId, ev.sessionId, ev.timestamp,
              ev.eventType, ev.summary.substring(0, 200),
              ev.data ?? null, ev.durationMs ?? null
            );
          }
        }
      })();
    } catch (error) {
      logger.error('Failed to batch insert telemetry data:', error);
    }
  }

  // --------------------------------------------------------------------------
  // Query Methods
  // --------------------------------------------------------------------------

  getToolUsageStats(sessionId: string): TelemetryToolStat[] {
    try {
      const rows = this.getStmt('tool_stats', `
        SELECT
          name,
          COUNT(*) as call_count,
          SUM(CASE WHEN success = 1 THEN 1 ELSE 0 END) as success_count,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) as fail_count,
          AVG(duration_ms) as avg_duration_ms,
          SUM(duration_ms) as total_duration_ms
        FROM telemetry_tool_calls
        WHERE session_id = ?
        GROUP BY name
        ORDER BY call_count DESC
      `).all(sessionId) as Record<string, unknown>[];

      return rows.map(row => ({
        name: row.name as string,
        callCount: row.call_count as number,
        successCount: row.success_count as number,
        failCount: row.fail_count as number,
        successRate: (row.call_count as number) > 0
          ? (row.success_count as number) / (row.call_count as number)
          : 0,
        avgDurationMs: Math.round(row.avg_duration_ms as number),
        totalDurationMs: row.total_duration_ms as number,
      }));
    } catch (error) {
      logger.error('Failed to get tool usage stats:', error);
      return [];
    }
  }

  getIntentDistribution(sessionId: string): TelemetryIntentStat[] {
    try {
      const rows = this.getStmt('intent_dist', `
        SELECT intent_primary, COUNT(*) as count
        FROM telemetry_turns
        WHERE session_id = ?
        GROUP BY intent_primary
        ORDER BY count DESC
      `).all(sessionId) as Record<string, unknown>[];

      const total = rows.reduce((sum, r) => sum + (r.count as number), 0);

      return rows.map(row => ({
        intent: row.intent_primary as TelemetryIntentStat['intent'],
        count: row.count as number,
        percentage: total > 0 ? (row.count as number) / total : 0,
      }));
    } catch (error) {
      logger.error('Failed to get intent distribution:', error);
      return [];
    }
  }

  /**
   * 获取会话的所有事件（用于时间线视图）
   */
  getEventsBySession(sessionId: string): TelemetryTimelineEvent[] {
    try {
      const rows = this.getStmt('get_events_by_session', `
        SELECT * FROM telemetry_events
        WHERE session_id = ?
        ORDER BY timestamp ASC
      `).all(sessionId) as Record<string, unknown>[];

      return rows.map(row => this.rowToEvent(row));
    } catch (error) {
      logger.error('Failed to get events by session:', error);
      return [];
    }
  }

  // --------------------------------------------------------------------------
  // Row Mappers
  // --------------------------------------------------------------------------

  private rowToSession(row: Record<string, unknown>): TelemetrySession {
    return {
      id: row.id as string,
      title: row.title as string,
      generationId: row.generation_id as string,
      modelProvider: row.model_provider as string,
      modelName: row.model_name as string,
      workingDirectory: row.working_directory as string,
      startTime: row.start_time as number,
      endTime: row.end_time as number | undefined,
      durationMs: row.duration_ms as number | undefined,
      turnCount: row.turn_count as number,
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      totalTokens: row.total_tokens as number,
      estimatedCost: row.estimated_cost as number,
      totalToolCalls: row.total_tool_calls as number,
      toolSuccessRate: row.tool_success_rate as number,
      totalErrors: row.total_errors as number,
      sessionType: (row.session_type as TelemetrySession['sessionType']) ?? undefined,
      status: row.status as TelemetrySession['status'],
    };
  }

  private rowToTurn(row: Record<string, unknown>): TelemetryTurn {
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      agentId: (row.agent_id as string) || 'main',
      turnNumber: row.turn_number as number,
      startTime: row.start_time as number,
      endTime: row.end_time as number,
      durationMs: row.duration_ms as number,
      userPrompt: row.user_prompt as string,
      userPromptTokens: row.user_prompt_tokens as number,
      hasAttachments: !!(row.has_attachments as number),
      attachmentCount: row.attachment_count as number,
      systemPromptHash: row.system_prompt_hash as string | undefined,
      agentMode: row.agent_mode as string,
      activeSkills: JSON.parse((row.active_skills as string) || '[]'),
      activeMcpServers: JSON.parse((row.active_mcp_servers as string) || '[]'),
      effortLevel: row.effort_level as string,
      modelCalls: [],
      toolCalls: [],
      assistantResponse: row.assistant_response as string,
      assistantResponseTokens: row.assistant_response_tokens as number,
      thinkingContent: row.thinking_content as string | undefined,
      totalInputTokens: row.total_input_tokens as number,
      totalOutputTokens: row.total_output_tokens as number,
      events: [],
      intent: {
        primary: row.intent_primary as TelemetryTurn['intent']['primary'],
        secondary: row.intent_secondary as TelemetryTurn['intent']['secondary'],
        confidence: row.intent_confidence as number,
        method: row.intent_method as 'rule' | 'llm',
        keywords: JSON.parse((row.intent_keywords as string) || '[]'),
      },
      outcome: {
        status: row.outcome_status as TelemetryTurn['outcome']['status'],
        confidence: row.outcome_confidence as number,
        method: row.outcome_method as 'rule' | 'llm',
        signals: JSON.parse((row.quality_signals as string) || '{}'),
      },
      compactionOccurred: !!(row.compaction_occurred as number),
      compactionSavedTokens: row.compaction_saved_tokens as number | undefined,
      iterationCount: row.iteration_count as number,
    };
  }

  private rowToModelCall(row: Record<string, unknown>): TelemetryModelCall {
    return {
      id: row.id as string,
      timestamp: row.timestamp as number,
      provider: row.provider as string,
      model: row.model as string,
      temperature: row.temperature as number | undefined,
      maxTokens: row.max_tokens as number | undefined,
      inputTokens: row.input_tokens as number,
      outputTokens: row.output_tokens as number,
      latencyMs: row.latency_ms as number,
      responseType: row.response_type as TelemetryModelCall['responseType'],
      toolCallCount: row.tool_call_count as number,
      truncated: !!(row.truncated as number),
      error: row.error as string | undefined,
      fallbackUsed: row.fallback_info ? JSON.parse(row.fallback_info as string) : undefined,
    };
  }

  private rowToToolCall(row: Record<string, unknown>): TelemetryToolCall {
    return {
      id: row.id as string,
      toolCallId: row.tool_call_id as string,
      name: row.name as string,
      arguments: row.arguments as string,
      resultSummary: row.result_summary as string,
      success: !!(row.success as number),
      error: row.error as string | undefined,
      durationMs: row.duration_ms as number,
      timestamp: row.timestamp as number,
      index: row.idx as number,
      parallel: !!(row.parallel as number),
    };
  }

  private rowToEvent(row: Record<string, unknown>): TelemetryTimelineEvent {
    return {
      id: row.id as string,
      timestamp: row.timestamp as number,
      eventType: row.event_type as string,
      summary: row.summary as string,
      data: row.data as string | undefined,
      durationMs: row.duration_ms as number | undefined,
    };
  }
}

// Singleton accessor
export function getTelemetryStorage(): TelemetryStorage {
  return TelemetryStorage.getInstance();
}
