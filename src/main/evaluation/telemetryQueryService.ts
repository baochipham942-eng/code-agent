import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { buildSessionTraceIdentity } from '../../shared/contract/reviewQueue';
import { classifyError } from '../telemetry/telemetryCollector';
import { getToolDefinitionWithCloudMeta } from '../tools/dispatch/toolDefinitions';
import type { ObjectiveMetrics } from '../../shared/contract/sessionAnalytics';
import { getReplayCompletenessReasons } from '../../shared/contract/evaluation';
import {
  buildTranscriptReplay,
  createEmptyToolDistribution,
  normalizeToolCategory,
} from './transcriptReplayBuilder';
import type {
  ReplayBlock,
  ReplayMetricAvailability,
  ReplayPermissionTrace,
  ReplayToolSchema,
  ReplayTurn,
  StructuredReplay,
  TelemetryCompleteness,
} from '../../shared/contract/evaluation';
import type { SessionSnapshot, TurnSnapshot, QualitySignals as EvaluationQualitySignals } from './types';

const logger = createLogger('TelemetryQueryService');

type SQLiteRow = Record<string, unknown>;
type ToolSchemaSnapshot = {
  timestamp: number;
  schemas: ReplayToolSchema[];
};

class TelemetryQueryService {
  private getDb() {
    const db = getDatabase();
    if (!db.isReady) {
      throw new Error('Database not initialized');
    }
    return db.getDb()!;
  }

