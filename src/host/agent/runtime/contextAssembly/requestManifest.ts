import { createHash } from 'crypto';
import type { Message, ToolDefinition } from '../../../../shared/contract';
import type { ModelConfig } from '../../../../shared/contract/model';
import { resolveModelRequestTemperature } from '../../../../shared/modelSampling';
import type { ModelMessage } from '../../../agent/loopTypes';
import type { CollapsedSpan } from '../../../context/compressionState';
import { resolveModelMaxOutputTokens } from '../../../model/modelLimits';
import { aiSdkSupportsProvider } from '../../../model/adapters/aiSdkAdapter';
import { getContentCache } from '../../../telemetry/contentCache';
import { getAgentVersion } from '../../../telemetry/diagnosticVersions';
import type {
  RequestManifestMessageRef,
  TraceEventDataMap,
} from '../turnTrace';
import type { ContextAssemblyCtx, ModelMessagesWithSources } from './shared';
import { logger } from './shared';
import { emitToolSchemaSnapshot } from './inferenceArtifactRepair';

type ContentStore = { store(hash: string, content: string): boolean };

export interface RequestManifestBuildInput {
  requestId: string;
  messages: ModelMessage[];
  assembledCanonicalMessages: readonly string[];
  sourceIds: readonly string[];
  transcriptMessages: readonly Message[];
  collapsedSpans: readonly CollapsedSpan[];
  toolSchemaHash: string;
  toolNames: string[];
  requestConfig: ModelConfig;
  appVersion: string;
  engine: 'aisdk' | 'legacy';
  contentStore?: ContentStore;
}

export interface RecordRequestManifestInput {
  requestId: string;
  messages: ModelMessage[];
  assembledMessages: ModelMessagesWithSources;
  tools: ToolDefinition[];
  requestConfig: ModelConfig;
}

