import { createHash } from 'crypto';
import type { Message } from '../../../../shared/contract';
import type { ModelConfig } from '../../../../shared/contract/model';
import { resolveModelRequestTemperature } from '../../../../shared/modelSampling';
import type { ModelMessage } from '../../../agent/loopTypes';
import type { CollapsedSpan } from '../../../context/compressionState';
import { resolveModelMaxOutputTokens } from '../../../model/modelLimits';
import { getContentCache } from '../../../telemetry/contentCache';
import { getSystemPromptCache } from '../../../telemetry/systemPromptCache';
import type { RequestManifestMessageRef, TraceEventDataMap } from '../turnTrace';
import { projectLedgerMessage } from './ledgerMessageProjection';

type ContentStore = { store(hash: string, content: string): boolean };
type SystemPromptStore = { get(hash: string): { content: string } | null };

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
  systemPromptStore?: SystemPromptStore;
}

export function canonicalizeModelMessage(message: ModelMessage): string {
  return JSON.stringify(message);
}

function hashContent(content: string): string {
  return createHash('sha256').update(content).digest('hex');
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
      : { value: resolveModelMaxOutputTokens(config.model, config.provider), source: 'model_limit_registry' }
    : null;
  return { engine, temperature, maxTokens };
}

function ledgerIdForProjectionId(id: string, transcriptIds: Set<string>): string | null {
  if (transcriptIds.has(id)) return id;
  const separator = id.indexOf('::tool-result::');
  if (separator > 0) {
    const originId = id.slice(0, separator);
    if (transcriptIds.has(originId)) return originId;
  }
  return null;
}

export function buildRequestManifest(
  input: RequestManifestBuildInput,
): TraceEventDataMap['request_manifest'] {
  const contentStore = input.contentStore ?? getContentCache();
  const systemPromptStore = input.systemPromptStore ?? getSystemPromptCache();
  const transcriptById = new Map(input.transcriptMessages.map((message) => [message.id, message]));
  const ledgerProjectionOffsets = new Map<string, number>();
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
    if (sourceId === '__system_prompt__' && unchangedSinceAssembly && message.role === 'system' && typeof message.content === 'string') {
      const contentHash = hashContent(message.content);
      if (systemPromptStore.get(contentHash)?.content === message.content) {
        return { kind: 'system_prompt', contentHash };
      }
      return { kind: 'content', contentHash: storeCanonical(canonical), reason: 'system_prompt_fallback' };
    }
    const transcriptMessage = sourceId ? transcriptById.get(sourceId) : undefined;
    if (unchangedSinceAssembly && transcriptMessage) {
      const offset = ledgerProjectionOffsets.get(sourceId) ?? 0;
      const candidate = projectLedgerMessage(transcriptMessage)[offset];
      if (candidate && canonicalizeModelMessage(candidate) === canonical) {
        ledgerProjectionOffsets.set(sourceId, offset + 1);
        return { kind: 'ledger_message', messageId: sourceId };
      }
    }
    const reason = sourceId === '__dynamic_tail__'
      ? 'dynamic_tail'
      : sourceId && !transcriptMessage ? 'runtime_injection' : 'post_assembly_rewrite';
    return { kind: 'content', contentHash: storeCanonical(canonical), reason };
  });
  const transcriptIds = new Set(input.transcriptMessages.map((message) => message.id));
  const compactionReplacements = input.collapsedSpans.flatMap((span) => {
    const replacedMessageIds = Array.from(new Set(span.messageIds
      .map((id) => ledgerIdForProjectionId(id, transcriptIds))
      .filter((id): id is string => Boolean(id))));
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