  private hasTelemetryData(sessionId: string): boolean {
    const db = this.getDb();
    if (!this.tableExists('telemetry_turns')) return false;

    const turnCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM telemetry_turns WHERE session_id = ?`)
      .get(sessionId) as { cnt: number } | undefined;

    return !!turnCount && turnCount.cnt > 0;
  }

  private tableExists(name: string): boolean {
    const db = this.getDb();
    const row = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name = ?`)
      .get(name);
    return !!row;
  }

  private getRewoundTelemetryRanges(sessionId: string): Array<{ start: number; end: number }> {
    if (!this.tableExists('session_rewinds')) return [];
    const db = this.getDb();
    const rows = db
      .prepare(`
        SELECT anchor_timestamp, created_at
        FROM session_rewinds
        WHERE session_id = ?
        ORDER BY created_at ASC
      `)
      .all(sessionId) as Array<{ anchor_timestamp: number; created_at: number }>;

    return rows
      .map((row) => ({
        start: Number(row.anchor_timestamp || 0),
        end: Number(row.created_at || 0),
      }))
      .filter((range) => range.start > 0 && range.end >= range.start);
  }

  private isTimestampInRanges(timestamp: unknown, ranges: Array<{ start: number; end: number }>): boolean {
    const value = Number(timestamp || 0);
    if (!value) return false;
    return ranges.some((range) => value >= range.start && value <= range.end);
  }

  private loadTelemetryRows(sessionId: string): {
    sessionRow?: SQLiteRow;
    turnRows: SQLiteRow[];
    modelCallRows: SQLiteRow[];
    toolCallRows: SQLiteRow[];
    eventRows: SQLiteRow[];
  } | null {
    if (!this.hasTelemetryData(sessionId)) {
      return null;
    }

    const db = this.getDb();
    const sessionRow = db
      .prepare(`SELECT * FROM telemetry_sessions WHERE id = ?`)
      .get(sessionId) as SQLiteRow | undefined;
    let turnRows = db
      .prepare(`SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY start_time ASC, turn_number ASC`)
      .all(sessionId) as SQLiteRow[];
    let modelCallRows = this.tableExists('telemetry_model_calls')
      ? db
        .prepare(`SELECT * FROM telemetry_model_calls WHERE session_id = ? ORDER BY timestamp ASC`)
        .all(sessionId) as SQLiteRow[]
      : [];
    let toolCallRows = db
      .prepare(`SELECT * FROM telemetry_tool_calls WHERE session_id = ? ORDER BY timestamp ASC, idx ASC`)
      .all(sessionId) as SQLiteRow[];
    let eventRows = this.tableExists('telemetry_events')
      ? db
        .prepare(`SELECT * FROM telemetry_events WHERE session_id = ? ORDER BY timestamp ASC`)
        .all(sessionId) as SQLiteRow[]
      : [];

    const rewoundRanges = this.getRewoundTelemetryRanges(sessionId);
    if (rewoundRanges.length > 0) {
      const hiddenTurnIds = new Set(
        turnRows
          .filter((row) => this.isTimestampInRanges(row.start_time, rewoundRanges))
          .map((row) => String(row.id)),
      );
      turnRows = turnRows.filter((row) => !hiddenTurnIds.has(String(row.id)));
      modelCallRows = modelCallRows.filter((row) => !hiddenTurnIds.has(String(row.turn_id)));
      toolCallRows = toolCallRows.filter((row) => !hiddenTurnIds.has(String(row.turn_id)));
      eventRows = eventRows.filter((row) => {
        const turnId = row.turn_id ? String(row.turn_id) : null;
        if (turnId && hiddenTurnIds.has(turnId)) return false;
        return !this.isTimestampInRanges(row.timestamp, rewoundRanges);
      });
    }

    return { sessionRow, turnRows, modelCallRows, toolCallRows, eventRows };
  }

  private parseToolArgs(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string' || value.length === 0) return {};
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
  }

  private parseOptionalToolArgs(value: unknown): Record<string, unknown> | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : { value: parsed };
    } catch {
      return { raw: value };
    }
  }

  private parseEventData(value: unknown): Record<string, unknown> | string | undefined {
    if (typeof value !== 'string' || value.length === 0) return undefined;
    try {
      const parsed = JSON.parse(value) as unknown;
      return parsed && typeof parsed === 'object'
        ? parsed as Record<string, unknown>
        : String(parsed);
    } catch {
      return value;
    }
  }

  private getToolSchema(name: string): ReplayToolSchema | undefined {
    try {
      const definition = getToolDefinitionWithCloudMeta(name);
      if (!definition) return undefined;
      return {
        name: definition.name,
        inputSchema: definition.inputSchema as unknown as Record<string, unknown> | undefined,
        requiresPermission: definition.requiresPermission,
        permissionLevel: definition.permissionLevel,
      };
    } catch {
      return undefined;
    }
  }

  private isPermissionEvent(row: SQLiteRow): boolean {
    if (row.event_type === 'tool_schema_snapshot') return false;
    const haystack = [
      row.event_type,
      row.summary,
      row.data,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes('permission')
      || haystack.includes('approval')
      || haystack.includes('blocked')
      || haystack.includes('denied');
  }

  private buildPermissionTrace(eventRows: SQLiteRow[]): ReplayPermissionTrace[] | undefined {
    const traces = eventRows
      .filter(row => this.isPermissionEvent(row))
      .map((row) => ({
        eventType: row.event_type as string,
        summary: (row.summary as string) || '',
        data: this.parseEventData(row.data),
        timestamp: row.timestamp as number,
      }));
    return traces.length > 0 ? traces : undefined;
  }

  private parseToolSchemasFromEvent(row: SQLiteRow): ReplayToolSchema[] {
    const data = this.parseEventData(row.data);
    if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
    const tools = (data as { tools?: unknown }).tools;
    if (!Array.isArray(tools)) return [];
    return tools
      .filter((tool): tool is Record<string, unknown> => !!tool && typeof tool === 'object' && !Array.isArray(tool))
      .map((tool) => ({
        name: String(tool.name || 'unknown'),
        inputSchema: tool.inputSchema && typeof tool.inputSchema === 'object'
          ? tool.inputSchema as Record<string, unknown>
          : undefined,
        requiresPermission: typeof tool.requiresPermission === 'boolean' ? tool.requiresPermission : undefined,
        permissionLevel: typeof tool.permissionLevel === 'string' ? tool.permissionLevel : undefined,
      }));
  }

  private extractToolSchemaSnapshots(eventRows: SQLiteRow[]): ToolSchemaSnapshot[] {
    const snapshots: ToolSchemaSnapshot[] = [];
    for (const row of eventRows) {
      if (row.event_type !== 'tool_schema_snapshot') continue;
      const schemas = this.parseToolSchemasFromEvent(row);
      if (schemas.length > 0) {
        snapshots.push({
          timestamp: Number(row.timestamp) || 0,
          schemas,
        });
      }
    }
    return snapshots.sort((left, right) => left.timestamp - right.timestamp);
  }

  private getToolSchemasAt(
    snapshots: ToolSchemaSnapshot[],
    timestamp: number,
  ): ReplayToolSchema[] | undefined {
    if (snapshots.length === 0) return undefined;
    let selected: ToolSchemaSnapshot | undefined;
    for (const snapshot of snapshots) {
      if (snapshot.timestamp <= timestamp) {
        selected = snapshot;
        continue;
      }
      break;
    }
    return selected?.schemas ?? snapshots[0]?.schemas;
  }

  private getToolSchemaMapAt(
    snapshots: ToolSchemaSnapshot[],
    timestamp: number,
    fallbackToolNames: string[],
  ): Map<string, ReplayToolSchema> {
    const schemaMap = new Map<string, ReplayToolSchema>();
    for (const schema of this.getToolSchemasAt(snapshots, timestamp) || []) {
      schemaMap.set(schema.name, schema);
    }
    for (const name of fallbackToolNames) {
      const schema = this.getToolSchema(name);
      if (schema && !schemaMap.has(name)) {
        schemaMap.set(name, schema);
      }
    }
    return schemaMap;
  }

  private getToolTraceValue(data: Record<string, unknown>, keys: string[]): string | undefined {
    for (const key of keys) {
      const value = data[key];
      if (typeof value === 'string' && value.length > 0) {
        return value;
      }
    }
    return undefined;
  }

  private eventMatchesTool(
    row: SQLiteRow,
    data: Record<string, unknown> | string | undefined,
    toolName: string,
    toolCallId: string,
  ): boolean {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return true;
    }

    const dataObj = data as Record<string, unknown>;
    const eventToolCallId = this.getToolTraceValue(dataObj, ['toolCallId', 'tool_call_id', 'callId', 'id']);
    if (eventToolCallId) {
      return eventToolCallId === toolCallId;
    }

    const eventToolName = this.getToolTraceValue(dataObj, ['toolName', 'tool_name', 'tool', 'name']);
    if (eventToolName) {
      return eventToolName === toolName;
    }

    return true;
  }

  private buildPermissionTraceForTool(
    eventRows: SQLiteRow[],
    toolName: string,
    toolCallId: string,
  ): ReplayPermissionTrace[] | undefined {
    const traces = eventRows
      .filter(row => this.isPermissionEvent(row))
      .map((row) => {
        const data = this.parseEventData(row.data);
        return {
          row,
          data,
          trace: {
            eventType: row.event_type as string,
            summary: (row.summary as string) || '',
            data,
            timestamp: row.timestamp as number,
          } satisfies ReplayPermissionTrace,
        };
      })
      .filter(({ row, data }) => this.eventMatchesTool(row, data, toolName, toolCallId))
      .map(({ trace }) => trace);
    return traces.length > 0 ? traces : undefined;
  }

  private buildTelemetryCompleteness(
    sessionId: string,
    turnRows: SQLiteRow[],
    modelCallRows: SQLiteRow[],
    toolCallRows: SQLiteRow[],
    eventRows: SQLiteRow[],
    hasToolSchemas: boolean,
  ): TelemetryCompleteness {
    const traceIdentity = buildSessionTraceIdentity(sessionId);
    const base = {
      sessionId,
      replayKey: traceIdentity.replayKey,
      turnCount: turnRows.length,
      modelCallCount: modelCallRows.length,
      toolCallCount: toolCallRows.length,
      eventCount: eventRows.length,
      hasSessionId: true,
      hasModelDecisions: modelCallRows.length > 0,
      hasToolSchemas,
      hasPermissionTrace: eventRows.some(row => this.isPermissionEvent(row)),
      hasContextCompressionEvents: eventRows.some(row => row.event_type === 'context_compressed')
        || turnRows.some(row => Boolean(row.compaction_occurred)),
      hasSubagentTelemetry: turnRows.some(row => {
        const agentId = (row.agent_id as string | undefined) || 'main';
        return agentId !== 'main';
      }),
      dataSource: 'telemetry',
      source: 'telemetry',
    } satisfies Omit<TelemetryCompleteness, 'hasRealAgentTrace' | 'incompleteReasons'>;
    const incompleteReasons = getReplayCompletenessReasons(base);
    return {
      ...base,
      hasRealAgentTrace: incompleteReasons.length === 0,
      incompleteReasons,
    };
  }

  private buildTranscriptTelemetryCompleteness(
    sessionId: string,
    turns: ReplayTurn[],
    toolCallCount: number,
  ): TelemetryCompleteness {
    const traceIdentity = buildSessionTraceIdentity(sessionId);
    const base = {
      sessionId,
      replayKey: traceIdentity.replayKey,
      turnCount: turns.length,
      modelCallCount: 0,
      toolCallCount,
      eventCount: 0,
      hasSessionId: true,
      hasModelDecisions: false,
      hasToolSchemas: false,
      hasPermissionTrace: false,
      hasContextCompressionEvents: false,
      hasSubagentTelemetry: false,
      dataSource: 'transcript_fallback',
      source: 'transcript_fallback',
    } satisfies Omit<TelemetryCompleteness, 'hasRealAgentTrace' | 'incompleteReasons'>;
    return {
      ...base,
      hasRealAgentTrace: false,
      incompleteReasons: getReplayCompletenessReasons(base),
    };
  }

  private aggregateQualitySignals(turnRows: SQLiteRow[]): EvaluationQualitySignals {
    let totalRetries = 0;
    let errorRecoveries = 0;
    let compactionCount = 0;
    let circuitBreakerTrips = 0;

    for (const row of turnRows) {
      const raw = row.quality_signals as string | null;
      if (!raw) continue;
      try {
        const quality = JSON.parse(raw) as Record<string, unknown>;
        totalRetries += Number(quality.retryCount || 0);
        errorRecoveries += Number(quality.errorRecovered || 0);
        if (quality.compactionTriggered) compactionCount++;
        if (quality.circuitBreakerTripped) circuitBreakerTrips++;
      } catch {
        logger.debug('Failed to parse telemetry quality signals');
      }
    }

    return {
      totalRetries,
      errorRecoveries,
      compactionCount,
      circuitBreakerTrips,
      selfRepairAttempts: 0,
      selfRepairSuccesses: 0,
      verificationActions: 0,
    };
  }

  private buildTurnToolCalls(toolCallRows: SQLiteRow[], turnId: string) {
    return toolCallRows
      .filter(tc => tc.turn_id === turnId)
      .map(tc => this.buildToolCallRecord(tc));
  }

  private buildToolCallRecord(tc: SQLiteRow) {
    const actualArgs = this.parseOptionalToolArgs(tc.actual_arguments);
    const argsSource: 'telemetry_actual' | 'telemetry_sanitized' = actualArgs
      ? 'telemetry_actual'
      : 'telemetry_sanitized';
    return {
      id: tc.id as string,
      name: tc.name as string,
      args: actualArgs ?? this.parseToolArgs(tc.arguments),
      actualArgs,
      argsSource,
      result: (tc.result_summary as string) || undefined,
      success: (tc.success as number) === 1,
      duration: (tc.duration_ms as number) || 0,
      timestamp: tc.timestamp as number,
      turnId: tc.turn_id as string,
      index: (tc.idx as number) || 0,
      parallel: (tc.parallel as number) === 1,
    };
  }

  private getActualArgsAvailability(toolCallRows: SQLiteRow[]): ReplayMetricAvailability['actualArgs'] {
    if (toolCallRows.length === 0) {
      return 'unavailable';
    }
    const availableCount = toolCallRows.filter(row => (
      typeof row.actual_arguments === 'string' && row.actual_arguments.length > 0
    )).length;
    if (availableCount === 0) return 'unavailable';
    if (availableCount === toolCallRows.length) return 'telemetry';
    return 'partial';
  }

  getSessionSnapshot(sessionId: string): SessionSnapshot | null {
    try {
      const data = this.loadTelemetryRows(sessionId);
      if (!data) return null;

      const turns: TurnSnapshot[] = data.turnRows.map(row => ({
        turnNumber: row.turn_number as number,
        userPrompt: (row.user_prompt as string) || '',
        assistantResponse: (row.assistant_response as string) || '',
        toolCalls: this.buildTurnToolCalls(data.toolCallRows, row.id as string),
        intentPrimary: (row.intent_primary as string) || 'unknown',
        outcomeStatus: (row.outcome_status as string) || 'unknown',
        thinkingContent: (row.thinking_content as string) || undefined,
        durationMs: (row.duration_ms as number) || 0,
        inputTokens: (row.total_input_tokens as number) || 0,
        outputTokens: (row.total_output_tokens as number) || 0,
      }));

      const messages = turns.flatMap((turn, index) => {
        const turnRow = data.turnRows[index];
        const result: SessionSnapshot['messages'] = [];
        if (turn.userPrompt) {
          result.push({
            id: `turn-${turn.turnNumber}-user`,
            role: 'user',
            content: turn.userPrompt,
            timestamp: (turnRow?.start_time as number) || 0,
          });
        }
        if (turn.assistantResponse) {
          result.push({
            id: `turn-${turn.turnNumber}-assistant`,
            role: 'assistant',
            content: turn.assistantResponse,
            timestamp: (turnRow?.end_time as number) || (turnRow?.start_time as number) || 0,
          });
        }
        return result;
      });

      const toolCalls = data.toolCallRows.map(tc => this.buildToolCallRecord(tc));

      const inputTokens = (data.sessionRow?.total_input_tokens as number) || turns.reduce((sum, turn) => sum + turn.inputTokens, 0);
      const outputTokens = (data.sessionRow?.total_output_tokens as number) || turns.reduce((sum, turn) => sum + turn.outputTokens, 0);

      return {
        sessionId,
        messages,
        toolCalls,
        turns,
        startTime: (data.sessionRow?.start_time as number) || (data.turnRows[0]?.start_time as number) || Date.now(),
        endTime: (data.sessionRow?.end_time as number) || (data.turnRows[data.turnRows.length - 1]?.end_time as number) || Date.now(),
        inputTokens,
        outputTokens,
        totalCost: (data.sessionRow?.estimated_cost as number) || 0,
        qualitySignals: this.aggregateQualitySignals(data.turnRows),
      };
    } catch (error) {
      logger.warn('Failed to build session snapshot from telemetry', { error, sessionId });
      return null;
    }
  }

  private calculateSelfRepairStats(toolCallRows: SQLiteRow[]): { attempts: number; successes: number } {
    let attempts = 0;
    let successes = 0;
    const byTurn = new Map<string, SQLiteRow[]>();

    for (const row of toolCallRows) {
      const turnId = row.turn_id as string;
      const list = byTurn.get(turnId) || [];
      list.push(row);
      byTurn.set(turnId, list);
    }

    for (const rows of byTurn.values()) {
      for (let index = 0; index < rows.length; index++) {
        const row = rows[index];
        if ((row.success as number) === 1) continue;

        const name = row.name as string;
        for (let nextIndex = index + 1; nextIndex < rows.length; nextIndex++) {
          const next = rows[nextIndex];
          if ((next.name as string) !== name) continue;
          attempts++;
          if ((next.success as number) === 1) {
            successes++;
          }
          break;
        }
      }
    }

    return { attempts, successes };
  }

  getObjectiveMetrics(sessionId: string): ObjectiveMetrics | null {
    try {
      const data = this.loadTelemetryRows(sessionId);
      if (!data) return null;

      const startTime = (data.sessionRow?.start_time as number) || (data.turnRows[0]?.start_time as number) || Date.now();
      const endTime = (data.sessionRow?.end_time as number) || (data.turnRows[data.turnRows.length - 1]?.end_time as number) || Date.now();
      const userMessages = data.turnRows.length;
      const assistantMessages = data.turnRows.filter(t => ((t.assistant_response as string) || '').length > 0).length;
      const totalToolCalls = data.toolCallRows.length;
      const successfulToolCalls = data.toolCallRows.filter(tc => (tc.success as number) === 1).length;
      const toolCallsByName = data.toolCallRows.reduce<Record<string, number>>((acc, tc) => {
        const name = tc.name as string;
        acc[name] = (acc[name] || 0) + 1;
        return acc;
      }, {});
      const intentDistribution = data.turnRows.reduce<Record<string, number>>((acc, turn) => {
        const intent = (turn.intent_primary as string) || 'unknown';
        acc[intent] = (acc[intent] || 0) + 1;
        return acc;
      }, {});
      const errorTaxonomy = data.toolCallRows.reduce<Record<string, number>>((acc, tc) => {
        if ((tc.success as number) === 1) return acc;
        const category = (tc.error_category as string) || classifyError((tc.error as string) || '');
        acc[category] = (acc[category] || 0) + 1;
        return acc;
      }, {});
      const selfRepair = this.calculateSelfRepairStats(data.toolCallRows);

      let codeBlocksGenerated = 0;
      let messagesWithCode = 0;
      for (const row of data.turnRows) {
        const response = (row.assistant_response as string) || '';
        const blocks = (response.match(/```[\s\S]*?```/g) || []).length;
        codeBlocksGenerated += blocks;
        if (blocks > 0) messagesWithCode++;
      }

      const totalInputTokens = (data.sessionRow?.total_input_tokens as number) || data.turnRows.reduce((acc, turn) => acc + ((turn.total_input_tokens as number) || 0), 0);
      const totalOutputTokens = (data.sessionRow?.total_output_tokens as number) || data.turnRows.reduce((acc, turn) => acc + ((turn.total_output_tokens as number) || 0), 0);

      return {
        sessionId,
        startTime,
        endTime,
        duration: endTime - startTime,
        totalMessages: userMessages + assistantMessages,
        userMessages,
        assistantMessages,
        avgUserMessageLength: userMessages > 0
          ? Math.round(data.turnRows.reduce((acc, turn) => acc + (((turn.user_prompt as string) || '').length), 0) / userMessages)
          : 0,
        avgAssistantMessageLength: assistantMessages > 0
          ? Math.round(data.turnRows.reduce((acc, turn) => acc + (((turn.assistant_response as string) || '').length), 0) / assistantMessages)
          : 0,
        totalToolCalls,
        successfulToolCalls,
        failedToolCalls: totalToolCalls - successfulToolCalls,
        toolSuccessRate: totalToolCalls > 0 ? Math.round((successfulToolCalls / totalToolCalls) * 100) : 100,
        toolCallsByName,
        avgToolLatency: totalToolCalls > 0
          ? Math.round(data.toolCallRows.reduce((acc, tc) => acc + (((tc.duration_ms as number) || 0)), 0) / totalToolCalls)
          : 0,
        totalInputTokens,
        totalOutputTokens,
        totalTokens: totalInputTokens + totalOutputTokens,
        estimatedCost: (data.sessionRow?.estimated_cost as number) || 0,
        codeBlocksGenerated,
        messagesWithCode,
        turnsCount: data.turnRows.length,
        avgResponseTime: data.turnRows.length > 0
          ? Math.round(data.turnRows.reduce((acc, turn) => acc + (((turn.duration_ms as number) || 0)), 0) / data.turnRows.length)
          : 0,
        intentDistribution,
        errorTaxonomy,
        selfRepairRate: selfRepair.attempts > 0 ? Math.round((selfRepair.successes / selfRepair.attempts) * 100) : 100,
        tokenPerTurn: data.turnRows.map(turn => (((turn.total_input_tokens as number) || 0) + ((turn.total_output_tokens as number) || 0))),
      };
    } catch (error) {
      logger.warn('Failed to build objective metrics from telemetry', { error, sessionId });
      return null;
    }
  }

  async getStructuredReplay(sessionId: string): Promise<StructuredReplay | null> {
    try {
      const data = this.loadTelemetryRows(sessionId);
      if (!data) {
        return buildTranscriptReplay(
          sessionId,
          (sid, turns, count) => this.buildTranscriptTelemetryCompleteness(sid, turns, count),
        );
      }

      const toolDistribution = createEmptyToolDistribution();
      let totalThinkingTokens = 0;
      let totalAllTokens = 0;
      let totalDurationMs = 0;

      const turns = data.turnRows.map(row => {
        const leadingBlocks: ReplayBlock[] = [];
        const timelineBlocks: ReplayBlock[] = [];
        const trailingBlocks: ReplayBlock[] = [];
        const turnId = row.id as string;
        const turnModelCalls = data.modelCallRows.filter(mc => mc.turn_id === turnId);
        const turnToolCalls = data.toolCallRows.filter(tc => tc.turn_id === turnId);
        const turnEvents = data.eventRows.filter(ev => ev.turn_id === turnId);
        const turnToolNames = turnToolCalls.map(tc => tc.name as string);
        const toolSchemaSnapshots = this.extractToolSchemaSnapshots(turnEvents);

        if (row.user_prompt) {
          leadingBlocks.push({
            type: 'user',
            content: row.user_prompt as string,
            timestamp: row.start_time as number,
          });
        }

        if (row.thinking_content) {
          leadingBlocks.push({
            type: 'thinking',
            content: row.thinking_content as string,
            timestamp: row.start_time as number,
          });
          totalThinkingTokens += Math.ceil(String(row.thinking_content).length / 4);
        }

        for (const mc of turnModelCalls) {
          const schemas = [
            ...this.getToolSchemaMapAt(
              toolSchemaSnapshots,
              (mc.timestamp as number) || (row.start_time as number) || 0,
              turnToolNames,
            ).values(),
          ];
          timelineBlocks.push({
            type: 'model_call',
            content: `${mc.provider as string}/${mc.model as string}: ${mc.response_type as string || 'unknown'}`,
            timestamp: mc.timestamp as number,
            modelDecision: {
              id: mc.id as string,
              provider: mc.provider as string,
              model: mc.model as string,
              responseType: mc.response_type as string | undefined,
              toolCallCount: (mc.tool_call_count as number) || 0,
              inputTokens: (mc.input_tokens as number) || 0,
              outputTokens: (mc.output_tokens as number) || 0,
              latencyMs: (mc.latency_ms as number) || 0,
              prompt: mc.prompt as string | undefined,
              completion: mc.completion as string | undefined,
              toolSchemas: schemas.length > 0 ? schemas : undefined,
            },
          });
        }

        for (const tc of turnToolCalls) {
          const category = normalizeToolCategory(tc.name as string);
          const actualArgs = this.parseOptionalToolArgs(tc.actual_arguments);
          const toolSchema = this.getToolSchemaMapAt(
            toolSchemaSnapshots,
            (tc.timestamp as number) || (row.start_time as number) || 0,
            [tc.name as string],
          ).get(tc.name as string);
          const permissionTrace = this.buildPermissionTraceForTool(
            turnEvents,
            tc.name as string,
            tc.tool_call_id as string,
          );
          toolDistribution[category]++;

          timelineBlocks.push({
            type: 'tool_call',
            content: tc.name as string,
            toolCall: {
              id: tc.tool_call_id as string,
              name: tc.name as string,
              args: actualArgs ?? this.parseToolArgs(tc.arguments),
              actualArgs,
              argsSource: actualArgs ? 'telemetry_actual' : 'telemetry_sanitized',
              toolSchema,
              permissionTrace,
              result: (tc.result_summary as string) || undefined,
              success: (tc.success as number) === 1,
              successKnown: true,
              duration: (tc.duration_ms as number) || 0,
              category,
            },
            timestamp: tc.timestamp as number,
          });

          if (tc.error) {
            timelineBlocks.push({
              type: 'error',
              content: tc.error as string,
              timestamp: tc.timestamp as number,
            });
          }
        }

        for (const ev of turnEvents) {
          const isContextEvent = ev.event_type === 'context_compressed';
          timelineBlocks.push({
            type: isContextEvent ? 'context_event' : 'event',
            content: (ev.summary as string) || (ev.event_type as string),
            timestamp: ev.timestamp as number,
            event: {
              eventType: ev.event_type as string,
              summary: (ev.summary as string) || '',
              data: this.parseEventData(ev.data),
              durationMs: ev.duration_ms as number | undefined,
            },
          });
        }

        if (row.compaction_occurred && !turnEvents.some(ev => ev.event_type === 'context_compressed')) {
          timelineBlocks.push({
            type: 'context_event',
            content: 'Context compaction occurred',
            timestamp: (row.end_time as number) || (row.start_time as number),
            event: {
              eventType: 'context_compressed',
              summary: 'Context compaction occurred',
              data: row.compaction_saved_tokens
                ? { savedTokens: row.compaction_saved_tokens }
                : undefined,
            },
          });
        }

        if (row.assistant_response) {
          trailingBlocks.push({
            type: 'text',
            content: row.assistant_response as string,
            timestamp: (row.end_time as number) || (row.start_time as number),
          });
        }

        const timelineOrder: Record<ReplayBlock['type'], number> = {
          user: 0,
          thinking: 1,
          model_call: 2,
          event: 3,
          context_event: 3,
          tool_call: 4,
          tool_result: 5,
          error: 6,
          text: 7,
        };
        timelineBlocks.sort((left, right) => (
          left.timestamp - right.timestamp
          || timelineOrder[left.type] - timelineOrder[right.type]
        ));
        const blocks = [...leadingBlocks, ...timelineBlocks, ...trailingBlocks];

        totalAllTokens += ((row.total_input_tokens as number) || 0) + ((row.total_output_tokens as number) || 0);
        totalDurationMs += (row.duration_ms as number) || 0;

        return {
          turnNumber: row.turn_number as number,
          agentId: (row.agent_id as string | undefined) || 'main',
          turnType: (row.turn_type as ReplayTurn['turnType']) || 'user',
          parentTurnId: row.parent_turn_id as string | undefined,
          blocks,
          inputTokens: (row.total_input_tokens as number) || 0,
          outputTokens: (row.total_output_tokens as number) || 0,
          durationMs: (row.duration_ms as number) || 0,
          startTime: row.start_time as number,
        };
      });

      let deviations:
        | Array<{
            stepIndex: number;
            type: string;
            description: string;
            severity: string;
            suggestedFix?: string;
          }>
        | undefined;

      // v2.5 Phase 2: rule-based failure attribution.
      // Phase 7 (A): opt-in LLM fallback via CODE_AGENT_EVAL_LLM_ENABLED=1.
      // When the env flag is off (default) this stays deterministic/rules-only.
      let failureAttribution:
        | {
            rootCause?: {
              stepIndex: number;
              category: string;
              summary: string;
              evidence: number[];
              confidence: number;
            };
            causalChain: Array<{ stepIndex: number; role: string; note: string }>;
            relatedRegressionCases: string[];
            llmUsed: boolean;
            durationMs: number;
          }
        | undefined;

      try {
        const { TrajectoryBuilder } = await import('./trajectory/trajectoryBuilder');
        const { DeviationDetector } = await import('./trajectory/deviationDetector');

        const events: Array<{ event_type: string; event_data: Record<string, unknown>; timestamp: string }> = [];
        for (const turn of turns) {
          for (const block of turn.blocks) {
            if (block.type === 'tool_call' && block.toolCall) {
              events.push({
                event_type: 'tool_start',
                event_data: { tool: block.toolCall.name, args: block.toolCall.args },
                timestamp: String(block.timestamp),
              });
              events.push({
                event_type: 'tool_result',
                event_data: {
                  tool: block.toolCall.name,
                  success: block.toolCall.success,
                  result: block.toolCall.result,
                  ...(block.toolCall.success ? {} : { error: 'failed' }),
                },
                timestamp: String(block.timestamp + block.toolCall.duration),
              });
            } else if (block.type === 'error') {
              events.push({
                event_type: 'error',
                event_data: { message: block.content },
                timestamp: String(block.timestamp),
              });
            } else if (block.type === 'thinking') {
              events.push({
                event_type: 'thinking',
                event_data: { content: block.content },
                timestamp: String(block.timestamp),
              });
            }
          }
        }

        if (events.length > 0) {
          const builder = new TrajectoryBuilder();
          const trajectory = builder.buildFromEvents(events);
          const detector = new DeviationDetector();
          const detected = detector.detectByRules(trajectory);
          trajectory.deviations = detected;
          deviations = detected.map((d) => ({
            stepIndex: d.stepIndex,
            type: d.type,
            description: d.description,
            severity: d.severity,
            suggestedFix: d.suggestedFix,
          }));

          // v2.5 Phase 2 + Phase 7: attach failure attribution (rules + opt-in LLM).
          try {
            const { FailureAttributor } = await import('./trajectory/attribution');
            // LLM attribution path removed with llmChatFactory; rules-based attribution only.
            const attribution = await new FailureAttributor().attribute(trajectory, {
              enableLLM: false,
            });
            failureAttribution = {
              rootCause: attribution.rootCause,
              causalChain: attribution.causalChain,
              relatedRegressionCases: attribution.relatedRegressionCases,
              llmUsed: attribution.llmUsed,
              durationMs: attribution.durationMs,
            };
          } catch (error) {
            logger.debug('失败归因(FailureAttributor)计算失败，跳过', { error: String(error) });
          }
        }
      } catch (error) {
        logger.debug('失败归因外层处理异常，跳过', { error: String(error) });
      }

      const selfRepair = this.calculateSelfRepairStats(data.toolCallRows);
      const hasToolSchemas = turns.some(turn => turn.blocks.some(block => (
        block.type === 'tool_call' && Boolean(block.toolCall?.toolSchema)
        || block.type === 'model_call' && Boolean(block.modelDecision?.toolSchemas?.length)
      )));

      return {
        sessionId,
        traceIdentity: buildSessionTraceIdentity(sessionId),
        traceSource: 'session_replay',
        dataSource: 'telemetry',
        turns,
        summary: {
          totalTurns: turns.length,
          toolDistribution,
          thinkingRatio: totalAllTokens > 0 ? totalThinkingTokens / totalAllTokens : 0,
          selfRepairChains: selfRepair.successes,
          totalDurationMs,
          metricAvailability: {
            dataSource: 'telemetry',
            replaySource: 'telemetry',
            toolDistribution: 'telemetry',
            selfRepair: 'telemetry',
            actualArgs: this.getActualArgsAvailability(data.toolCallRows),
          } satisfies ReplayMetricAvailability,
          telemetryCompleteness: this.buildTelemetryCompleteness(
            sessionId,
            data.turnRows,
            data.modelCallRows,
            data.toolCallRows,
            data.eventRows,
            hasToolSchemas,
          ),
          deviations,
          failureAttribution,
        },
      };
    } catch (error) {
      logger.warn('Failed to build structured replay from telemetry', { error, sessionId });
      return null;
    }
  }
}

let telemetryQueryService: TelemetryQueryService | null = null;

export function getTelemetryQueryService(): TelemetryQueryService {
  if (!telemetryQueryService) {
    telemetryQueryService = new TelemetryQueryService();
  }
  return telemetryQueryService;
}
