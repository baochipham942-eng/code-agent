import type { ToolDefinition } from '../../../../shared/contract';
import type { ModelConfig } from '../../../../shared/contract/model';
import type { ModelMessage } from '../../../agent/loopTypes';
import { aiSdkSupportsProvider } from '../../../model/adapters/aiSdkAdapter';
import { getAgentVersion } from '../../../telemetry/diagnosticVersions';
import type { TraceEventDataMap } from '../turnTrace';
import type { InferenceRetryInfo } from '../../../model/types';
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

/**
 * issue #1989：推理重试/断流续接的会话 trace 回调工厂。
 * 挂起-超时-重试此前只落 stderr，trace 止于 request_manifest；
 * 接上后每次重试（含 kind=timeout/transient/reconnect）都进 inference_retry 事件。
 */
export function recordInferenceRetryTrace(
  ctx: ContextAssemblyCtx,
  requestId: string,
): (info: InferenceRetryInfo) => void {
  return (info) => {
    ctx.runtime.turnTrace?.record('inference_retry', { requestId, ...info });
  };
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
