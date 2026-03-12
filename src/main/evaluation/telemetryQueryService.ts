import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { classifyError } from '../telemetry/telemetryCollector';
import type { ObjectiveMetrics } from '../../shared/types/sessionAnalytics';
import type { SessionSnapshot, TurnSnapshot, QualitySignals as EvaluationQualitySignals } from './types';

const logger = createLogger('TelemetryQueryService');

type SQLiteRow = Record<string, unknown>;

const TOOL_CATEGORY_MAP = {
  read: 'Read',
  read_file: 'Read',
  readFile: 'Read',
  Read: 'Read',
  readXlsx: 'Read',
  read_xlsx: 'Read',
  edit: 'Edit',
  edit_file: 'Edit',
  Edit: 'Edit',
  write: 'Write',
  write_file: 'Write',
  Write: 'Write',
  create_file: 'Write',
  bash: 'Bash',
  Bash: 'Bash',
  execute: 'Bash',
  terminal: 'Bash',
  glob: 'Search',
  Glob: 'Search',
  grep: 'Search',
  Grep: 'Search',
  search: 'Search',
  find: 'Search',
  listDirectory: 'Search',
  list_directory: 'Search',
  webFetch: 'Web',
  web_fetch: 'Web',
  webSearch: 'Web',
  web_search: 'Web',
  agent: 'Agent',
  Agent: 'Agent',
  subagent: 'Agent',
  skill: 'Skill',
  Skill: 'Skill',
} as const;

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
    const tableExists = db
      .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='telemetry_turns'`)
      .get();
    if (!tableExists) return false;

    const turnCount = db
      .prepare(`SELECT COUNT(*) as cnt FROM telemetry_turns WHERE session_id = ?`)
      .get(sessionId) as { cnt: number } | undefined;

    return !!turnCount && turnCount.cnt > 0;
  }

  private loadTelemetryRows(sessionId: string): {
    sessionRow?: SQLiteRow;
    turnRows: SQLiteRow[];
    toolCallRows: SQLiteRow[];
  } | null {
    if (!this.hasTelemetryData(sessionId)) {
      return null;
    }

    const db = this.getDb();
    const sessionRow = db
      .prepare(`SELECT * FROM telemetry_sessions WHERE id = ?`)
      .get(sessionId) as SQLiteRow | undefined;
    const turnRows = db
      .prepare(`SELECT * FROM telemetry_turns WHERE session_id = ? ORDER BY turn_number ASC`)
      .all(sessionId) as SQLiteRow[];
    const toolCallRows = db
      .prepare(`SELECT * FROM telemetry_tool_calls WHERE session_id = ? ORDER BY timestamp ASC, idx ASC`)
      .all(sessionId) as SQLiteRow[];

    return { sessionRow, turnRows, toolCallRows };
  }

  private parseToolArgs(value: unknown): Record<string, unknown> {
    if (typeof value !== 'string' || value.length === 0) return {};
    try {
      return JSON.parse(value) as Record<string, unknown>;
    } catch {
      return { raw: value };
    }
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
      .map(tc => ({
        id: tc.id as string,
        name: tc.name as string,
        args: this.parseToolArgs(tc.arguments),
        result: (tc.result_summary as string) || undefined,
        success: (tc.success as number) === 1,
        duration: (tc.duration_ms as number) || 0,
        timestamp: tc.timestamp as number,
        turnId: tc.turn_id as string,
        index: (tc.idx as number) || 0,
        parallel: (tc.parallel as number) === 1,
      }));
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

      const toolCalls = data.toolCallRows.map(tc => ({
        id: tc.id as string,
        name: tc.name as string,
        args: this.parseToolArgs(tc.arguments),
        result: (tc.result_summary as string) || undefined,
        success: (tc.success as number) === 1,
        duration: (tc.duration_ms as number) || 0,
        timestamp: tc.timestamp as number,
        turnId: tc.turn_id as string,
        index: (tc.idx as number) || 0,
        parallel: (tc.parallel as number) === 1,
      }));

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

  private normalizeToolCategory(toolName: string) {
    const fromMap = TOOL_CATEGORY_MAP[toolName as keyof typeof TOOL_CATEGORY_MAP];
    if (fromMap) return fromMap;

    const lower = toolName.toLowerCase();
    if (lower.includes('read')) return 'Read';
    if (lower.includes('edit')) return 'Edit';
    if (lower.includes('write') || lower.includes('create')) return 'Write';
    if (lower.includes('bash') || lower.includes('exec') || lower.includes('terminal')) return 'Bash';
    if (lower.includes('search') || lower.includes('grep') || lower.includes('glob') || lower.includes('find')) return 'Search';
    if (lower.includes('web') || lower.includes('fetch') || lower.includes('url')) return 'Web';
    if (lower.includes('agent')) return 'Agent';
    if (lower.includes('skill')) return 'Skill';
    return 'Other';
  }

  async getStructuredReplay(sessionId: string) {
    try {
      const data = this.loadTelemetryRows(sessionId);
      if (!data) return null;

      const toolDistribution = {
        Read: 0,
        Edit: 0,
        Write: 0,
        Bash: 0,
        Search: 0,
        Web: 0,
        Agent: 0,
        Skill: 0,
        Other: 0,
      };
      let totalThinkingTokens = 0;
      let totalAllTokens = 0;
      let totalDurationMs = 0;

      const turns = data.turnRows.map(row => {
        const blocks: Array<{
          type: 'user' | 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'error';
          content: string;
          toolCall?: {
            id: string;
            name: string;
            args: Record<string, unknown>;
            result?: string;
            success: boolean;
            duration: number;
            category: keyof typeof toolDistribution;
          };
          timestamp: number;
        }> = [];

        if (row.user_prompt) {
          blocks.push({
            type: 'user',
            content: row.user_prompt as string,
            timestamp: row.start_time as number,
          });
        }

        if (row.thinking_content) {
          blocks.push({
            type: 'thinking',
            content: row.thinking_content as string,
            timestamp: row.start_time as number,
          });
          totalThinkingTokens += Math.ceil(String(row.thinking_content).length / 4);
        }

        const turnToolCalls = data.toolCallRows.filter(tc => tc.turn_id === row.id);
        for (const tc of turnToolCalls) {
          const category = this.normalizeToolCategory(tc.name as string) as keyof typeof toolDistribution;
          toolDistribution[category]++;

          blocks.push({
            type: 'tool_call',
            content: tc.name as string,
            toolCall: {
              id: tc.tool_call_id as string,
              name: tc.name as string,
              args: this.parseToolArgs(tc.arguments),
              result: (tc.result_summary as string) || undefined,
              success: (tc.success as number) === 1,
              duration: (tc.duration_ms as number) || 0,
              category,
            },
            timestamp: tc.timestamp as number,
          });

          if (tc.error) {
            blocks.push({
              type: 'error',
              content: tc.error as string,
              timestamp: tc.timestamp as number,
            });
          }
        }

        if (row.assistant_response) {
          blocks.push({
            type: 'text',
            content: row.assistant_response as string,
            timestamp: (row.end_time as number) || (row.start_time as number),
          });
        }

        totalAllTokens += ((row.total_input_tokens as number) || 0) + ((row.total_output_tokens as number) || 0);
        totalDurationMs += (row.duration_ms as number) || 0;

        return {
          turnNumber: row.turn_number as number,
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
          deviations = detector.detectByRules(trajectory);
        }
      } catch {}

      const selfRepair = this.calculateSelfRepairStats(data.toolCallRows);

      return {
        sessionId,
        turns,
        summary: {
          totalTurns: turns.length,
          toolDistribution,
          thinkingRatio: totalAllTokens > 0 ? totalThinkingTokens / totalAllTokens : 0,
          selfRepairChains: selfRepair.successes,
          totalDurationMs,
          deviations,
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
