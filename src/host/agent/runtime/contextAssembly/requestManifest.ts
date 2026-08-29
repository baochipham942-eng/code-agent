import type { ToolDefinition } from '../../../../shared/contract';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { ModelMessage } from '../../../agent/loopTypes';
import { aiSdkSupportsProvider } from '../../../model/adapters/aiSdkAdapter';
import { getAgentVersion } from '../../../telemetry/diagnosticVersions';
import type { TraceEventDataMap } from '../turnTrace';
import { emitToolSchemaSnapshot } from './inferenceArtifactRepair';
import { buildRequestManifest, canonicalizeModelMessage } from './requestManifestBuilder';
import type { ContextAssemblyCtx, ModelMessagesWithSources } from './shared';
import { logger } from './shared';

interface RecordRequestManifestInput {
  requestId: string;
  messages: ModelMessage[];
  assembledMessages: ModelMessagesWithSources;
  tools: ToolDefinition[];
  requestConfig: ModelConfig;
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
    const compressionSnapshot = ctx.runtime.contextHealth.compressionState.getSnapshot();
    manifest = buildRequestManifest({
      requestId: input.requestId,
      messages: input.messages,
      assembledCanonicalMessages: input.assembledMessages.map(canonicalizeModelMessage),
      sourceIds: input.assembledMessages.modelMessageSourceIds ?? [],
      transcriptMessages: ctx.runtime.messages,
      collapsedSpans: compressionSnapshot.collapsedSpans,
      compactionReplacements: compressionSnapshot.compactionReplacements,
      toolSchemaHash: toolSchemaSnapshot.schemaHash,
      toolNames: toolSchemaSnapshot.toolNames,
      requestConfig: input.requestConfig,
      appVersion,
      engine,
      systemPromptStore: ctx.runtime.systemPromptStore,
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
