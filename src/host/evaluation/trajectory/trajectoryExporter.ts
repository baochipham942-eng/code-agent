import { mkdir, writeFile } from 'fs/promises';
import path from 'path';

import { getDatabase } from '../../services/core/databaseService';
import { getTelemetryQueryService } from '../telemetryQueryService';
import type {
  ReplayBlock,
  ReplayToolCategory,
  ReplayToolSchema,
  StructuredReplay,
} from '../../../shared/contract/evaluation';
import {
  INCOMPLETE_TOOL_RESULT_MARKER,
  DEFAULT_AGENT_TRAJECTORY_DATASET_VERSION,
  type AgentTrajectory,
  type AgentTrajectoryCollectionIntent,
  type AgentTrajectoryCollectionMetadata,
  type AgentTrajectoryCollectionSource,
  type AgentTrajectoryDatasetRole,
  type AgentTrajectoryGateFailure,
  type AgentTrajectoryQualityTier,
  type AgentTrajectoryStep,
  type AgentTrajectoryTaskKind,
  type AgentTrajectoryToolDefinition,
  resolveAgentTrajectoryCollectionMetadata,
  readAgentTrajectoryCollectionMetadata,
  writeAgentTrajectoryCollectionMetadata,
} from '../../../shared/contract/agentTrajectory';
import { evaluateAgentTrajectoryReplay } from './trajectoryGate';

const TIER_RANK: Record<AgentTrajectoryQualityTier, number> = {
  G0: 0,
  G1: 1,
  G2: 2,
};

export interface AgentTrajectoryExportOptions {
  sessionIds?: string[];
  limit?: number;
  since?: number;
  until?: number;
  minTier?: AgentTrajectoryQualityTier;
  includeRejected?: boolean;
  datasetVersion?: string;
  persistCollectionMetadata?: boolean;
  exportCollectionSource?: AgentTrajectoryCollectionSource;
}

export interface AgentTrajectoryExportResult {
  generatedAt: number;
  datasetVersion: string;
  sampleWindow?: AgentTrajectorySampleWindow;
  totalSessions: number;
  exported: number;
  rejected: number;
  byTier: Record<AgentTrajectoryQualityTier, number>;
  byDatasetRole: Record<AgentTrajectoryDatasetRole, number>;
  byTaskKind: Record<AgentTrajectoryTaskKind, number>;
  byDatasetVersion: Record<string, number>;
  byCollectionSource: Record<AgentTrajectoryCollectionSource, number>;
  byCollectionIntent: Record<AgentTrajectoryCollectionIntent, number>;
  g2Rate: number;
  failureCounts: Array<{ failure: string; count: number }>;
  failureComparison: Record<AgentTrajectoryDatasetRole, Array<{ failure: string; count: number }>>;
  trendBuckets: AgentTrajectoryTrendBucket[];
  audits: AgentTrajectoryAuditItem[];
  trajectories: AgentTrajectory[];
}

export interface AgentTrajectorySampleWindow {
  since?: number;
  until?: number;
}

export interface AgentTrajectoryTrendBucket {
  bucket: string;
  total: number;
  byTier: Record<AgentTrajectoryQualityTier, number>;
  byDatasetRole: Record<AgentTrajectoryDatasetRole, number>;
  g2Rate: number;
  failureTop: Array<{ failure: string; count: number }>;
}

