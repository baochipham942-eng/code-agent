// ============================================================================
// transcriptReplayBuilder — Transcript-only replay path extracted from
// TelemetryQueryService god class. Telemetry-rich path (modelCallRows /
// toolCallRows / eventRows) stays in the class because it accesses the DB
// adapter via this; transcript path is pure and operates on Message[].
// ============================================================================

import { getDatabase } from '../services/core/databaseService';
import { buildSessionTraceIdentity } from '../../shared/contract/reviewQueue';
import type { Message, ToolCall, ToolResult } from '../../shared/contract';
import type { TurnQualitySummary } from '../../shared/contract/turnQuality';
import type {
  ReplayBlock,
  ReplayMetricAvailability,
  ReplayToolCategory,
  ReplayTurn,
  StructuredReplay,
  TelemetryCompleteness,
} from '../../shared/contract/evaluation';
import { attachSessionQualityScoring } from './sessionQualityScoring';

export type ReplayToolDistribution = Record<ReplayToolCategory, number>;

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

export function createEmptyToolDistribution(): ReplayToolDistribution {
  return {
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
}

export function normalizeToolCategory(toolName: string): ReplayToolCategory {
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

export function getToolResultContent(result: ToolResult): string {
  return result.output
    || result.error
    || result.outputPath
    || (result.metadata ? JSON.stringify(result.metadata) : '');
}

function collectTranscriptToolResults(messages: Message[]): Map<string, ToolResult> {
  const results = new Map<string, ToolResult>();
  for (const message of messages) {
    for (const result of message.toolResults || []) {
      results.set(result.toolCallId, result);
    }
    for (const call of message.toolCalls || []) {
      if (call.result) {
        results.set(call.id, call.result);
      }
    }
  }
  return results;
}

function collectTranscriptToolCalls(messages: Message[]): Map<string, ToolCall> {
  const calls = new Map<string, ToolCall>();
  for (const message of messages) {
    for (const call of message.toolCalls || []) {
      calls.set(call.id, call);
    }
  }
  return calls;
}

function buildTranscriptToolCallBlock(
  toolCall: ToolCall,
  resultByCallId: Map<string, ToolResult>,
  timestamp: number,
): ReplayBlock {
  const result = toolCall.result || resultByCallId.get(toolCall.id);
  const args = toolCall.arguments || {};
  const category = normalizeToolCategory(toolCall.name);
  return {
    type: 'tool_call',
    content: toolCall.name,
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      args,
      actualArgs: args,
      argsSource: 'transcript',
      result: result ? getToolResultContent(result) || undefined : undefined,
      resultMetadata: result?.metadata,
      success: result?.success ?? true,
      successKnown: Boolean(result),
      duration: result?.duration ?? 0,
      category,
    },
    timestamp,
  };
}

export function buildMemoryAuditBlock(summary: TurnQualitySummary, timestamp: number): ReplayBlock {
  const memoryCount = summary.memory.blocks.reduce((sum, block) => (
    sum + (block.items?.length || block.count || 0)
  ), 0);
  const model = `${summary.strategy.provider}/${summary.strategy.model}`;
  return {
    type: 'memory_audit',
    content: `Memory ${summary.memory.mode}; ${memoryCount} memories; ${model}; score ${summary.score?.score ?? 0}/${summary.score?.max ?? 100}`,
    timestamp,
    memoryAudit: {
      mode: summary.memory.mode,
      blocks: summary.memory.blocks,
      suppressedEntryIds: summary.memory.suppressedEntryIds,
      offReason: summary.memory.offReason,
      score: summary.score,
      agentScorecard: summary.agentScorecard,
    },
  };
}

function toTranscriptReplayBlocks(
  message: Message,
  resultByCallId: Map<string, ToolResult>,
  callById: Map<string, ToolCall>,
): ReplayBlock[] {
  const blocks: ReplayBlock[] = [];
  const emittedToolCallIds = new Set<string>();
  const textType: ReplayBlock['type'] = message.role === 'user' ? 'user' : 'text';

  if (message.thinking) {
    blocks.push({
      type: 'thinking',
      content: message.thinking,
      timestamp: message.timestamp,
    });
  }

  if (message.contentParts?.length) {
    for (const part of message.contentParts) {
      if (part.type === 'text') {
        if (part.text) {
          blocks.push({
            type: textType,
            content: part.text,
            timestamp: message.timestamp,
          });
        }
        continue;
      }

      const toolCall = message.toolCalls?.find(call => call.id === part.toolCallId);
      if (toolCall) {
        blocks.push(buildTranscriptToolCallBlock(toolCall, resultByCallId, message.timestamp));
        emittedToolCallIds.add(toolCall.id);
      }
    }
  } else if (message.content && !(message.role === 'tool' && message.toolResults?.length)) {
    blocks.push({
      type: message.role === 'tool' ? 'tool_result' : textType,
      content: message.content,
      timestamp: message.timestamp,
    });
  }

  for (const toolCall of message.toolCalls || []) {
    if (emittedToolCallIds.has(toolCall.id)) continue;
    blocks.push(buildTranscriptToolCallBlock(toolCall, resultByCallId, message.timestamp));
    emittedToolCallIds.add(toolCall.id);
  }

  for (const result of message.toolResults || []) {
    const matchingCall = callById.get(result.toolCallId);
    const args = matchingCall?.arguments || {};
    blocks.push({
      type: 'tool_result',
      content: getToolResultContent(result),
      timestamp: message.timestamp,
      toolCall: {
        id: result.toolCallId,
        name: matchingCall?.name || 'unknown',
        args,
        actualArgs: matchingCall ? args : undefined,
        argsSource: matchingCall ? 'transcript' : undefined,
        result: getToolResultContent(result) || undefined,
        resultMetadata: result.metadata,
        success: result.success,
        successKnown: true,
        duration: result.duration ?? 0,
        category: normalizeToolCategory(matchingCall?.name || 'unknown'),
      },
    });
  }

  if (message.metadata?.turnQuality) {
    blocks.push(buildMemoryAuditBlock(message.metadata.turnQuality, message.timestamp));
  }

  return blocks;
}

function calculateTranscriptSelfRepair(turns: ReplayTurn[]): number {
  let chains = 0;

  for (const turn of turns) {
    const failedTools = new Set<string>();
    for (const block of turn.blocks) {
      if (block.type !== 'tool_call' || !block.toolCall?.successKnown) continue;
      if (!block.toolCall.success) {
        failedTools.add(block.toolCall.name);
        continue;
      }
      if (failedTools.has(block.toolCall.name)) {
        chains++;
        failedTools.delete(block.toolCall.name);
      }
    }
  }

  return chains;
}

/**
 * 完整性回调由调用方注入：transcript path 没有 telemetry rows，
 * 但完整性结构需要主 service 的 DB 状态来填，所以走依赖注入。
 */
export type TranscriptCompletenessBuilder = (
  sessionId: string,
  turns: ReplayTurn[],
  transcriptToolCallCount: number,
) => TelemetryCompleteness;

/**
 * 仅基于会话 transcript（不读 telemetry tables）构建结构化 replay。
 * 当 telemetry data 不完整或缺失时作为 fallback。
 */
export function buildTranscriptReplay(
  sessionId: string,
  buildCompleteness: TranscriptCompletenessBuilder,
): StructuredReplay | null {
  const database = getDatabase();
  const session = database.getSession(sessionId, { includeDeleted: true });
  if (!session) {
    return null;
  }

  const messages = database
    .getMessages(sessionId)
    .slice()
    .sort((left, right) => left.timestamp - right.timestamp);

  if (messages.length === 0) {
    return null;
  }

  const resultByCallId = collectTranscriptToolResults(messages);
  const callById = collectTranscriptToolCalls(messages);
  const toolDistribution = createEmptyToolDistribution();
  const turns: ReplayTurn[] = [];

  let currentTurn:
    | {
        turnNumber: number;
        blocks: ReplayBlock[];
        inputTokens: number;
        outputTokens: number;
        startTime: number;
      }
    | null = null;

  const finalizeCurrentTurn = () => {
    if (!currentTurn) {
      return;
    }
    const endTimestamp = currentTurn.blocks[currentTurn.blocks.length - 1]?.timestamp ?? currentTurn.startTime;
    turns.push({
      ...currentTurn,
      durationMs: Math.max(0, endTimestamp - currentTurn.startTime),
    });
    currentTurn = null;
  };

  messages.forEach((message) => {
    const blocks = toTranscriptReplayBlocks(message, resultByCallId, callById);
    if (blocks.length === 0) {
      return;
    }

    for (const block of blocks) {
      if (block.type === 'tool_call' && block.toolCall) {
        toolDistribution[block.toolCall.category]++;
      }
    }

    const isHumanUserMessage = message.role === 'user'
      && (!message.toolResults || message.toolResults.length === 0)
      && (!message.toolCalls || message.toolCalls.length === 0);

    if (isHumanUserMessage || !currentTurn) {
      finalizeCurrentTurn();
      currentTurn = {
        turnNumber: turns.length + 1,
        blocks,
        inputTokens: message.inputTokens || 0,
        outputTokens: message.outputTokens || 0,
        startTime: message.timestamp,
      };
      return;
    }

    currentTurn.blocks.push(...blocks);
    currentTurn.inputTokens += message.inputTokens || 0;
    currentTurn.outputTokens += message.outputTokens || 0;
  });

  finalizeCurrentTurn();
  const transcriptToolCallCount = Object.values(toolDistribution).reduce((sum, count) => sum + count, 0);
  const knownToolOutcomeCount = turns.reduce((sum, turn) => (
    sum + turn.blocks.filter(block => block.type === 'tool_call' && block.toolCall?.successKnown).length
  ), 0);

  const replay: StructuredReplay = {
    sessionId,
    traceIdentity: buildSessionTraceIdentity(sessionId),
    traceSource: 'session_replay',
    dataSource: 'transcript_fallback',
    turns,
    summary: {
      totalTurns: turns.length,
      toolDistribution,
      thinkingRatio: 0,
      selfRepairChains: calculateTranscriptSelfRepair(turns),
      totalDurationMs: turns.reduce((sum, turn) => sum + turn.durationMs, 0),
      metricAvailability: {
        dataSource: 'transcript_fallback',
        replaySource: 'transcript_fallback',
        toolDistribution: 'transcript',
        selfRepair: transcriptToolCallCount === 0 || knownToolOutcomeCount > 0 ? 'transcript' : 'unavailable',
        actualArgs: transcriptToolCallCount > 0 ? 'transcript' : 'unavailable',
      } satisfies ReplayMetricAvailability,
      telemetryCompleteness: buildCompleteness(sessionId, turns, transcriptToolCallCount),
    },
  };
  return attachSessionQualityScoring(replay);
}
