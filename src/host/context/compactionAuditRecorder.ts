import { getDatabase } from '../services/core/databaseService';
import { createLogger } from '../services/infra/logger';
import { computeRequestPrefixShapeHash } from './requestShapeHash';
import type { CompactionSource, CompactionSurvivorManifest, Message } from '../../shared/contract';
import type { CompactionSummaryValidation } from './compactionSummaryValidator';

const logger = createLogger('CompactionAuditRecorder');

interface CompactionAuditSink {
  insertCompactionSnapshot: (input: {
    sessionId: string;
    strategy?: string | null;
    preMessageCount: number;
    postMessageCount: number;
    preTokens: number;
    postTokens: number;
    savedTokens: number;
    usagePercent?: number | null;
    preMessagesSummary?: unknown;
    postMessagesSummary?: unknown;
    createdAt?: number;
    shapeHashBefore?: string | null;
    shapeHashAfter?: string | null;
  }) => { id: string; createdAt: number; byteSize: number };
}

interface CompactionAuditPlanLike {
  sessionId: string;
  source: CompactionSource;
  systemPrompt?: string;
  anchorMessageId?: string;
  preserveRecentCount: number;
  messages: Message[];
  compactedMessages: Message[];
  preservedMessages: Message[];
  manifest: {
    compactedMessageIds?: string[];
    preservedMessageIds?: string[];
    filePaths?: string[];
    files?: unknown[];
    commands?: unknown[];
    errors?: unknown[];
    todos?: unknown[];
    openWork?: unknown[];
    artifacts?: unknown[];
    dataFingerprintText?: string;
    dataFingerprint?: string;
  };
  originalTokens: number;
  modelConfig?: { provider?: string; model?: string };
}

interface CompactionAuditBlockLike {
  summaryVersion?: number;
  source?: CompactionSource;
  anchorMessageId?: string;
  provider?: string;
  model?: string;
  warnings?: string[];
  survivorManifest?: CompactionSurvivorManifest;
}

interface CompactionAuditResultLike {
  success: boolean;
  reason?: string;
  plan: CompactionAuditPlanLike;
  summary?: string;
  summaryMessage?: Message;
  newMessages?: Message[];
  block?: CompactionAuditBlockLike;
  beforeTokens: number;
  afterTokens: number;
  savedTokens: number;
  validation?: CompactionSummaryValidation;
  summaryModel?: {
    provider?: string;
    model?: string;
    useMainModel?: boolean;
    fallbackReason?: string;
  };
  warnings: string[];
}

export interface CompactionAuditRecorderInput {
  result: CompactionAuditResultLike;
  usagePercent?: number | null;
  createdAt?: number;
}

export interface CompactionAuditSummary {
  type: 'compact_messages_with_summary_audit';
  success: boolean;
  reason?: string;
  summaryVersion: number | null;
  source: CompactionSource;
  provider: string | null;
  model: string | null;
  modelConfig: {
    provider: string | null;
    model: string | null;
  };
  summaryModel: {
    provider: string | null;
    model: string | null;
    useMainModel: boolean | null;
    fallbackReason: string | null;
  };
  validation: {
    ok: boolean | null;
    missing: {
      paths: string[];
      errors: string[];
      openWork: string[];
    };
    warnings: string[];
  };
  warnings: string[];
  survivorManifestCounts: {
    compactedMessages: number;
    preservedMessages: number;
    files: number;
    commands: number;
    errors: number;
    openWork: number;
    artifacts: number;
    hasDataFingerprint: boolean;
  };
  summary: {
    messageId: string | null;
    contentLength: number;
    timestamp: number | null;
  };
  anchorMessageId: string | null;
  preserveRecentCount: number;
  tokenDelta: {
    beforeTokens: number;
    afterTokens: number;
    savedTokens: number;
    originalSummaryInputTokens: number;
  };
}

function getAuditSink(): CompactionAuditSink | null {
  if (process.env.CODE_AGENT_CLI_MODE === 'true' && process.env.CODE_AGENT_WEB_MODE !== 'true') {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const cliDbMod = require('../../cli/database') as {
        getCLIDatabase?: () => { isInitialized: boolean } & CompactionAuditSink;
      };
      const cliDb = cliDbMod.getCLIDatabase?.();
      if (cliDb?.isInitialized) return cliDb;
    } catch {
      // CLI bundle 不可用时静默 no-op
    }
    return null;
  }

  const db = getDatabase();
  return db?.isReady ? (db as unknown as CompactionAuditSink) : null;
}

function countSharedManifestItems(manifest: CompactionSurvivorManifest | undefined, key: keyof CompactionSurvivorManifest): number {
  const value = manifest?.[key];
  return Array.isArray(value) ? value.length : 0;
}

function countPlanManifestItems(plan: CompactionAuditPlanLike, key: keyof CompactionAuditPlanLike['manifest']): number {
  const value = plan.manifest[key];
  return Array.isArray(value) ? value.length : 0;
}

function manifestItemCount(
  result: CompactionAuditResultLike,
  sharedKey: keyof CompactionSurvivorManifest,
  planKey: keyof CompactionAuditPlanLike['manifest'],
): number {
  return countSharedManifestItems(result.block?.survivorManifest, sharedKey) || countPlanManifestItems(result.plan, planKey);
}