export interface AgentTrajectoryAuditItem {
  sessionId: string;
  dataSource?: StructuredReplay['dataSource'];
  tier: AgentTrajectoryQualityTier;
  exportReady: boolean;
  failures: AgentTrajectoryGateFailure[];
  taskKind: AgentTrajectoryTaskKind;
  datasetRole: AgentTrajectoryDatasetRole;
  datasetReason: string;
  datasetVersion: string;
  collectionIntent: AgentTrajectoryCollectionIntent;
  collectionSource: AgentTrajectoryCollectionSource;
  collectionUpdatedAt: number;
  startedAt?: number;
  metrics: AgentTrajectory['quality']['metrics'];
  evidenceControl?: AgentTrajectory['summary']['evidenceControl'];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeArgs(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function collectBlocks(replay: StructuredReplay): Array<{ turnNumber: number; block: ReplayBlock }> {
  return replay.turns.flatMap((turn) =>
    turn.blocks.map((block) => ({
      turnNumber: turn.turnNumber,
      block,
    })),
  );
}

function addToolDefinition(
  definitions: Map<string, AgentTrajectoryToolDefinition>,
  schema: ReplayToolSchema | undefined,
): void {
  if (!schema || definitions.has(schema.name)) return;
  definitions.set(schema.name, {
    name: schema.name,
    inputSchema: schema.inputSchema,
    requiresPermission: schema.requiresPermission,
    permissionLevel: schema.permissionLevel,
  });
}

function summarizeModels(steps: AgentTrajectoryStep[]): Array<{ provider: string; model: string; count: number }> {
  const counts = new Map<string, { provider: string; model: string; count: number }>();
  for (const step of steps) {
    if (!step.model) continue;
    const key = `${step.model.provider}/${step.model.model}`;
    const existing = counts.get(key) ?? {
      provider: step.model.provider,
      model: step.model.model,
      count: 0,
    };
    existing.count++;
    counts.set(key, existing);
  }
  return [...counts.values()];
}

function emptyToolDistribution(): Record<ReplayToolCategory, number> {
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

function firstTimestamp(replay: StructuredReplay): number {
  return replay.turns[0]?.startTime ?? Date.now();
}

function lastTimestamp(replay: StructuredReplay, steps: AgentTrajectoryStep[]): number {
  return (
    steps[steps.length - 1]?.timestamp ?? replay.turns[replay.turns.length - 1]?.startTime ?? firstTimestamp(replay)
  );
}

export function buildAgentTrajectoryFromReplay(
  replay: StructuredReplay,
  options: { collection?: AgentTrajectoryCollectionMetadata } = {},
): AgentTrajectory {
  const quality = evaluateAgentTrajectoryReplay(replay);
  const collection = options.collection ?? resolveAgentTrajectoryCollectionMetadata(quality, undefined);
  const definitions = new Map<string, AgentTrajectoryToolDefinition>();
  const textBlocks = collectBlocks(replay).filter(
    ({ block }) => block.type === 'text' && block.content.trim().length > 0,
  );
  const finalTextBlock = textBlocks[textBlocks.length - 1]?.block;
  const steps: AgentTrajectoryStep[] = [];

  const pushStep = (step: Omit<AgentTrajectoryStep, 'index'>): void => {
    steps.push({ ...step, index: steps.length });
  };

  for (const { turnNumber, block } of collectBlocks(replay)) {
    if (block.modelDecision?.toolSchemas) {
      for (const schema of block.modelDecision.toolSchemas) {
        addToolDefinition(definitions, schema);
      }
    }
    if (block.toolCall?.toolSchema) {
      addToolDefinition(definitions, block.toolCall.toolSchema);
    }

    if (block.type === 'user') {
      pushStep({
        turnNumber,
        role: 'user',
        timestamp: block.timestamp,
        content: block.content,
      });
      continue;
    }

    if (block.type === 'thinking') {
      pushStep({
        turnNumber,
        role: 'thinking',
        timestamp: block.timestamp,
        content: block.content,
      });
      continue;
    }

    if (block.type === 'model_call' && block.modelDecision) {
      pushStep({
        turnNumber,
        role: 'model_call',
        timestamp: block.timestamp,
        content: block.content,
        model: {
          id: block.modelDecision.id,
          provider: block.modelDecision.provider,
          model: block.modelDecision.model,
          requestedProvider: block.modelDecision.requestedProvider,
          requestedModel: block.modelDecision.requestedModel,
          resolvedProvider: block.modelDecision.resolvedProvider,
          resolvedModel: block.modelDecision.resolvedModel,
          responseType: block.modelDecision.responseType,
          inputTokens: block.modelDecision.inputTokens,
          outputTokens: block.modelDecision.outputTokens,
          latencyMs: block.modelDecision.latencyMs,
        },
      });
      continue;
    }

    if (block.type === 'tool_call' && block.toolCall) {
      const toolCall = block.toolCall;
      const result = typeof toolCall.result === 'string' ? toolCall.result : '';
      const pendingCloseout = result.includes(INCOMPLETE_TOOL_RESULT_MARKER);
      pushStep({
        turnNumber,
        role: 'tool_call',
        timestamp: block.timestamp,
        content: toolCall.name,
        toolCall: {
          id: toolCall.id,
          name: toolCall.name,
          category: toolCall.category,
          args: normalizeArgs(toolCall.actualArgs ?? toolCall.args),
          argsSource: toolCall.argsSource,
          hasDefinition: Boolean(toolCall.toolSchema),
          agentPointerEvent: toolCall.agentPointerEvent || null,
        },
      });
      pushStep({
        turnNumber,
        role: 'tool_result',
        timestamp: block.timestamp + Math.max(0, toolCall.duration || 0),
        content: result,
        toolResult: {
          toolCallId: toolCall.id,
          name: toolCall.name,
          success: toolCall.success,
          result,
          durationMs: toolCall.duration,
          pendingCloseout,
          agentPointerEvent: toolCall.agentPointerEvent || null,
          agentPointerTimeline: toolCall.agentPointerTimeline,
        },
      });
      continue;
    }

    if (block.type === 'text') {
      pushStep({
        turnNumber,
        role: block === finalTextBlock ? 'assistant_final' : 'assistant',
        timestamp: block.timestamp,
        content: block.content,
      });
      continue;
    }

    if (block.type === 'event' || block.type === 'context_event') {
      pushStep({
        turnNumber,
        role: block.type,
        timestamp: block.timestamp,
        content: block.content,
        event: block.event
          ? {
              eventType: block.event.eventType,
              summary: block.event.summary,
              data: block.event.data,
              durationMs: block.event.durationMs,
            }
          : undefined,
      });
      continue;
    }

    if (block.type === 'memory_audit') {
      pushStep({
        turnNumber,
        role: 'memory_audit',
        timestamp: block.timestamp,
        content: block.content,
      });
      continue;
    }

    if (block.type === 'error') {
      pushStep({
        turnNumber,
        role: 'error',
        timestamp: block.timestamp,
        content: block.content,
      });
    }
  }

  const startedAt = firstTimestamp(replay);
  const endedAt = lastTimestamp(replay, steps);
  const distribution = emptyToolDistribution();
  for (const step of steps) {
    if (step.toolCall) {
      distribution[step.toolCall.category]++;
    }
  }

  return {
    schemaVersion: 1,
    trajectoryId: `${replay.traceIdentity.traceId}:agent-trajectory:v1`,
    sessionId: replay.sessionId,
    traceIdentity: replay.traceIdentity,
    dataSource: replay.dataSource,
    quality,
    collection,
    startedAt,
    endedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    summary: {
      turnCount: replay.turns.length,
      modelCallCount: steps.filter((step) => step.role === 'model_call').length,
      toolCallCount: steps.filter((step) => step.role === 'tool_call').length,
      toolResultCount: steps.filter((step) => step.role === 'tool_result').length,
      eventCount: steps.filter((step) => step.role === 'event' || step.role === 'context_event').length,
      toolDistribution: distribution,
      models: summarizeModels(steps),
      finalAnswer: finalTextBlock?.content,
      browserComputerProofCount: replay.summary.browserComputerProofTimeline?.length,
      browserComputerProofTimeline: replay.summary.browserComputerProofTimeline,
      evidenceControl: replay.summary.evidenceControl,
    },
    toolDefinitions: [...definitions.values()],
    steps,
  };
}

export function shouldExportTrajectory(
  trajectory: AgentTrajectory,
  minTier: AgentTrajectoryQualityTier,
  includeRejected: boolean,
  exportCollectionSource?: AgentTrajectoryCollectionSource,
): boolean {
  if (exportCollectionSource && trajectory.collection.source !== exportCollectionSource) return false;
  if (includeRejected) return true;
  if (trajectory.collection.datasetRole === 'excluded') return false;
  return TIER_RANK[trajectory.quality.tier] >= TIER_RANK[minTier];
}

export function normalizeAgentTrajectorySampleWindow(
  options: {
    since?: number;
    until?: number;
  } = {},
): AgentTrajectorySampleWindow | undefined {
  const since = Number.isFinite(options.since) && options.since! > 0 ? Math.floor(options.since!) : undefined;
  const until = Number.isFinite(options.until) && options.until! > 0 ? Math.floor(options.until!) : undefined;
  if (since === undefined && until === undefined) return undefined;
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error('trajectory sample since must be before until');
  }
  return { since, until };
}

export function listTelemetryTrajectorySessionIds(
  options: {
    limit?: number;
    since?: number;
    until?: number;
  } = {},
): string[] {
  const db = getDatabase().getDb();
  if (!db) return [];
  const limit = Math.max(1, Math.floor(options.limit ?? 200));
  const window = normalizeAgentTrajectorySampleWindow(options);
  const filters: string[] = [];
  const values: unknown[] = [];
  if (window?.since !== undefined) {
    filters.push('COALESCE(end_time, start_time) >= ?');
    values.push(window.since);
  }
  if (window?.until !== undefined) {
    filters.push('COALESCE(end_time, start_time) <= ?');
    values.push(window.until);
  }
  const where = filters.length > 0 ? `WHERE ${filters.join(' AND ')}` : '';
  const rows = db
    .prepare(
      `
    SELECT id
    FROM telemetry_sessions
    ${where}
    ORDER BY COALESCE(end_time, start_time) DESC
    LIMIT ?
  `,
    )
    .all(...values, limit) as Array<{ id: string }>;
  return rows.map((row) => row.id);
}

function emptyDatasetRoleCounts(): Record<AgentTrajectoryDatasetRole, number> {
  return {
    core_eval: 0,
    diagnostic: 0,
    excluded: 0,
  };
}

function emptyTierCounts(): Record<AgentTrajectoryQualityTier, number> {
  return { G0: 0, G1: 0, G2: 0 };
}

function incrementRecord<T extends string>(record: Record<T, number>, key: T): void {
  record[key] = (record[key] || 0) + 1;
}

function topFailures(map: Map<string, number>, limit = 10): Array<{ failure: string; count: number }> {
  return [...map.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, limit)
    .map(([failure, count]) => ({ failure, count }));
}

function bucketKey(timestamp: number | undefined): string {
  if (!timestamp || !Number.isFinite(timestamp)) return 'unknown';
  const iso = new Date(timestamp).toISOString();
  return iso.slice(0, 10);
}

function getSessionMetadata(sessionId: string): Record<string, unknown> | undefined {
  return getDatabase().getSession(sessionId, { includeDeleted: true })?.metadata;
}

function persistCollectionMetadataIfNeeded(
  sessionId: string,
  metadata: Record<string, unknown> | undefined,
  collection: AgentTrajectoryCollectionMetadata,
  persist: boolean,
): void {
  if (!persist || readAgentTrajectoryCollectionMetadata(metadata)) return;
  getDatabase().updateSession(sessionId, {
    metadata: writeAgentTrajectoryCollectionMetadata(metadata, collection),
  });
}

export async function exportAgentTrajectories(
  options: AgentTrajectoryExportOptions = {},
): Promise<AgentTrajectoryExportResult> {
  const minTier = options.minTier ?? 'G2';
  const includeRejected = options.includeRejected ?? false;
  const datasetVersion = options.datasetVersion?.trim() || DEFAULT_AGENT_TRAJECTORY_DATASET_VERSION;
  const sampleWindow = normalizeAgentTrajectorySampleWindow(options);
  const sessionIds = options.sessionIds?.length
    ? options.sessionIds
    : listTelemetryTrajectorySessionIds({
        limit: options.limit ?? 200,
        since: sampleWindow?.since,
        until: sampleWindow?.until,
      });
  const byTier = emptyTierCounts();
  const byDatasetRole = emptyDatasetRoleCounts();
  const byTaskKind: Record<AgentTrajectoryTaskKind, number> = {
    coding: 0,
    search: 0,
    data_analysis: 0,
    agent_task: 0,
    ordinary_chat: 0,
    other: 0,
  };
  const byDatasetVersion: Record<string, number> = {};
  const byCollectionSource: Record<AgentTrajectoryCollectionSource, number> = {
    quality_gate: 0,
    manual_review: 0,
    audit_backfill: 0,
    session_metadata: 0,
  };
  const byCollectionIntent: Record<AgentTrajectoryCollectionIntent, number> = {
    new_core_eval_candidate: 0,
    historical_diagnostic: 0,
    manual_review: 0,
    excluded: 0,
  };
  const trajectories: AgentTrajectory[] = [];
  const audits: AgentTrajectoryAuditItem[] = [];
  const failureCounts = new Map<string, number>();
  const failureCountsByRole: Record<AgentTrajectoryDatasetRole, Map<string, number>> = {
    core_eval: new Map(),
    diagnostic: new Map(),
    excluded: new Map(),
  };
  const trendBucketMap = new Map<
    string,
    {
      total: number;
      byTier: Record<AgentTrajectoryQualityTier, number>;
      byDatasetRole: Record<AgentTrajectoryDatasetRole, number>;
      failures: Map<string, number>;
    }
  >();
  let rejected = 0;

  const recordAudit = (item: AgentTrajectoryAuditItem): void => {
    audits.push(item);
    byTier[item.tier]++;
    byDatasetRole[item.datasetRole]++;
    byTaskKind[item.taskKind]++;
    incrementRecord(byDatasetVersion, item.datasetVersion);
    byCollectionSource[item.collectionSource]++;
    byCollectionIntent[item.collectionIntent]++;
    const roleFailures = failureCountsByRole[item.datasetRole];
    for (const failure of item.failures) {
      failureCounts.set(failure, (failureCounts.get(failure) || 0) + 1);
      roleFailures.set(failure, (roleFailures.get(failure) || 0) + 1);
    }
    const key = bucketKey(item.startedAt);
    const bucket = trendBucketMap.get(key) ?? {
      total: 0,
      byTier: emptyTierCounts(),
      byDatasetRole: emptyDatasetRoleCounts(),
      failures: new Map<string, number>(),
    };
    bucket.total++;
    bucket.byTier[item.tier]++;
    bucket.byDatasetRole[item.datasetRole]++;
    for (const failure of item.failures) {
      bucket.failures.set(failure, (bucket.failures.get(failure) || 0) + 1);
    }
    trendBucketMap.set(key, bucket);
  };

  for (const sessionId of sessionIds) {
    const sessionMetadata = getSessionMetadata(sessionId);
    const replay = await getTelemetryQueryService().getStructuredReplay(sessionId);
    if (!replay) {
      const quality = evaluateAgentTrajectoryReplay(null);
      const collection = resolveAgentTrajectoryCollectionMetadata(quality, sessionMetadata, {
        datasetVersion,
        source: 'audit_backfill',
      });
      persistCollectionMetadataIfNeeded(
        sessionId,
        sessionMetadata,
        collection,
        Boolean(options.persistCollectionMetadata),
      );
      recordAudit({
        sessionId,
        tier: quality.tier,
        exportReady: quality.exportReady,
        failures: quality.failures,
        taskKind: collection.taskKind,
        datasetRole: collection.datasetRole,
        datasetReason: collection.reason,
        datasetVersion: collection.datasetVersion,
        collectionIntent: collection.intent,
        collectionSource: collection.source,
        collectionUpdatedAt: collection.updatedAt,
        metrics: quality.metrics,
      });
      rejected++;
      continue;
    }
    const quality = evaluateAgentTrajectoryReplay(replay);
    const collection = resolveAgentTrajectoryCollectionMetadata(quality, sessionMetadata, {
      datasetVersion,
      source: 'audit_backfill',
    });
    persistCollectionMetadataIfNeeded(
      sessionId,
      sessionMetadata,
      collection,
      Boolean(options.persistCollectionMetadata),
    );
    const trajectory = buildAgentTrajectoryFromReplay(replay, { collection });
    recordAudit({
      sessionId,
      dataSource: replay.dataSource,
      tier: trajectory.quality.tier,
      exportReady: trajectory.quality.exportReady,
      failures: trajectory.quality.failures,
      taskKind: trajectory.collection.taskKind,
      datasetRole: trajectory.collection.datasetRole,
      datasetReason: trajectory.collection.reason,
      datasetVersion: trajectory.collection.datasetVersion,
      collectionIntent: trajectory.collection.intent,
      collectionSource: trajectory.collection.source,
      collectionUpdatedAt: trajectory.collection.updatedAt,
      startedAt: trajectory.startedAt,
      metrics: trajectory.quality.metrics,
      evidenceControl: trajectory.summary.evidenceControl,
    });
    if (shouldExportTrajectory(trajectory, minTier, includeRejected, options.exportCollectionSource)) {
      trajectories.push(trajectory);
    } else {
      rejected++;
    }
  }

  return {
    generatedAt: Date.now(),
    datasetVersion,
    sampleWindow,
    totalSessions: sessionIds.length,
    exported: trajectories.length,
    rejected,
    byTier,
    byDatasetRole,
    byTaskKind,
    byDatasetVersion,
    byCollectionSource,
    byCollectionIntent,
    g2Rate: sessionIds.length > 0 ? byTier.G2 / sessionIds.length : 0,
    failureCounts: topFailures(failureCounts, Number.MAX_SAFE_INTEGER),
    failureComparison: {
      core_eval: topFailures(failureCountsByRole.core_eval),
      diagnostic: topFailures(failureCountsByRole.diagnostic),
      excluded: topFailures(failureCountsByRole.excluded),
    },
    trendBuckets: [...trendBucketMap.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([bucket, value]) => ({
        bucket,
        total: value.total,
        byTier: value.byTier,
        byDatasetRole: value.byDatasetRole,
        g2Rate: value.total > 0 ? value.byTier.G2 / value.total : 0,
        failureTop: topFailures(value.failures, 5),
      })),
    audits,
    trajectories,
  };
}

export async function writeAgentTrajectoryJsonl(outPath: string, trajectories: AgentTrajectory[]): Promise<void> {
  await mkdir(path.dirname(outPath), { recursive: true });
  await writeFile(
    outPath,
    trajectories.map((trajectory) => JSON.stringify(trajectory)).join('\n') + (trajectories.length > 0 ? '\n' : ''),
    'utf8',
  );
}
