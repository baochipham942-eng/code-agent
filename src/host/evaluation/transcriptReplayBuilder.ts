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
import {
  buildAgentPointerTimeline,
  extractAgentPointerEvent,
} from '../../shared/utils/agentPointerEvidence';
import { attachBrowserComputerProofTimeline } from '../../shared/utils/browserComputerProofTimeline';
import {
  collectSurfaceExecutionExportProjection,
  projectSurfaceExecutionMetadataForExport,
  projectSurfaceExecutionResultMetadataForExport,
  stripRawSurfaceExecutionExportFields,
  type SurfaceExecutionExportProjectionV1,
} from '../../shared/utils/surfaceExecutionExportProjection';
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

export function projectTranscriptToolResultForReplay(input: {
  toolName: string;
  toolCallId: string;
  result: ToolResult | undefined;
  timestamp: number;
}): {
  resultContent?: string;
  resultMetadata?: Record<string, unknown>;
  agentPointerEvent?: ReturnType<typeof extractAgentPointerEvent>;
  agentPointerTimeline?: ReturnType<typeof buildAgentPointerTimeline>;
} {
  const fallback = {
    toolName: input.toolName,
    toolCallId: input.toolCallId,
    success: input.result?.success,
    error: input.result?.error,
    timestamp: input.timestamp,
  };
  const surfaceExecution = projectSurfaceExecutionMetadataForExport(
    input.result?.metadata,
    fallback,
  );
  const resultMetadata = input.result?.metadata
    ? surfaceExecution
      ? projectSurfaceExecutionResultMetadataForExport(input.result.metadata, fallback)
      : stripRawSurfaceExecutionExportFields(
          input.result.metadata,
          0,
          false,
        ) as Record<string, unknown>
    : undefined;
  const agentPointerTimeline = buildAgentPointerTimeline(resultMetadata);
  const agentPointerEvent = extractAgentPointerEvent(resultMetadata);
  const surfaceEvent = surfaceExecution?.sessions
    .flatMap((session) => session.events)
    .at(-1);
  return {
    resultContent: surfaceEvent
      ? `${surfaceEvent.userSummary} (${surfaceEvent.status})`
      : input.result ? getToolResultContent(input.result) : undefined,
    resultMetadata,
    agentPointerEvent,
    agentPointerTimeline: agentPointerTimeline.length > 0 ? agentPointerTimeline : undefined,
  };
}

export function buildSurfaceExecutionReplayBlocks(
  projection: SurfaceExecutionExportProjectionV1 | null | undefined,
): ReplayBlock[] {
  if (!projection) return [];
  const blocks: ReplayBlock[] = [];
  projection.sessions.forEach((session, sessionIndex) => {
    session.events.forEach((event, eventIndex) => {
      blocks.push({
        type: 'event',
        content: event.userSummary,
        timestamp: event.startedAt,
        event: {
          eventType: 'surface_execution_archive',
          summary: event.userSummary,
          data: {
            version: 1,
            archiveOnly: true,
            writable: false,
            authority: 'none',
            surfaceSessionId: `archive-session-${sessionIndex + 1}`,
            eventId: `archive-event-${sessionIndex + 1}-${eventIndex + 1}`,
            sequence: event.sequence,
            surface: session.surface,
            provider: event.provider || session.provider,
            source: session.source,
            phase: event.phase,
            status: event.status,
            sessionState: event.sessionState,
            operation: event.operation,
            observation: event.observation,
            evidenceRefs: event.evidenceRefs,
            evidence: event.evidence,
            artifactRefs: event.artifactRefs,
            historicalControls: event.availableControls,
            actionResult: event.actionResult,
            evidencePortability: 'metadata_only',
            completedAt: event.completedAt,
          },
        },
      });
    });
  });
  return blocks.sort((left, right) => left.timestamp - right.timestamp);
}