function hasDataFingerprint(result: CompactionAuditResultLike): boolean {
  const manifest = result.block?.survivorManifest;
  return Boolean(
    manifest?.dataFingerprint ||
      result.plan.manifest.dataFingerprint ||
      result.plan.manifest.dataFingerprintText,
  );
}

function buildPreAuditSummary(plan: CompactionAuditPlanLike): unknown {
  return {
    type: 'compact_messages_with_summary_pre_audit',
    source: plan.source,
    anchorMessageId: plan.anchorMessageId ?? null,
    preserveRecentCount: plan.preserveRecentCount,
    messageCount: plan.messages.length,
    compactedMessageCount: plan.compactedMessages.length,
    preservedMessageCount: plan.preservedMessages.length,
    compactedMessageIds: plan.manifest.compactedMessageIds ?? plan.compactedMessages.map((message) => message.id).filter(Boolean),
    preservedMessageIds: plan.manifest.preservedMessageIds ?? plan.preservedMessages.map((message) => message.id).filter(Boolean),
    originalSummaryInputTokens: plan.originalTokens,
  };
}

export function buildCompactionAuditSummary(result: CompactionAuditResultLike): CompactionAuditSummary {
  const validation = result.validation;
  const summaryModel = result.summaryModel;
  const block = result.block;
  const plan = result.plan;
  const summaryContent = result.summaryMessage?.content ?? result.summary ?? '';

  return {
    type: 'compact_messages_with_summary_audit',
    success: result.success,
    reason: result.reason,
    summaryVersion: block?.summaryVersion ?? null,
    source: block?.source ?? plan.source,
    provider: summaryModel?.provider ?? block?.provider ?? null,
    model: summaryModel?.model ?? block?.model ?? null,
    modelConfig: {
      provider: plan.modelConfig?.provider ?? null,
      model: plan.modelConfig?.model ?? null,
    },
    summaryModel: {
      provider: summaryModel?.provider ?? null,
      model: summaryModel?.model ?? null,
      useMainModel: typeof summaryModel?.useMainModel === 'boolean' ? summaryModel.useMainModel : null,
      fallbackReason: summaryModel?.fallbackReason ?? null,
    },
    validation: {
      ok: typeof validation?.ok === 'boolean' ? validation.ok : null,
      missing: {
        paths: validation?.missingPaths ?? [],
        errors: validation?.missingErrors ?? [],
        openWork: validation?.missingOpenWork ?? [],
      },
      warnings: validation?.warnings ?? [],
    },
    warnings: result.warnings ?? block?.warnings ?? [],
    survivorManifestCounts: {
      compactedMessages: block?.survivorManifest?.compactedMessageIds?.length ?? plan.manifest.compactedMessageIds?.length ?? plan.compactedMessages.length,
      preservedMessages: block?.survivorManifest?.preservedMessageIds?.length ?? plan.manifest.preservedMessageIds?.length ?? plan.preservedMessages.length,
      files: manifestItemCount(result, 'files', 'files') || countPlanManifestItems(plan, 'filePaths'),
      commands: manifestItemCount(result, 'commands', 'commands'),
      errors: manifestItemCount(result, 'errors', 'errors'),
      openWork: manifestItemCount(result, 'openWork', 'openWork') || countPlanManifestItems(plan, 'todos'),
      artifacts: manifestItemCount(result, 'artifacts', 'artifacts'),
      hasDataFingerprint: hasDataFingerprint(result),
    },
    summary: {
      messageId: result.summaryMessage?.id ?? null,
      contentLength: typeof summaryContent === 'string' ? summaryContent.length : 0,
      timestamp: typeof result.summaryMessage?.timestamp === 'number' ? result.summaryMessage.timestamp : null,
    },
    anchorMessageId: block?.anchorMessageId ?? plan.anchorMessageId ?? null,
    preserveRecentCount: plan.preserveRecentCount,
    tokenDelta: {
      beforeTokens: result.beforeTokens,
      afterTokens: result.afterTokens,
      savedTokens: result.savedTokens,
      originalSummaryInputTokens: plan.originalTokens,
    },
  };
}

export function recordCompactionAuditSnapshot(input: CompactionAuditRecorderInput): void {
  try {
    const sink = getAuditSink();
    if (!sink) return;

    const { result } = input;
    sink.insertCompactionSnapshot({
      sessionId: result.plan.sessionId,
      strategy: result.plan.source,
      preMessageCount: result.plan.messages.length,
      postMessageCount: result.newMessages?.length ?? result.plan.preservedMessages.length,
      preTokens: result.beforeTokens,
      postTokens: result.afterTokens,
      savedTokens: result.savedTokens,
      usagePercent: input.usagePercent ?? null,
      preMessagesSummary: buildPreAuditSummary(result.plan),
      postMessagesSummary: buildCompactionAuditSummary(result),
      createdAt: input.createdAt,
      shapeHashBefore: computeRequestPrefixShapeHash({
        systemPrompt: result.plan.systemPrompt,
        messages: result.plan.messages,
      }),
      shapeHashAfter: computeRequestPrefixShapeHash({
        systemPrompt: result.plan.systemPrompt,
        messages: result.newMessages ?? result.plan.preservedMessages,
      }),
    });
  } catch (err) {
    logger.warn('[CompactionAuditRecorder] failed to write compaction audit snapshot', err);
  }
}