export function canonicalizeModelMessage(message: ModelMessage): string {
  return JSON.stringify(message);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

function matchesLedgerMessage(message: ModelMessage, source: Message): boolean {
  if (message.role !== source.role || source.attachments?.length) return false;

  if (message.role === 'tool') {
    return source.toolResults?.some((result) =>
      (result.output || result.error || '') === message.content
      && result.toolCallId === message.toolCallId
      && !result.success === Boolean(message.toolError)) === true;
  }

  if (message.content !== source.content) return false;
  if (!sameJson(message.thinking, source.thinking)) return false;
  if (!sameJson(message.responsesOutput, source.responsesOutput)) return false;

  if (source.toolCalls?.length || message.toolCalls?.length) {
    if (source.toolCalls?.length !== message.toolCalls?.length) return false;
    return source.toolCalls?.every((call, index) => {
      const projected = message.toolCalls?.[index];
      return projected?.id === call.id
        && projected.name === call.name
        && projected.arguments === JSON.stringify(call.arguments);
    }) === true;
  }
  return true;
}

function resolveAdapterDefaults(
  config: ModelConfig,
  engine: 'aisdk' | 'legacy',
): TraceEventDataMap['request_manifest']['adapterDefaults'] {
  const constrainedTemperature = resolveModelRequestTemperature(config.model, config.temperature);
  let temperature: { value: number | null; source: string } | null = null;
  if (config.temperature == null) {
    if (constrainedTemperature != null) {
      temperature = { value: constrainedTemperature, source: 'model_temperature_constraint' };
    } else if (engine === 'aisdk') {
      temperature = config.provider === 'moonshot' || config.provider === 'xiaomi'
        ? { value: 1, source: 'ai_sdk_vendor_compat' }
        : { value: null, source: 'provider_sdk_default' };
    } else if (config.provider === 'claude') {
      temperature = { value: null, source: 'claude_provider_default' };
    } else {
      temperature = {
        value: config.provider === 'moonshot' || config.provider === 'xiaomi' ? 1 : 0.7,
        source: 'legacy_provider_adapter',
      };
    }
  }

  const maxTokens = config.maxTokens == null
    ? engine === 'aisdk'
      ? { value: null, source: 'provider_sdk_default' }
      : {
          value: resolveModelMaxOutputTokens(config.model, config.provider),
          source: 'model_limit_registry',
        }
    : null;

  return { engine, temperature, maxTokens };
}

function ledgerIdForProjectionId(id: string, transcriptIds: Set<string>): string | null {
  if (transcriptIds.has(id)) return id;
  const toolResultSeparator = id.indexOf('::tool-result::');
  if (toolResultSeparator > 0) {
    const originId = id.slice(0, toolResultSeparator);
    if (transcriptIds.has(originId)) return originId;
  }
  return null;
}

export function buildRequestManifest(
  input: RequestManifestBuildInput,
): TraceEventDataMap['request_manifest'] {
  const contentStore = input.contentStore ?? getContentCache();
  const transcriptById = new Map(input.transcriptMessages.map((message) => [message.id, message]));
  let degraded = false;

  const storeCanonical = (canonical: string): string => {
    const contentHash = hashContent(canonical);
    if (!contentStore.store(contentHash, canonical)) degraded = true;
    return contentHash;
  };

  const messageRefs: RequestManifestMessageRef[] = input.messages.map((message, index) => {
    const canonical = canonicalizeModelMessage(message);
    const sourceId = input.sourceIds[index];
    const unchangedSinceAssembly = input.assembledCanonicalMessages[index] === canonical;

    if (
      sourceId === '__system_prompt__'
      && unchangedSinceAssembly
      && message.role === 'system'
      && typeof message.content === 'string'
    ) {
      return { kind: 'system_prompt', contentHash: hashContent(message.content) };
    }

    const transcriptMessage = sourceId ? transcriptById.get(sourceId) : undefined;
    if (unchangedSinceAssembly && transcriptMessage && matchesLedgerMessage(message, transcriptMessage)) {
      return { kind: 'ledger_message', messageId: sourceId };
    }

    const reason = sourceId === '__dynamic_tail__'
      ? 'dynamic_tail'
      : sourceId && !transcriptMessage
        ? 'runtime_injection'
        : 'post_assembly_rewrite';
    return { kind: 'content', contentHash: storeCanonical(canonical), reason };
  });

  const transcriptIds = new Set(input.transcriptMessages.map((message) => message.id));
  const compactionReplacements = input.collapsedSpans.flatMap((span) => {
    const replacedMessageIds = Array.from(new Set(
      span.messageIds
        .map((id) => ledgerIdForProjectionId(id, transcriptIds))
        .filter((id): id is string => Boolean(id)),
    ));
    if (replacedMessageIds.length === 0) return [];

    const replacementIndex = input.sourceIds.findIndex((sourceId) => sourceId === replacedMessageIds[0]);
    if (replacementIndex < 0) return [];
    const replacementRef = messageRefs[replacementIndex];
    const replacementContentHash = replacementRef.kind === 'content'
      ? replacementRef.contentHash
      : storeCanonical(canonicalizeModelMessage(input.messages[replacementIndex]));
    return [{ replacedMessageIds, replacementContentHash }];
  });

  return {
    requestId: input.requestId,
    messageRefs,
    toolSchemaHash: input.toolSchemaHash,
    toolNames: [...input.toolNames],
    requested: {
      provider: input.requestConfig.provider,
      model: input.requestConfig.model,
      temperature: input.requestConfig.temperature ?? null,
      maxTokens: input.requestConfig.maxTokens ?? null,
      reasoningEffort: input.requestConfig.reasoningEffort ?? null,
      thinkingBudget: input.requestConfig.thinkingBudget ?? null,
    },
    actualProvider: null,
    actualModel: null,
    appVersion: input.appVersion,
    adapterDefaults: resolveAdapterDefaults(input.requestConfig, input.engine),
    compactionReplacements,
    degraded,
  };
}

export function recordRequestManifest(
  ctx: ContextAssemblyCtx,
  input: RecordRequestManifestInput,
): TraceEventDataMap['request_manifest'] {
  const toolSchemaSnapshot = emitToolSchemaSnapshot(ctx, input.tools);
  const engine = process.env.CODE_AGENT_MODEL_ENGINE !== 'legacy'
    && aiSdkSupportsProvider(input.requestConfig.provider, input.requestConfig.model)
    ? 'aisdk'
    : 'legacy';
  const appVersion = getAgentVersion();
  let manifest: TraceEventDataMap['request_manifest'];
  try {
    manifest = buildRequestManifest({
      requestId: input.requestId,
      messages: input.messages,
      assembledCanonicalMessages: input.assembledMessages.map(canonicalizeModelMessage),
      sourceIds: input.assembledMessages.modelMessageSourceIds ?? [],
      transcriptMessages: ctx.runtime.messages,
      collapsedSpans: ctx.runtime.contextHealth.compressionState.getSnapshot().collapsedSpans,
      toolSchemaHash: toolSchemaSnapshot.schemaHash,
      toolNames: toolSchemaSnapshot.toolNames,
      requestConfig: input.requestConfig,
      appVersion,
      engine,
    });
  } catch (error) {
    logger.warn('[Replay] request manifest assembly degraded; inference will continue', error);
    manifest = {
      requestId: input.requestId,
      messageRefs: [],
      toolSchemaHash: toolSchemaSnapshot.schemaHash,
      toolNames: toolSchemaSnapshot.toolNames,
      requested: {
        provider: input.requestConfig.provider,
        model: input.requestConfig.model,
        temperature: input.requestConfig.temperature ?? null,
        maxTokens: input.requestConfig.maxTokens ?? null,
        reasoningEffort: input.requestConfig.reasoningEffort ?? null,
        thinkingBudget: input.requestConfig.thinkingBudget ?? null,
      },
      actualProvider: null,
      actualModel: null,
      appVersion,
      adapterDefaults: { engine, temperature: null, maxTokens: null },
      compactionReplacements: [],
      degraded: true,
    };
  }
  if (toolSchemaSnapshot.cacheStored === false) manifest.degraded = true;
  ctx.runtime.turnTrace?.record('request_manifest', manifest);
  return manifest;
}

export function completeRequestManifest(
  manifest: TraceEventDataMap['request_manifest'] | null,
  response: { actualProvider?: string; actualModel?: string; fallback?: { to: { provider?: string; model?: string } } },
  requestedConfig: ModelConfig,
): void {
  if (!manifest) return;
  manifest.actualProvider = response.actualProvider ?? response.fallback?.to.provider ?? requestedConfig.provider;
  manifest.actualModel = response.actualModel ?? response.fallback?.to.model ?? requestedConfig.model;
}

export async function withActualModelIdentity<
  T extends { actualProvider?: string; actualModel?: string },
>(responsePromise: Promise<T>, config: ModelConfig): Promise<T> {
  const response = await responsePromise;
  response.actualProvider ??= config.provider;
  response.actualModel ??= config.model;
  return response;
}