export function attachSurfaceExecutionReplayBlocks(
  turns: ReplayTurn[],
  projection: SurfaceExecutionExportProjectionV1 | null | undefined,
): void {
  const blocks = buildSurfaceExecutionReplayBlocks(projection);
  if (blocks.length === 0) return;
  if (turns.length === 0) {
    turns.push({
      turnNumber: 1,
      turnType: 'iteration',
      blocks: [],
      inputTokens: 0,
      outputTokens: 0,
      durationMs: 0,
      startTime: blocks[0].timestamp,
    });
  }
  const emittedEventIds = new Set(turns.flatMap((turn) => turn.blocks.flatMap((block) => {
    if (block.type !== 'event' || block.event?.eventType !== 'surface_execution_archive') return [];
    const data = block.event.data;
    return data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.eventId === 'string'
      ? [data.eventId]
      : [];
  })));
  for (const block of blocks) {
    const data = block.event?.data;
    const eventId = data && typeof data === 'object' && !Array.isArray(data)
      && typeof data.eventId === 'string'
      ? data.eventId
      : undefined;
    if (eventId && emittedEventIds.has(eventId)) continue;
    let target = turns[0];
    for (const turn of turns) {
      if (turn.startTime > block.timestamp) break;
      target = turn;
    }
    target.blocks.push(block);
    if (eventId) emittedEventIds.add(eventId);
  }
  const blockOrder: Record<ReplayBlock['type'], number> = {
    user: 0,
    thinking: 1,
    model_call: 2,
    memory_audit: 3,
    event: 3,
    context_event: 3,
    tool_call: 4,
    tool_result: 5,
    error: 6,
    text: 7,
  };
  for (const turn of turns) {
    turn.blocks.sort((left, right) => (
      left.timestamp - right.timestamp || blockOrder[left.type] - blockOrder[right.type]
    ));
    const endTimestamp = turn.blocks.at(-1)?.timestamp ?? turn.startTime;
    turn.durationMs = Math.max(turn.durationMs, endTimestamp - turn.startTime, 0);
  }
}

export function attachStoredSurfaceExecutionReplayBlocks(
  sessionId: string,
  turns: ReplayTurn[],
  onError?: (error: unknown) => void,
): void {
  try {
    const database = getDatabase();
    const session = database.getSession(sessionId, { includeDeleted: true });
    attachSurfaceExecutionReplayBlocks(
      turns,
      collectSurfaceExecutionExportProjection(database.getMessages(sessionId), session?.metadata),
    );
  } catch (error) {
    onError?.(error);
  }
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
  const projectedResult = projectTranscriptToolResultForReplay({
    toolName: toolCall.name,
    toolCallId: toolCall.id,
    result,
    timestamp,
  });
  return {
    type: 'tool_call',
    content: toolCall.name,
    toolCall: {
      id: toolCall.id,
      name: toolCall.name,
      args,
      actualArgs: args,
      argsSource: 'transcript',
      result: projectedResult.resultContent || undefined,
      resultMetadata: projectedResult.resultMetadata,
      agentPointerEvent: projectedResult.agentPointerEvent,
      agentPointerTimeline: projectedResult.agentPointerTimeline,
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
    const projectedResult = projectTranscriptToolResultForReplay({
      toolName: matchingCall?.name || 'unknown',
      toolCallId: result.toolCallId,
      result,
      timestamp: message.timestamp,
    });
    blocks.push({
      type: 'tool_result',
      content: projectedResult.resultContent || '',
      timestamp: message.timestamp,
      toolCall: {
        id: result.toolCallId,
        name: matchingCall?.name || 'unknown',
        args,
        actualArgs: matchingCall ? args : undefined,
        argsSource: matchingCall ? 'transcript' : undefined,
        result: projectedResult.resultContent || undefined,
        resultMetadata: projectedResult.resultMetadata,
        agentPointerEvent: projectedResult.agentPointerEvent,
        agentPointerTimeline: projectedResult.agentPointerTimeline,
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

  const surfaceExecution = collectSurfaceExecutionExportProjection(
    messages,
    session.metadata,
  );

  if (messages.length === 0 && !surfaceExecution) {
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
  attachSurfaceExecutionReplayBlocks(turns, surfaceExecution);
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
  return attachSessionQualityScoring(attachBrowserComputerProofTimeline(replay));
}
