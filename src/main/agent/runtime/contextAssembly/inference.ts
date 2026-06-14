 
// ContextAssembly - Inference orchestration and model fallback.
import type { AgentEvent, ToolCall, ToolDefinition } from '../../../../shared/contract';
import type { ModelResponse } from '../../../agent/loopTypes';
import { inferenceViaAiSdk, aiSdkSupportsProvider } from '../../../model/adapters/aiSdkAdapter';
import { getConfigService, getLangfuseService, getBudgetService, BudgetAlertLevel } from '../../../services';
import { logCollector } from '../../../mcp/logCollector.js';
import { ContextLengthExceededError } from '../../../model/modelRouter';
import { getModelMaxOutputTokens } from '../../../../shared/constants';
import { createSnapshotHandler } from '../../../session/streamSnapshot';
import {
  getCoreToolDefinitions,
  getLoadedDeferredToolDefinitions,
  getAllToolDefinitions,
} from '../../../tools/dispatch/toolDefinitions';
import { filterToolDefinitionsByWorkbenchScope } from '../../../tools/workbenchToolScope';
import { filterToolDefinitionsByStrictSkillBoundary } from '../../../tools/skillBoundaryScope';
import { filterToolsByRunPolicy } from '../toolRunPolicy';
import {
  stripImagesFromMessages,
  extractUserRequestText,
} from '../../../agent/messageHandling/converter';
import { needsArtifactTaskBrief } from '../../../prompts/builder';
import {
  estimateModelMessageTokens,
  estimateTokens,
} from '../../../context/tokenOptimizer';
import type { ModelMessage } from '../../../agent/loopTypes';
import type { StreamCallback, InferenceOptions, ModelResponse as RouterModelResponse } from '../../../model/types';
import type { ModelConfig, ModelProvider } from '../../../../shared/contract/model';
import type { ModelDecisionEventData, ModelFallbackInfo, ModelFallbackTraceStep, ModelProviderHealthSnapshot, ModelToolStrategyDiagnostics, ModelToolTokenSavingsProviderReport, ModelToolTokenSavingsProviderUsage } from '../../../../shared/contract/modelDecision';
import type { TaskModelStrategySettings } from '../../../../shared/contract/settings';
import { getAdaptiveRouter } from '../../../model/adaptiveRouter';
import { buildModelProviderIdentity, resolveModelDecision, resolveProviderBillingMode, type BillingMode, type ModelDecisionProviderSettings } from '../../../model/modelDecision';
import { classifyProviderFallbackReason, formatFallbackReason, getFallbackChainForRequest } from '../../../model/modelRouterPolicy';
import { getProviderHealthMonitor } from '../../../model/providerHealthMonitor';
import { isFallbackEligible } from '../../../model/providers/retryStrategy';
import { buildE2ELocalAgentModelResponse, shouldUseE2ELocalAgentModelForMessages } from '../../../model/e2eLocalAgentModel';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';
import {
  getArtifactRepairToolPolicy,
  isArtifactRepairWritePriority as isArtifactRepairWritePriorityForGuard,
  seedArtifactRepairGuardFromContext,
} from '../artifactRepairGuard';
import { preloadDeferredToolsForTurn } from './deferredToolPreload';
import { runMaxModeStep, MaxModeAbortError } from '../maxMode';
import { createHandoffTailStreamFilter } from '../../../handoff/handoffStream';
import { applyEffortControls } from './effortControls';
import { buildCompactArtifactRepairWriteRetryMessages } from './artifactRepairRetryMessages';
import {
  contentHasImageParts,
  preflightImagesForMainModel,
} from './visionPreflight';

const ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS = 16_384;
const ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS = 32_768;
const ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS = 8_192;
const ARTIFACT_REPAIR_WRITE_MAX_TOKENS = 65_536;
const ARTIFACT_MODEL_WAIT_HEARTBEAT_MS = 15_000;

// 主 loop 推理引擎选择（flag-gated）。与子代理共用 CODE_AGENT_MODEL_ENGINE，统一所有主 loop
// 调用点的引擎选择，避免内联复制。【默认走 AI SDK 适配器，CODE_AGENT_MODEL_ENGINE=legacy
// 一键回退旧 modelRouter】——与子代理那侧 (!== 'legacy') 对齐。主 loop 是 HOT 路径 + 用户可见
// 聊天，曾保持 opt-in 直到 E2E 证明（webServer 跑通 longcat 文本+工具多轮 / 纯文本 / deepseek
// 工具，流式逐字 + reasoning + tool_call + usage 全保留，对照 legacy 零回归后才翻默认）。
// gemini 等适配器不兼容的 provider 即便默认 aisdk 也自动留旧路径（aiSdkSupportsProvider），
// 不引入回归。
function runEngineInference(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
): Promise<RouterModelResponse> {
  const adaptedConfig = resolveMainChatModelDecision(ctx, messages, config, {
    suppressDecisionEvent: options?.suppressModelDecisionEvent === true,
  });
  const effectiveConfig = adaptedConfig ?? config;

  if (shouldUseE2ELocalAgentModelForMessages(messages)) {
    return Promise.resolve(buildE2ELocalAgentModelResponse(messages, tools, effectiveConfig, onStream));
  }

  const useAiSdk = process.env.CODE_AGENT_MODEL_ENGINE !== 'legacy'
    && aiSdkSupportsProvider(effectiveConfig.provider);
  if (useAiSdk) {
    if (adaptedConfig) {
      logger.info(`[AgentLoop] inference engine = aisdk (adaptive: ${config.provider}/${config.model} → ${adaptedConfig.provider}/${adaptedConfig.model})`);
      return inferenceViaAiSdk(messages, tools, adaptedConfig, onStream, signal, options).catch((err: unknown) => {
        const errMsg = getErrorMessage(err);
        // 401/403 是持久性错误（key 过期/无效），禁用 free model 避免重复失败
        if (/401|403|unauthorized|forbidden/i.test(errMsg)) {
          getAdaptiveRouter().disableFreeModel(errMsg.split('\n')[0]);
        } else {
          logger.warn(`[AdaptiveRouter] Free model failed on aisdk path, falling back to default: ${errMsg.split('\n')[0]}`);
        }
        return inferenceViaAiSdk(messages, tools, config, onStream, signal, options)
          .then((response) => {
            response.actualProvider = config.provider;
            response.actualModel = config.model;
            response.fallback = buildAiSdkAdaptiveFallbackInfo(adaptedConfig, config, err, 'selected');
            return response;
          })
          .catch((fallbackErr: unknown) => {
            if (fallbackErr instanceof Error) {
              (fallbackErr as Error & { modelFallback?: ModelFallbackInfo }).modelFallback =
                buildAiSdkAdaptiveFallbackInfo(adaptedConfig, config, err, 'exhausted', fallbackErr);
            }
            throw fallbackErr;
          });
      });
    }
    logger.debug('[AgentLoop] inference engine = aisdk', { provider: effectiveConfig.provider, model: effectiveConfig.model, streaming: typeof onStream === 'function' && options?.forceNonStreaming !== true });
    return runAiSdkInferenceWithProviderFallback(messages, tools, effectiveConfig, onStream, signal, options);
  }
  return ctx.runtime.modelRouter.inference(messages, tools, effectiveConfig, onStream, signal, options);
}

function formatFallbackEndpoint(target: { provider: string; model?: string }): string {
  return target.model ? `${target.provider}/${target.model}` : target.provider;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

function getModelFallbackFromError(error: unknown): ModelFallbackInfo | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const fallback = (error as { modelFallback?: unknown }).modelFallback;
  if (!fallback || typeof fallback !== 'object') return undefined;
  const candidate = fallback as Partial<ModelFallbackInfo>;
  if (
    candidate.from
    && typeof candidate.from.provider === 'string'
    && candidate.to
    && typeof candidate.to.provider === 'string'
    && typeof candidate.reason === 'string'
    && typeof candidate.category === 'string'
  ) {
    return candidate as ModelFallbackInfo;
  }
  return undefined;
}

function getFallbackProviderIdentity(provider: string): ModelDecisionEventData['providerIdentity'] {
  try {
    return buildModelProviderIdentity(provider, getConfigService().getSettings().models?.providers);
  } catch {
    return undefined;
  }
}

export function buildAiSdkAdaptiveFallbackInfo(
  fromConfig: ModelConfig,
  toConfig: ModelConfig,
  error: unknown,
  outcome: 'selected' | 'exhausted',
  finalError?: unknown,
): ModelFallbackInfo {
  const adaptiveMessage = getErrorMessage(error);
  const adaptiveCategory = classifyProviderFallbackReason(adaptiveMessage, getErrorCode(error));
  const adaptiveReason = formatFallbackReason(adaptiveMessage);
  const finalMessage = finalError ? getErrorMessage(finalError) : adaptiveMessage;
  const finalCategory = finalError ? classifyProviderFallbackReason(finalMessage, getErrorCode(finalError)) : adaptiveCategory;
  const finalReason = formatFallbackReason(finalMessage);
  const topCategory = outcome === 'selected' ? adaptiveCategory : finalCategory;
  const topReason = outcome === 'selected' ? adaptiveReason : finalReason;
	  return {
	    from: { provider: fromConfig.provider, model: fromConfig.model },
	    to: { provider: toConfig.provider, model: toConfig.model },
	    ...(getFallbackProviderIdentity(fromConfig.provider) ? { fromIdentity: getFallbackProviderIdentity(fromConfig.provider) } : {}),
	    ...(getFallbackProviderIdentity(toConfig.provider) ? { toIdentity: getFallbackProviderIdentity(toConfig.provider) } : {}),
	    reason: topReason,
    category: topCategory,
    strategy: 'adaptive-main-task-recovery',
    tried: [
      {
        provider: fromConfig.provider,
        model: fromConfig.model,
        status: 'tried',
        reason: 'adaptive_candidate_failed',
        category: adaptiveCategory,
        detail: adaptiveReason,
      },
      {
        provider: toConfig.provider,
        model: toConfig.model,
        status: outcome === 'selected' ? 'selected' : 'exhausted',
        reason: outcome === 'selected' ? 'main_task_model_selected' : 'main_task_model_failed',
        category: topCategory,
        detail: outcome === 'selected'
          ? '回到主任务模型继续本轮任务'
          : finalReason,
      },
    ],
  };
}

function fallbackTraceStep(
  provider: string,
  model: string | undefined,
  status: ModelFallbackTraceStep['status'],
  reason: string,
  category?: string,
  detail?: string,
): ModelFallbackTraceStep {
	return {
	  provider,
	  ...(model ? { model } : {}),
	  ...(getFallbackProviderIdentity(provider) ? { providerIdentity: getFallbackProviderIdentity(provider) } : {}),
	  status,
    reason,
    ...(category ? { category } : {}),
    ...(detail ? { detail: formatFallbackReason(detail) } : {}),
  };
}

function getProviderSettingsForFallback(provider: ModelProvider): { baseUrl?: string; protocol?: ModelConfig['protocol'] } | undefined {
  try {
    return getConfigService().getSettings().models?.providers?.[provider];
  } catch {
    return undefined;
  }
}

function attachModelFallbackToError(error: unknown, fallback: ModelFallbackInfo): never {
  if (error instanceof Error) {
    (error as Error & { modelFallback?: ModelFallbackInfo }).modelFallback = fallback;
    throw error;
  }
  const wrapped = new Error(String(error));
  (wrapped as Error & { modelFallback?: ModelFallbackInfo }).modelFallback = fallback;
  throw wrapped;
}

async function broadcastAiSdkProviderFallback(fallback: ModelFallbackInfo): Promise<void> {
  try {
    const { broadcastToRenderer } = await import('../../../platform/windowBridge');
    broadcastToRenderer?.('provider:fallback', {
      from: fallback.from,
      to: fallback.to,
      reason: fallback.reason,
      category: fallback.category,
      tried: fallback.tried,
      skipped: fallback.skipped,
    });
  } catch {
    /* renderer broadcast is best-effort; response.fallback still drives the chat notice */
  }
}

export async function runAiSdkInferenceWithProviderFallback(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal,
  options?: InferenceOptions,
): Promise<RouterModelResponse> {
  try {
    return await inferenceViaAiSdk(messages, tools, config, onStream, signal, options);
  } catch (primaryErr) {
    if (signal?.aborted || config.adaptive !== true) {
      throw primaryErr;
    }

    const errMsg = getErrorMessage(primaryErr);
    const errCode = getErrorCode(primaryErr);
    if (!isFallbackEligible(errMsg, errCode)) {
      throw primaryErr;
    }

    const chain = getFallbackChainForRequest(messages, config.provider);
    if (!chain || chain.length === 0) {
      throw primaryErr;
    }

    const fallbackCategory = classifyProviderFallbackReason(errMsg, errCode);
    const fallbackReason = formatFallbackReason(errMsg);
    const fallbackTried: ModelFallbackTraceStep[] = [
      fallbackTraceStep(
        config.provider,
        config.model,
        'tried',
        'primary_failed',
        fallbackCategory,
        fallbackReason,
      ),
    ];
    const fallbackSkipped: ModelFallbackTraceStep[] = [];

    logger.warn(`[AgentLoop] AI SDK provider fallback triggered (${fallbackCategory}): ${config.provider}/${config.model} ${fallbackReason}`);

    for (const fallback of chain) {
      if (signal?.aborted) {
        throw new Error('Request was cancelled during AI SDK provider fallback', { cause: primaryErr });
      }

      const fallbackProvider = fallback.provider as ModelProvider;
      if (!aiSdkSupportsProvider(fallback.provider)) {
        fallbackSkipped.push(fallbackTraceStep(
          fallback.provider,
          fallback.model,
          'skipped',
          'unsupported_ai_sdk_provider',
          fallbackCategory,
          `${fallback.provider} is not available on the AI SDK path`,
        ));
        continue;
      }

      const fallbackHealth = getProviderHealthMonitor().getHealth(fallback.provider);
      if (fallbackHealth?.status === 'unavailable') {
        fallbackSkipped.push(fallbackTraceStep(
          fallback.provider,
          fallback.model,
          'skipped',
          'provider_unavailable',
          fallbackCategory,
          `${fallback.provider} is marked unavailable by provider health monitor`,
        ));
        continue;
      }

      const fallbackApiKey = getConfigService().getApiKey(fallbackProvider);
      if (!fallbackApiKey) {
        fallbackSkipped.push(fallbackTraceStep(
          fallback.provider,
          fallback.model,
          'skipped',
          'missing_api_key',
          fallbackCategory,
          `${fallback.provider} API key is not configured`,
        ));
        continue;
      }

      const fallbackSettings = getProviderSettingsForFallback(fallbackProvider);
      const fallbackConfig: ModelConfig = {
        ...config,
        provider: fallbackProvider,
        model: fallback.model,
        apiKey: fallbackApiKey,
        baseUrl: fallbackSettings?.baseUrl,
        protocol: fallbackSettings?.protocol,
        maxTokens: getModelMaxOutputTokens(fallback.model),
      };

      try {
        logger.warn(`[AgentLoop] AI SDK fallback -> ${fallback.provider}/${fallback.model} (reason=${fallbackCategory})`);
        const result = await inferenceViaAiSdk(messages, tools, fallbackConfig, onStream, signal, options);
        const selectedStep = fallbackTraceStep(
          fallback.provider,
          fallback.model,
          'selected',
          'fallback_selected',
          fallbackCategory,
          fallbackReason,
        );
	        const fallbackMetadata: ModelFallbackInfo = {
	          from: { provider: config.provider, model: config.model },
	          to: { provider: fallback.provider, model: fallback.model },
	          ...(getFallbackProviderIdentity(config.provider) ? { fromIdentity: getFallbackProviderIdentity(config.provider) } : {}),
	          ...(getFallbackProviderIdentity(fallback.provider) ? { toIdentity: getFallbackProviderIdentity(fallback.provider) } : {}),
	          reason: fallbackReason,
          category: fallbackCategory,
          strategy: 'adaptive-provider-fallback',
          tried: [...fallbackTried, selectedStep],
          ...(fallbackSkipped.length > 0 ? { skipped: [...fallbackSkipped] } : {}),
        };
        result.actualProvider = fallback.provider;
        result.actualModel = fallback.model;
        result.fallback = fallbackMetadata;
        void broadcastAiSdkProviderFallback(fallbackMetadata);
        return result;
      } catch (fallbackErr) {
        if (signal?.aborted) {
          throw fallbackErr;
        }
        const fallbackMsg = getErrorMessage(fallbackErr);
        fallbackTried.push(fallbackTraceStep(
          fallback.provider,
          fallback.model,
          'tried',
          'fallback_failed',
          classifyProviderFallbackReason(fallbackMsg, getErrorCode(fallbackErr)),
          fallbackMsg,
        ));
        logger.warn(`[AgentLoop] AI SDK fallback ${fallback.provider}/${fallback.model} failed: ${fallbackMsg.split('\n')[0]}`);
      }
    }

    const exhaustedStep = fallbackTraceStep(
      config.provider,
      config.model,
      'exhausted',
      'fallback_chain_exhausted',
      fallbackCategory,
      'All configured AI SDK fallback providers failed or were skipped',
    );
	    const exhaustedFallback: ModelFallbackInfo = {
	      from: { provider: config.provider, model: config.model },
	      to: { provider: config.provider, model: config.model },
	      ...(getFallbackProviderIdentity(config.provider) ? { fromIdentity: getFallbackProviderIdentity(config.provider) } : {}),
	      reason: fallbackReason,
      category: fallbackCategory,
      strategy: 'adaptive-provider-fallback',
      tried: [...fallbackTried, exhaustedStep],
      ...(fallbackSkipped.length > 0 ? { skipped: [...fallbackSkipped] } : {}),
    };
    attachModelFallbackToError(primaryErr, exhaustedFallback);
  }
}

function emitModelFallbackNoticeFromResponse(
  ctx: ContextAssemblyCtx,
  fallback: ModelFallbackInfo | undefined,
): void {
  if (!fallback) return;
  const exhausted = fallback.tried?.some((step) => step.status === 'exhausted') === true;
  let fromIdentity: ModelDecisionEventData['providerIdentity'];
  let toIdentity: ModelDecisionEventData['providerIdentity'];
  try {
    const providerSettings = getConfigService().getSettings().models?.providers;
    fromIdentity = buildModelProviderIdentity(fallback.from.provider, providerSettings);
    toIdentity = buildModelProviderIdentity(fallback.to.provider, providerSettings);
  } catch {
    fromIdentity = undefined;
    toIdentity = undefined;
  }
  ctx.runtime.onEvent({
    type: 'model_fallback',
	      data: {
	        reason: fallback.reason,
	        category: fallback.category,
	        ...(fallback.strategy ? { strategy: fallback.strategy } : {}),
	        from: formatFallbackEndpoint(fallback.from),
	        to: exhausted ? '未切换' : formatFallbackEndpoint(fallback.to),
	        ...(fallback.fromIdentity ? { fromIdentity: fallback.fromIdentity } : {}),
	        ...(!exhausted && fallback.toIdentity ? { toIdentity: fallback.toIdentity } : {}),
	        ...(fallback.tried ? { tried: fallback.tried } : {}),
      ...(fallback.skipped ? { skipped: fallback.skipped } : {}),
      ...(fallback.toolPolicy ? { toolPolicy: fallback.toolPolicy } : {}),
      ...(fromIdentity ? { fromIdentity } : {}),
      ...(!exhausted && toIdentity ? { toIdentity } : {}),
      turnId: ctx.runtime.currentTurnId,
    },
  });
}

function extractMcpServerId(tool: ToolDefinition): string | undefined {
  if (tool.mcpServer) return tool.mcpServer;
  const doubleUnderscore = /^mcp__(.+?)__/.exec(tool.name)?.[1];
  if (doubleUnderscore) return doubleUnderscore;
  return /^mcp_([^_]+)_/.exec(tool.name)?.[1];
}

function buildProviderUsageSnapshot(usage: ModelResponse['usage'] | undefined): ModelToolTokenSavingsProviderUsage | undefined {
  if (!usage) return undefined;
  if (!Number.isFinite(usage.inputTokens) || !Number.isFinite(usage.outputTokens)) return undefined;
  const inputTokens = Math.max(0, Math.trunc(usage.inputTokens));
  const outputTokens = Math.max(0, Math.trunc(usage.outputTokens));
  return {
    source: 'model-response-usage',
    inputTokens,
    outputTokens,
    totalTokens: inputTokens + outputTokens,
  };
}

function buildProviderReportedSavingsSnapshot(usage: ModelResponse['usage'] | undefined): ModelToolTokenSavingsProviderReport | undefined {
  const savedTokens = usage?.providerReportedSavedTokens;
  if (typeof savedTokens !== 'number' || !Number.isFinite(savedTokens) || savedTokens < 0) return undefined;
  return {
    source: 'provider-reported',
    savedTokens: Math.trunc(savedTokens),
  };
}

function formatProviderUsageDetail(providerUsage: ModelToolTokenSavingsProviderUsage | undefined): string {
  if (!providerUsage) return '真实账单以 provider usage 为准。';
  return `本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens；真实账单以 provider usage 为准。`;
}

function formatProviderReportedSavingsDetail(
  providerReport: ModelToolTokenSavingsProviderReport,
  providerUsage: ModelToolTokenSavingsProviderUsage | undefined,
): string {
  const usageDetail = providerUsage
    ? `本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens。`
    : '本轮 provider usage 未回传。';
  return `provider 已回传 programmatic tool saved tokens：${providerReport.savedTokens} tokens；${usageDetail}`;
}

function buildRuntimeProviderHealthSnapshot(provider: string): ModelProviderHealthSnapshot {
  const health = getProviderHealthMonitor().getHealth(provider);
  const sampledAt = Date.now();
  if (!health) {
    return {
      provider,
      status: 'unknown',
      sampledAt,
    };
  }
  return {
    provider: health.provider,
    status: health.status,
    sampledAt,
    latencyP50: health.latencyP50,
    latencyP95: health.latencyP95,
    errorRate: health.errorRate,
    lastSuccessAt: health.lastSuccessAt,
    lastErrorAt: health.lastErrorAt,
    consecutiveErrors: health.consecutiveErrors,
  };
}

function applyFallbackResultToModelDecision(
  decision: ModelDecisionEventData,
  response: ModelResponse,
): ModelDecisionEventData {
  const fallback = response.fallback;
  const finalProvider = response.actualProvider ?? fallback?.to.provider;
  const finalModel = response.actualModel ?? fallback?.to.model;
  if (!fallback || !finalProvider || !finalModel) return decision;
  const from = formatFallbackEndpoint(fallback.from);
  const to = formatFallbackEndpoint({ provider: finalProvider, model: finalModel });
  const isCapabilityFallback = fallback.category === 'capability';
  const capability = fallback.reason;
  let providerIdentity: ModelDecisionEventData['providerIdentity'];
  try {
    providerIdentity = buildModelProviderIdentity(finalProvider, getConfigService().getSettings().models?.providers);
  } catch {
    providerIdentity = undefined;
  }
  const { providerIdentity: _previousProviderIdentity, ...decisionWithoutProviderIdentity } = decision;
  return {
    ...decisionWithoutProviderIdentity,
    ...(isCapabilityFallback
      ? {
          requestedProvider: fallback.from.provider,
          ...(fallback.from.model ? { requestedModel: fallback.from.model } : {}),
        }
      : {}),
    resolvedProvider: finalProvider,
    resolvedModel: finalModel,
    reason: isCapabilityFallback && capability === 'vision' ? 'capability-vision' : 'fallback-availability',
    fallbackFrom: from,
    strategySummary: isCapabilityFallback
      ? `原模型 ${from} 缺少 ${capability} 能力，切到 ${to} 完成当前任务。`
      : `原模型 ${from} 不可用，切到 ${to} 完成当前任务。`,
    speedPolicy: isCapabilityFallback ? decision.speedPolicy : 'fallback-recovery',
    providerHealthSnapshot: buildRuntimeProviderHealthSnapshot(finalProvider),
    ...(providerIdentity ? { providerIdentity } : {}),
  };
}

function buildToolStrategyDiagnostics(
  tools: ToolDefinition[],
  usage?: ModelResponse['usage'],
): ModelToolStrategyDiagnostics {
  const toolNames = tools.map((tool) => tool.name);
  const toolNamesPreview = toolNames.slice(0, 8);
  const mcpServerIds = Array.from(new Set(
    tools
      .map(extractMcpServerId)
      .filter((serverId): serverId is string => Boolean(serverId)),
  )).sort();
  const mcpToolCount = tools.filter((tool) => tool.source === 'mcp' || Boolean(extractMcpServerId(tool))).length;
  const estimatedToolSpecTokens = tools.reduce((sum, tool) => {
    const schemaText = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    return sum + estimateTokens(schemaText);
  }, 0);
  const providerUsage = buildProviderUsageSnapshot(usage);
  const providerReport = buildProviderReportedSavingsSnapshot(usage);
  return {
    visibleToolCount: tools.length,
    ...(toolNames.length > 0 ? { toolNamesPreview } : {}),
    mcpToolCount,
    ...(mcpServerIds.length > 0 ? { mcpServerIds } : {}),
    programmaticToolCalling: tools.length > 0 ? 'available' : 'unavailable',
    programmaticToolCount: tools.length,
    tokenSavings: tools.length > 0
      ? providerReport
        ? {
            status: 'provider-reported',
            savedTokens: providerReport.savedTokens,
            detail: formatProviderReportedSavingsDetail(providerReport, providerUsage),
            measurement: {
              savingsSource: 'provider-reported',
              usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
              providerReportedSavings: true,
            },
            providerReport,
            ...(providerUsage ? { providerUsage } : {}),
          }
        : {
          status: 'estimated',
          savedTokens: estimatedToolSpecTokens,
          detail: `估算值：${tools.length} 个工具的 name/description/inputSchema 若写入普通消息上下文，约占 ${estimatedToolSpecTokens} tokens；${formatProviderUsageDetail(providerUsage)}`,
          measurement: {
            savingsSource: 'tool-spec-local-estimate',
            usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
            providerReportedSavings: false,
          },
          basis: {
            source: 'tool-spec-local-estimate',
            toolCount: tools.length,
            previewToolCount: toolNamesPreview.length,
            fields: ['name', 'description', 'inputSchema'],
          },
          ...(providerUsage ? { providerUsage } : {}),
        }
      : {
          status: 'not-measured',
          detail: providerUsage
            ? `本轮没有可见程序化工具，token saved 不计量；本轮 provider usage 已回传：输入 ${providerUsage.inputTokens} / 输出 ${providerUsage.outputTokens} tokens。`
            : '本轮没有可见程序化工具，token saved 不计量。',
          measurement: {
            savingsSource: 'not-measured',
            usageSource: providerUsage ? 'model-response-usage' : 'unavailable',
            providerReportedSavings: false,
          },
          ...(providerUsage ? { providerUsage } : {}),
        },
  };
}

function buildModelDecisionWithToolStrategy(
  decision: ModelDecisionEventData | undefined,
  tools: ToolDefinition[],
  usage?: ModelResponse['usage'],
  response?: ModelResponse,
): ModelDecisionEventData | undefined {
  if (!decision) return undefined;
  const toolStrategy = buildToolStrategyDiagnostics(tools, usage);
  const decisionWithTools = {
    ...decision,
    toolPolicy: tools.length > 0 ? decision.toolPolicy ?? 'runtime-checked' : 'disabled-by-model',
    toolStrategy,
  };
  return response ? applyFallbackResultToModelDecision(decisionWithTools, response) : decisionWithTools;
}

/**
 * 自动模式下简单任务的免费模型路由（aiSdk 路径用）。
 *
 * ADR-019 批 2：决策交给单一入口 resolveModelDecision（含计费门控——
 * 包月/未知 provider 不做省钱路由），本函数只负责执行层的 API key 解析。
 *
 * 返回带 apiKey 的免费模型配置；不满足条件时返回 null，调用方继续用原配置。
 */
export function resolveMainChatModelDecision(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  config: ModelConfig,
  opts?: { suppressDecisionEvent?: boolean },
): ModelConfig | null {
  // 计费方式：用户配置 > 类型默认值（settings 不可用时缺省 payg）
  let billingMode: BillingMode | undefined;
  let providerSettings: Record<string, ModelDecisionProviderSettings> | undefined;
  let taskStrategy: TaskModelStrategySettings | undefined;
  try {
    const settings = getConfigService().getSettings();
    providerSettings = settings.models?.providers;
    billingMode = resolveProviderBillingMode(config.provider, providerSettings);
    taskStrategy = settings.models?.taskStrategy;
  } catch { /* 测试/CLI 环境无 settings → resolveModelDecision 内部缺省 payg */ }

  const { decision, config: decided } = resolveModelDecision({
    requestedConfig: config,
    messages,
    context: 'main-chat',
    billingMode,
    providerSettings,
    taskStrategy,
  });
  let emittedDecision = decision;
  let adapted: ModelConfig | null = null;

  if (
    decision.reason === 'simple-task-free'
    || decision.reason === 'strategy-fast'
    || decision.reason === 'strategy-main'
    || decision.reason === 'strategy-deep'
    || decision.reason === 'strategy-vision'
  ) {
    adapted = { ...decided };
    if (adapted.provider !== config.provider) {
      const apiKey = getConfigService().getApiKey(adapted.provider);
      if (!apiKey) {
        if (decision.reason === 'simple-task-free') {
          getAdaptiveRouter().disableFreeModel(`no API key for ${adapted.provider}`);
        }
        emittedDecision = {
          ...decision,
          resolvedProvider: config.provider,
          resolvedModel: config.model,
          reason: 'fallback-availability',
          fallbackFrom: `${adapted.provider}/${adapted.model}`,
          strategyReason: `${decision.strategyReason || '任务策略目标模型不可用'}；${adapted.provider} 未配置 API Key，回退到当前模型`,
        };
        adapted = null;
      } else {
        adapted.apiKey = apiKey;
        // 跨 provider 切换时清掉原模型的 baseUrl，否则免费模型会打到原 provider 的端点
        adapted.baseUrl = undefined;
      }
    }
  }

  // Max Mode 候选/judge 的静默调用抑制事件发射（路由行为不变，Codex R1-M1）
  if (!opts?.suppressDecisionEvent) {
    const decisionEventData: ModelDecisionEventData = {
      ...emittedDecision,
      turnId: ctx.runtime.currentTurnId,
      timestamp: Date.now(),
    };
    ctx.runtime.currentModelDecision = decisionEventData;
    ctx.runtime.onEvent({
      type: 'model_decision',
      data: decisionEventData,
    });
    ctx.runtime.turnModelDecision = emittedDecision;
  }
  logger.info('[AgentLoop] Model decision resolved', {
    requestedProvider: emittedDecision.requestedProvider,
    requestedModel: emittedDecision.requestedModel,
    resolvedProvider: emittedDecision.resolvedProvider,
    resolvedModel: emittedDecision.resolvedModel,
    reason: emittedDecision.reason,
    billingMode: emittedDecision.billingMode,
  });

  return adapted;
}

function estimateInferenceInputTokens(
  messages: ModelMessage[],
  tools: ToolDefinition[],
): number {
  const messageTokens = estimateModelMessageTokens(
    messages.map((message) => ({
      role: message.role,
      content: message.content,
    })),
  );
  const toolTokens = tools.reduce((sum, tool) => {
    const schemaText = JSON.stringify({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
    });
    return sum + estimateTokens(schemaText);
  }, 0);

  return messageTokens + toolTokens;
}

function assertInputTokenBudget(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  options: InferenceOptions | undefined,
): void {
  const maxInputTokens = options?.maxInputTokens;
  if (!maxInputTokens || maxInputTokens <= 0) return;

  const estimatedInputTokens = estimateInferenceInputTokens(messages, tools);
  if (estimatedInputTokens > maxInputTokens) {
    throw new Error(
      `Inference input token budget exceeded before provider request: estimated ${estimatedInputTokens} > max ${maxInputTokens}`,
    );
  }
}

function capOutputTokens(config: ModelConfig, options: InferenceOptions | undefined): ModelConfig {
  const maxOutputTokens = options?.maxOutputTokens;
  if (!maxOutputTokens || maxOutputTokens <= 0) return config;
  const current = typeof config.maxTokens === 'number' && Number.isFinite(config.maxTokens)
    ? config.maxTokens
    : maxOutputTokens;
  return {
    ...config,
    maxTokens: Math.min(current, maxOutputTokens),
  };
}

function startArtifactModelWaitProgress(
  ctx: ContextAssemblyCtx,
  options: {
    artifactRequest: boolean;
    artifactRepairActive: boolean;
    artifactRepairWritePriority: boolean;
  },
): () => void {
  if (!options.artifactRequest && !options.artifactRepairActive) {
    return () => undefined;
  }

  const startedAt = Date.now();
  const baseStep = options.artifactRepairActive
    ? options.artifactRepairWritePriority
      ? '正在写入 artifact 修复补丁...'
      : '正在分析 artifact 修复方案...'
    : '正在生成 artifact 内容...';

  ctx.taskProgress.emitTaskProgress('generating', baseStep);
  const timer = setInterval(() => {
    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startedAt) / 1000));
    ctx.taskProgress.emitTaskProgress(
      'generating',
      `${baseStep} 已等待 ${elapsedSeconds} 秒，模型仍在处理。`,
    );
  }, ARTIFACT_MODEL_WAIT_HEARTBEAT_MS);

  return () => {
    clearInterval(timer);
  };
}

function getNetworkRetryBudget(errMsg: string, errCode: string | undefined, artifactRepairActive: boolean): number {
  if (!artifactRepairActive) return 1;

  const isSlowProviderTimeout =
    /request timeout|timeout after \d+ms|timed out/i.test(errMsg)
    || /ETIMEDOUT/i.test(errCode || '');
  if (isSlowProviderTimeout) return 1;

  const isFastConnectionFailure =
    /TLS connection|network socket disconnected|socket hang up|ECONNRESET|ECONNREFUSED|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac/i.test(errMsg)
    || /ECONNRESET|ECONNREFUSED/i.test(errCode || '');
  if (isFastConnectionFailure) return 2;

  return 1;
}

function isArtifactRepairMode(ctx: ContextAssemblyCtx): boolean {
  return Boolean(ctx.runtime.artifactRepairGuard?.targetFile);
}

function emitAssistantMessageDelta(
  ctx: ContextAssemblyCtx,
  path: 'content' | 'reasoning',
  text: string | undefined,
): void {
  if (!text) return;
  ctx.runtime.onEvent({
    type: 'message_delta',
    data: {
      role: 'assistant',
      path,
      op: 'append',
      text,
      turnId: ctx.runtime.currentTurnId,
      messageId: ctx.runtime.currentTurnId,
      deltaSeq: ++ctx.runtime.messageDeltaSeq,
      ...(ctx.runtime.historyVisibility === 'meta' ? { isMeta: true } : {}),
    },
  });
}

function buildArtifactValidationAttemptCompletionResponse(targetFile: string): ModelResponse {
  const toolCall: ToolCall = {
    id: `call_artifact_validation_completion_${Date.now().toString(36)}`,
    name: 'attempt_completion',
    arguments: {
      summary: `Artifact validation passed for ${targetFile}. Requesting goal verification.`,
    },
  };
  return {
    type: 'tool_use',
    toolCalls: [toolCall],
    contentParts: [{ type: 'tool_call', toolCallId: toolCall.id }],
    finishReason: 'tool_calls',
    runtimeDiagnostics: {
      artifactValidationAttemptCompletion: {
        targetFile,
      },
    },
  };
}

function emitToolSchemaSnapshot(ctx: ContextAssemblyCtx, tools: ToolDefinition[]): void {
  if (tools.length === 0) return;
  ctx.runtime.onEvent({
    type: 'tool_schema_snapshot',
    data: {
      turnId: ctx.runtime.currentTurnId,
      toolCount: tools.length,
      tools: tools.map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema as unknown as Record<string, unknown> | undefined,
        requiresPermission: tool.requiresPermission,
        permissionLevel: tool.permissionLevel,
      })),
    },
  });
}

function isArtifactRepairWritePriority(ctx: ContextAssemblyCtx): boolean {
  return isArtifactRepairWritePriorityForGuard(ctx.runtime.artifactRepairGuard);
}

function isArtifactRepairFullRewritePriority(ctx: ContextAssemblyCtx): boolean {
  return getArtifactRepairToolPolicy(ctx.runtime.artifactRepairGuard)?.fullRewritePriority ?? false;
}

function filterToolsForArtifactRepair<T extends { name: string }>(
  tools: T[],
  ctx: ContextAssemblyCtx,
): T[] {
  const policy = getArtifactRepairToolPolicy(ctx.runtime.artifactRepairGuard);
  if (!policy) return tools;
  return tools.filter((tool) => policy.allowlist.has(tool.name));
}

function dedupeToolDefinitions<T extends { name: string }>(tools: T[]): T[] {
  const seen = new Set<string>();
  const deduped: T[] = [];
  const duplicates: string[] = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      duplicates.push(tool.name);
      continue;
    }
    seen.add(tool.name);
    deduped.push(tool);
  }

  if (duplicates.length > 0) {
    logger.warn('[AgentLoop] Deduped duplicate tool definitions', {
      duplicateNames: [...new Set(duplicates)],
      before: tools.length,
      after: deduped.length,
    });
  }

  return deduped;
}

function capArtifactRepairMaxTokens(
  ctx: ContextAssemblyCtx,
  config: typeof ctx.runtime.modelConfig,
): typeof ctx.runtime.modelConfig {
  if (!ctx.runtime.artifactRepairGuard) return config;
  const currentMaxTokens = config.maxTokens;
  if (typeof currentMaxTokens !== 'number') return config;

  const cap = isArtifactRepairFullRewritePriority(ctx)
    ? ARTIFACT_REPAIR_WRITE_MAX_TOKENS
    : isArtifactRepairWritePriority(ctx)
      ? ARTIFACT_REPAIR_TARGETED_EDIT_MAX_TOKENS
      : ARTIFACT_REPAIR_RECOVERY_MAX_TOKENS;
  if (currentMaxTokens <= cap) return config;
  return {
    ...config,
    maxTokens: cap,
  };
}

/**
 * Max Mode（best-of-N，roadmap 3.3）分支：N 并发 propose-only 候选 → judge 选索引 →
 * 赢家 replay（由主链路下游正常执行其工具调用）。
 *
 * 副作用隔离：候选与 judge 走无流式回调、无快照（onSnapshot 剥离）的静默引擎调用——
 * 不发 UI 流事件、不写 stream snapshot、不执行任何工具。全候选失败时降级为带
 * streamCallback 的正常单次调用，用户无感。
 *
 * 成本约束（roadmap 3.3.d）：落选候选 + judge 的 usage 作为 overhead 记入成本统计
 * （ctx.recordTokenUsage → budgetService），但不进上下文长度估算——上下文路径
 * （streamHandler 累计 ctx.totalInputTokens/totalOutputTokens、line ~820 的赢家估算）
 * 只见到赢家的 response.usage。
 */
/**
 * 预算头寸闸（Codex R1-H3）：预算已到 WARNING/BLOCKED 时不做 N 倍并发扇出——
 * budgetService 的事后记账拦不住一次 step 内并发花出去的 N+1 笔调用，
 * 临界状态下直接退回正常单次调用（行为与开关关一致）。
 */
function maxModeBudgetHeadroomOk(): boolean {
  try {
    const { alertLevel } = getBudgetService().checkBudget();
    const ok = alertLevel !== BudgetAlertLevel.WARNING && alertLevel !== BudgetAlertLevel.BLOCKED;
    if (!ok) {
      logger.warn(`[MaxMode] budget alertLevel=${alertLevel}; skipping best-of-N fanout for this step`);
    }
    return ok;
  } catch {
    // 测试/CLI 环境无 budget 服务 → 不拦
    return true;
  }
}

async function runMaxModeInference(
  ctx: ContextAssemblyCtx,
  messages: ModelMessage[],
  tools: ToolDefinition[],
  requestConfig: ModelConfig,
  streamCallback: StreamCallback,
  engineOptions: InferenceOptions,
): Promise<ModelResponse> {
  const { onSnapshot: _onSnapshot, ...restOptions } = engineOptions;
  const silentOptions: InferenceOptions = { ...restOptions, suppressModelDecisionEvent: true };
  const signal = ctx.runtime.abortController?.signal;
  const candidates = ctx.runtime.maxModeCandidates;
  ctx.taskProgress.emitTaskProgress('thinking', `Max Mode：${candidates} 个候选并行起草中...`);

  // overhead 逐条按实际路由模型分账（adaptive 路由后可能 ≠ 请求模型，Codex R1-M2）；
  // 不走 ctx.recordTokenUsage——那条路径固定记在请求模型名下
  const recordOverheadEntries = (entries: Array<{ inputTokens: number; outputTokens: number; actualProvider?: string; actualModel?: string }>) => {
    for (const entry of entries) {
      getBudgetService().recordUsage({
        inputTokens: entry.inputTokens,
        outputTokens: entry.outputTokens,
        model: entry.actualModel ?? requestConfig.model,
        provider: entry.actualProvider ?? requestConfig.provider,
        timestamp: Date.now(),
      });
    }
  };

  let stepResult;
  try {
    stepResult = await runMaxModeStep(
      {
        silentEngine: (msgs, tls) =>
          runEngineInference(ctx, msgs, tls, requestConfig, undefined, signal, silentOptions),
        streamingEngine: (msgs, tls) =>
          runEngineInference(ctx, msgs, tls, requestConfig, streamCallback, signal, engineOptions),
        // 取消/转向/中断时丢弃整个 step（含已完成的部分赢家），走外层既有取消语义
        isAborted: () =>
          Boolean(ctx.runtime.isCancelled || ctx.runtime.isInterrupted || ctx.runtime.needsReinference),
      },
      { messages, tools, candidates },
    );
  } catch (error) {
    // 中止丢弃整个 step，但已完成候选/judge 的 token 是真实花费——
    // 先记沉没成本再重抛，由外层取消语义接管（Codex R2-M1）
    if (error instanceof MaxModeAbortError) {
      recordOverheadEntries(error.overheadEntries);
    }
    throw error;
  }
  const { response, stats } = stepResult;
  recordOverheadEntries(stats.overheadEntries);
  response.runtimeDiagnostics = {
    ...response.runtimeDiagnostics,
    maxMode: {
      candidates: stats.candidates,
      survivors: stats.survivors,
      winner: stats.winner,
      degraded: stats.degraded,
      judgeParsed: stats.judgeParsed,
      overheadInputTokens: stats.overhead.inputTokens,
      overheadOutputTokens: stats.overhead.outputTokens,
    },
  };
  return response;
}

export async function inference(ctx: ContextAssemblyCtx): Promise<ModelResponse> {
  seedArtifactRepairGuardFromContext(ctx.runtime);

  // 根据配置决定使用全量工具还是核心+延迟工具
  let tools;
  if (ctx.runtime.enableToolDeferredLoading) {
    preloadDeferredToolsForTurn(ctx.runtime);
    // 使用核心工具 + 已加载的延迟工具
    const coreTools = getCoreToolDefinitions();
    const loadedDeferredTools = getLoadedDeferredToolDefinitions();
    tools = [...coreTools, ...loadedDeferredTools];
    logger.debug(`Tools (deferred loading): ${coreTools.length} core + ${loadedDeferredTools.length} deferred = ${tools.length} total`);
  } else {
    // 传统模式：发送所有工具
    tools = getAllToolDefinitions();
    logger.debug('Tools:', tools.map((t) => t.name));
  }

  tools = filterToolDefinitionsByWorkbenchScope(tools, ctx.runtime.toolScope);
  // opt-in 严格工具集：strict-toolset skill（edit-role/create-role）激活时，把可见工具集
  // 硬收缩到其 allowedTools，防止模型抓 core 的 Edit/Write 绕过 skill 流程。非 strict 不受影响。
  const beforeStrict = tools.length;
  tools = filterToolDefinitionsByStrictSkillBoundary(tools, ctx.runtime.skillToolBoundary);
  if (tools.length !== beforeStrict) {
    logger.info(
      `[AgentLoop] Strict skill toolset: tool list narrowed ${beforeStrict} -> ${tools.length} (skill=${ctx.runtime.skillToolBoundary?.skillName})`,
    );
  }
  tools = filterToolsByRunPolicy(tools, ctx.runtime);
  if (isArtifactRepairMode(ctx)) {
    const before = tools.length;
    const phase = ctx.runtime.artifactRepairGuard?.phase ?? 'initial_repair';
    tools = filterToolsForArtifactRepair(tools, ctx);
    logger.info(
      `[AgentLoop] Artifact repair mode: tool list narrowed ${before} -> ${tools.length} (phase=${phase})`,
    );
  }
  tools = dedupeToolDefinitions(tools);
  emitToolSchemaSnapshot(ctx, tools);

  let effectiveTools = tools;
  let effectiveConfig = ctx.runtime.modelConfig;
  let artifactRequest = false;
  let pendingCapabilityFallback: ModelFallbackInfo | null = null;

  let modelMessages: ModelMessage[] = await ctx.buildModelMessages();
  if (ctx.runtime.forceFinalResponsePrompt) {
    modelMessages = [
      ...modelMessages,
      {
        role: 'system',
        content: ctx.runtime.forceFinalResponsePrompt,
      },
    ];
  }
  logger.debug('[AgentLoop] Model messages count:', modelMessages.length);
  logger.debug('[AgentLoop] Model config:', {
    provider: ctx.runtime.modelConfig.provider,
    model: ctx.runtime.modelConfig.model,
    hasApiKey: !!ctx.runtime.modelConfig.apiKey,
  });

  const langfuse = getLangfuseService();
  const llmCallId = `llm-${ctx.runtime.traceId}-${Date.now()}`;
  const startTime = new Date();

  const inputSummary = modelMessages.map(m => ({
    role: m.role,
    contentLength: m.content.length,
    contentPreview: typeof m.content === 'string' ? m.content.substring(0, 200) : '[multimodal]',
  }));

  langfuse.startGenerationInSpan(ctx.runtime.currentIterationSpanId, llmCallId, `LLM: ${ctx.runtime.modelConfig.model}`, {
    model: ctx.runtime.modelConfig.model,
    modelParameters: {
      provider: ctx.runtime.modelConfig.provider,
      temperature: ctx.runtime.modelConfig.temperature,
      maxTokens: ctx.runtime.modelConfig.maxTokens,
    },
    input: {
      messageCount: modelMessages.length,
      toolCount: tools.length,
      messages: inputSummary,
    },
    startTime,
  });

  const artifactRepairWritePriority = isArtifactRepairWritePriority(ctx);
  const artifactRepairFullRewritePriority = isArtifactRepairFullRewritePriority(ctx);
  let requestConfigForRetry: typeof ctx.runtime.modelConfig = effectiveConfig;

  try {
    // Capability detection and model fallback
    effectiveConfig = ctx.runtime.modelConfig;
    const lastUserMessage = modelMessages.filter(m => m.role === 'user').pop();
    const currentTurnMessages = lastUserMessage ? [lastUserMessage] : [];
    const requiredCapabilities = ctx.runtime.modelRouter.detectRequiredCapabilities(currentTurnMessages);
    const allowCapabilityFallback = ctx.runtime.modelConfig.adaptive === true;
    let needsVisionFallback = false;
    let visionFallbackSucceeded = false;

    const userRequestText = extractUserRequestText(lastUserMessage);
    artifactRequest = needsArtifactTaskBrief(userRequestText);
    const needsToolForImage = /标[注记]|画框|框[出住]|圈[出住]|矩形|annotate|mark|highlight|draw/i.test(userRequestText);

    if (needsToolForImage && requiredCapabilities.includes('vision')) {
      logger.info('[AgentLoop] 用户请求需要工具处理图片（标注/画框），跳过视觉 fallback');
      const visionIndex = requiredCapabilities.indexOf('vision');
      if (visionIndex > -1) {
        requiredCapabilities.splice(visionIndex, 1);
      }
      modelMessages = stripImagesFromMessages(modelMessages);
    }

    if (requiredCapabilities.length > 0) {
      const currentModelInfo = ctx.runtime.modelRouter.getModelInfo(
        ctx.runtime.modelConfig.provider,
        ctx.runtime.modelConfig.model
      );

      for (const capability of requiredCapabilities) {
        const hasCapability = currentModelInfo?.capabilities?.includes(capability) ||
          (capability === 'vision' && currentModelInfo?.supportsVision);

        if (!hasCapability) {
          if (capability === 'vision') {
            needsVisionFallback = true;
          }

          // 视觉预处理：用一个识图模型把图片转成文字摘要后，继续用主模型回答（不切换主模型）。
          // 候选按「同 provider 视觉模型 → 其它已配置 Key 的视觉模型」排序，依次尝试，直到某个
          // 成功读图——所以 mimo 自家的 omni 万一不能吃图，会自动切到用户配过 Key 的下一个识图
          // 模型，而不是写死回退到某个固定 provider。这一步不越过用户显式选的主模型，所以即使
          // adaptive=false（显式选模型）也必须跑——否则截图会被直接 strip、主模型（如
          // mimo-v2.5-pro）完全看不到图（实证踩坑 2026-06-06）。
          if (capability === 'vision' && !needsToolForImage) {
            const visionCandidates = ctx.runtime.modelRouter.getVisionPreflightCandidates(ctx.runtime.modelConfig);
            for (const visionConfig of visionCandidates) {
              try {
                const preflightMessages = await preflightImagesForMainModel(
                  ctx,
                  modelMessages,
                  visionConfig,
                  userRequestText,
                  runEngineInference,
                );
                if (preflightMessages) {
                  modelMessages = preflightMessages;
                  visionFallbackSucceeded = true;
                  logger.info(`[Fallback] 使用 ${visionConfig.provider}/${visionConfig.model} 预处理图片，继续使用主模型 ${ctx.runtime.modelConfig.model}`);
                  ctx.runtime.onEvent({
                    type: 'notification',
                    data: {
                      message: `已用视觉模型 ${visionConfig.model} 读取图片，继续由 ${ctx.runtime.modelConfig.model} 回答。`,
                    },
                  } as AgentEvent);
                  break;
                }
              } catch (error) {
                logger.warn(`[Fallback] 视觉预处理失败（${visionConfig.provider}/${visionConfig.model}），尝试下一个识图模型`, {
                  error: error instanceof Error ? error.message : String(error),
                });
              }
            }
            if (visionFallbackSucceeded) {
              continue;
            }
            logger.warn('[Fallback] 所有已配置的识图模型预处理均失败或不可用');
          }

          // 整轮模型切换（用 fallback 模型替换用户选择的主模型）：仅在用户选"自动"
          // (adaptive=true) 时才允许，避免越过用户对模型的明确选择。
          if (!allowCapabilityFallback) {
            logger.info(`[Fallback] 显式模型 ${ctx.runtime.modelConfig.provider}/${ctx.runtime.modelConfig.model} 不启用 ${capability} 整轮模型切换`);
            continue;
          }

          const fallbackConfig = ctx.runtime.modelRouter.getFallbackConfig(capability, ctx.runtime.modelConfig);
          if (fallbackConfig) {
            const configService = getConfigService();
            const fallbackApiKey = configService.getApiKey(fallbackConfig.provider) || fallbackConfig.apiKey;
            logger.info(`[Fallback] provider=${fallbackConfig.provider}, model=${fallbackConfig.model}, hasLocalKey=${!!fallbackApiKey}`);

            if (fallbackApiKey) {
              fallbackConfig.apiKey = fallbackApiKey;
              logger.info(`[Fallback] 使用本地 ${fallbackConfig.provider} Key 切换到 ${fallbackConfig.model}`);
              pendingCapabilityFallback = {
                reason: capability,
                category: 'capability',
                strategy: 'adaptive-capability-fallback',
                from: { provider: ctx.runtime.modelConfig.provider, model: ctx.runtime.modelConfig.model },
                to: { provider: fallbackConfig.provider, model: fallbackConfig.model },
                tried: [
                  {
                    provider: ctx.runtime.modelConfig.provider,
                    model: ctx.runtime.modelConfig.model,
                    status: 'tried',
                    reason: 'missing_capability',
                    category: capability,
                    detail: `需要 ${capability} 能力`,
                  },
                  {
                    provider: fallbackConfig.provider,
                    model: fallbackConfig.model,
                    status: 'selected',
                    reason: 'capability_fallback_selected',
                    category: capability,
                    detail: `具备 ${capability} 能力`,
                  },
                ],
              };
              effectiveConfig = fallbackConfig;
              if (capability === 'vision') {
                visionFallbackSucceeded = true;
              }
              break;
            } else {
              logger.info(`[Fallback] ${fallbackConfig.provider} 未配置本地 Key，无法切换`);
              ctx.runtime.onEvent({
                type: 'api_key_required',
                data: {
                  provider: fallbackConfig.provider,
                  capability: capability,
                  message: `需要 ${capability} 能力，但 ${fallbackConfig.provider} API Key 未配置。请在设置中配置 ${fallbackConfig.provider.toUpperCase()}_API_KEY。`,
                },
              });
            }
          }
        }
      }
    }

    if (needsVisionFallback && !visionFallbackSucceeded) {
      logger.warn('[AgentLoop] 无法使用视觉模型，将图片转换为文字描述');
      modelMessages = stripImagesFromMessages(modelMessages);
    }

    if (effectiveConfig === ctx.runtime.modelConfig) {
      const mainModelInfo = ctx.runtime.modelRouter.getModelInfo(
        ctx.runtime.modelConfig.provider,
        ctx.runtime.modelConfig.model
      );
      if (!mainModelInfo?.supportsVision) {
        const hasImages = modelMessages.some((msg) => contentHasImageParts(msg.content));
        if (hasImages) {
          logger.warn('[AgentLoop] 主模型不支持视觉，但历史消息中包含图片，移除图片避免 API 错误');
          modelMessages = stripImagesFromMessages(modelMessages);
        }
      }
    }

    effectiveTools = tools;
    if (ctx.runtime.forceFinalResponseReason) {
      effectiveTools = [];
      logger.warn('[AgentLoop] Force-final-response active; tool list disabled', {
        reason: ctx.runtime.forceFinalResponseReason,
      });
    }
    if (effectiveConfig !== ctx.runtime.modelConfig) {
      const fallbackModelInfo = ctx.runtime.modelRouter.getModelInfo(
        effectiveConfig.provider,
        effectiveConfig.model
      );
      if (fallbackModelInfo && !fallbackModelInfo.supportsTool) {
        logger.warn(`[AgentLoop] Fallback 模型 ${effectiveConfig.model} 不支持 tool calls，清空工具列表`);
        const disabledToolNames = effectiveTools.map((tool) => tool.name);
        if (pendingCapabilityFallback) {
          pendingCapabilityFallback = {
            ...pendingCapabilityFallback,
            toolPolicy: {
              status: 'disabled',
              reason: 'fallback_model_without_tool_support',
              originalToolCount: disabledToolNames.length,
              effectiveToolCount: 0,
              ...(disabledToolNames.length > 0 ? { disabledToolNames } : {}),
              detail: `Fallback 模型 ${effectiveConfig.provider}/${effectiveConfig.model} 不支持工具调用，本轮改为纯文本回复。`,
            },
          };
        }
        effectiveTools = [];

        const simplifiedPrompt = `你是一个图片理解助手。请仔细观察图片内容，按照用户的要求进行分析。

输出要求：
- 使用清晰、结构化的格式
- 如果用户要求识别文字(OCR)，按阅读顺序列出所有文字
- 如果用户要求描述位置，使用相对位置描述（如"左上角"、"中央"）
- 只输出分析结果，不要解释你的能力或限制`;

        if (modelMessages.length > 0 && modelMessages[0].role === 'system') {
          modelMessages[0].content = simplifiedPrompt;
          logger.info(`[AgentLoop] 简化视觉模型 system prompt (${simplifiedPrompt.length} chars)`);
        }

        ctx.runtime.onEvent({
          type: 'notification',
          data: {
            message: `视觉模型 ${effectiveConfig.model} 不支持工具调用，本次请求将仅使用纯文本回复`,
          },
        });
      }
    }
    if (pendingCapabilityFallback) {
      emitModelFallbackNoticeFromResponse(ctx, pendingCapabilityFallback);
    }

    effectiveConfig = applyEffortControls(
      effectiveConfig,
      ctx.runtime.effortLevel,
      { thinkingEnabled: ctx.runtime.thinkingEnabled },
    );

    logger.debug('[AgentLoop] Calling modelRouter.inference()...');
    logger.debug('[AgentLoop] Effective model:', effectiveConfig.model);
    logger.debug('[AgentLoop] Effective tools count:', effectiveTools.length);

    const artifactValidationPassed = Boolean(ctx.runtime.artifactValidationPassedTargetFile);
    if (artifactValidationPassed && ctx.runtime.goalMode?.isPending()) {
      const targetFile = ctx.runtime.artifactValidationPassedTargetFile || 'interactive artifact';
      ctx.runtime.artifactValidationPassedTargetFile = undefined;
      const response = buildArtifactValidationAttemptCompletionResponse(targetFile);
      logger.info('[AgentLoop] Artifact validation passed; requesting goal completion without another model call', {
        targetFile,
      });
      langfuse.endGeneration(llmCallId, {
        type: response.type,
        contentLength: 0,
        toolCallCount: response.toolCalls?.length || 0,
        synthetic: true,
      });
      return response;
    }

    // 创建 AbortController，支持中断/转向时立即终止 API 流
    ctx.runtime.abortController = new AbortController();

    // Reset partial content accumulator for this inference call
    ctx.runtime.lastStreamedContent = '';
    const contentStreamFilter = createHandoffTailStreamFilter((text) =>
      emitAssistantMessageDelta(ctx, 'content', text)
    );

    const streamCallback: StreamCallback = (chunk) => {
      if (typeof chunk === 'string') {
        ctx.runtime.lastStreamedContent += chunk;
        contentStreamFilter.push(chunk);
      } else if (chunk.type === 'text') {
        ctx.runtime.lastStreamedContent += chunk.content;
        contentStreamFilter.push(chunk.content);
      } else if (chunk.type === 'reasoning') {
        // 推理模型的思考过程 (glm-4.7 等)
        emitAssistantMessageDelta(ctx, 'reasoning', chunk.content);
      } else if (chunk.type === 'tool_call_start') {
        ctx.runtime.onEvent({
          type: 'stream_tool_call_start',
          data: {
            index: chunk.toolCall?.index,
            id: chunk.toolCall?.id,
            name: chunk.toolCall?.name,
            turnId: ctx.runtime.currentTurnId,
          },
        });
      } else if (chunk.type === 'tool_call_delta') {
        ctx.runtime.onEvent({
          type: 'stream_tool_call_delta',
          data: {
            index: chunk.toolCall?.index,
            name: chunk.toolCall?.name,
            argumentsDelta: chunk.toolCall?.argumentsDelta,
            turnId: ctx.runtime.currentTurnId,
          },
        });
      } else if (chunk.type === 'usage') {
        // SSE 实时 usage 数据（API 返回的真实 token 用量）
        ctx.runtime.onEvent({
          type: 'stream_usage',
          data: {
            inputTokens: chunk.inputTokens || 0,
            outputTokens: chunk.outputTokens || 0,
            turnId: ctx.runtime.currentTurnId,
          },
        });
      } else if (chunk.type === 'token_estimate') {
        // SSE 实时 token 估算（每 500ms 基于字符数估算）
        ctx.runtime.onEvent({
          type: 'stream_token_estimate',
          data: {
            inputTokens: chunk.inputTokens || 0,
            outputTokens: chunk.outputTokens || 0,
            turnId: ctx.runtime.currentTurnId,
          },
        });
      }
    };

    const requestConfig = capOutputTokens(
      capArtifactRepairMaxTokens(ctx, effectiveConfig),
      ctx.runtime.inferenceOptions,
    );
    assertInputTokenBudget(modelMessages, effectiveTools, ctx.runtime.inferenceOptions);
    requestConfigForRetry = requestConfig;
    const stopArtifactProgress = startArtifactModelWaitProgress(ctx, {
      artifactRequest,
      artifactRepairActive: Boolean(ctx.runtime.artifactRepairGuard),
      artifactRepairWritePriority,
    });
    let response: ModelResponse;
    try {
      const engineOptions: InferenceOptions = {
        ...ctx.runtime.inferenceOptions,
        onSnapshot: createSnapshotHandler(
          ctx.runtime.sessionId,
          ctx.runtime.currentTurnId,
          ctx.runtime.workingDirectory,
        ),
        artifactRepairActive: Boolean(ctx.runtime.artifactRepairGuard),
        artifactRepairWritePriority,
        artifactRepairFullRewritePriority,
      };
      if (ctx.runtime.maxMode && maxModeBudgetHeadroomOk()) {
        response = await runMaxModeInference(
          ctx,
          modelMessages,
          effectiveTools,
          requestConfig,
          streamCallback,
          engineOptions,
        );
      } else {
        response = await runEngineInference(
          ctx,
          modelMessages,
          effectiveTools,
          requestConfig,
          streamCallback,
          ctx.runtime.abortController.signal,
          engineOptions,
        );
      }
    } finally {
      stopArtifactProgress();
    }
    contentStreamFilter.flush();
    if (pendingCapabilityFallback && !response.fallback) {
      response.actualProvider = pendingCapabilityFallback.to.provider;
      response.actualModel = pendingCapabilityFallback.to.model;
      response.fallback = pendingCapabilityFallback;
    }
    const toolStrategy = buildToolStrategyDiagnostics(effectiveTools, response.usage);
    const modelDecision = buildModelDecisionWithToolStrategy(ctx.runtime.currentModelDecision, effectiveTools, response.usage, response);
    response.runtimeDiagnostics = {
      ...response.runtimeDiagnostics,
      visibleToolNames: effectiveTools.map((tool) => tool.name),
      toolStrategy,
      ...(modelDecision ? { modelDecision } : {}),
      artifactRepairGuard: ctx.runtime.artifactRepairGuard
        ? {
            targetFile: ctx.runtime.artifactRepairGuard.targetFile,
            attempts: ctx.runtime.artifactRepairGuard.attempts,
            phase: ctx.runtime.artifactRepairGuard.phase,
            patched: ctx.runtime.artifactRepairGuard.patched,
            repairTurnsWithoutProgress: ctx.runtime.artifactRepairGuard.repairTurnsWithoutProgress,
            activeIssueCodes: ctx.runtime.artifactRepairGuard.activeIssueCodes,
        }
        : undefined,
    };
    const fallbackNoticeAlreadyEmitted =
      pendingCapabilityFallback !== null && response.fallback === pendingCapabilityFallback;
    if (!fallbackNoticeAlreadyEmitted) {
      emitModelFallbackNoticeFromResponse(ctx, response.fallback);
    }

    ctx.runtime.abortController = null;
    logger.debug('[AgentLoop] Model response received:', response.type);

    // Record token usage with precise estimation
    const estimatedInputTokens = estimateModelMessageTokens(
      modelMessages.map(m => ({
        role: m.role,
        content: m.content,
      }))
    );
    const outputContent = (response.content || '') +
      (response.toolCalls?.map((tc: ToolCall) => JSON.stringify(tc.arguments || {})).join('') || '');
    const estimatedOutputTokens = estimateModelMessageTokens([
      { role: 'assistant', content: outputContent },
    ]);
    ctx.recordTokenUsage(estimatedInputTokens, estimatedOutputTokens);

    langfuse.endGeneration(llmCallId, {
      type: response.type,
      contentLength: response.content?.length || 0,
      toolCallCount: response.toolCalls?.length || 0,
    });

    return response;
  } catch (error) {
    ctx.runtime.abortController = null;

    // steer/interrupt 导致的 abort 不是错误，返回空文本让主循环处理
    if (ctx.runtime.needsReinference || ctx.runtime.isInterrupted || ctx.runtime.isCancelled) {
      logger.info('[AgentLoop] Inference aborted due to steer/interrupt/cancel');
      return { type: 'text', content: '' };
    }

    emitModelFallbackNoticeFromResponse(ctx, getModelFallbackFromError(error));

    logger.error('[AgentLoop] Model inference error:', error);

    langfuse.endGeneration(
      llmCallId,
      { error: error instanceof Error ? error.message : 'Unknown error' },
      undefined,
      'ERROR',
      error instanceof Error ? error.message : 'Unknown error'
    );

    if (error instanceof ContextLengthExceededError) {
      logger.warn(`[AgentLoop] Context length exceeded: ${error.requestedTokens} > ${error.maxTokens}`);
      logCollector.agent('WARN', `Context overflow, attempting auto-recovery`);

      // 通知用户正在恢复
      ctx.runtime.onEvent({
        type: 'context_compressed',
        data: {
          savedTokens: 0,
          strategy: 'overflow_recovery',
          newMessageCount: ctx.runtime.messages.length,
        },
      } as AgentEvent);

      // 尝试自动压缩 + 重试
      try {
        await ctx.checkAndAutoCompress();

        if (!ctx.runtime._contextOverflowRetried) {
          ctx.runtime._contextOverflowRetried = true;
          const originalMaxTokens = ctx.runtime.modelConfig.maxTokens;
          ctx.runtime.modelConfig.maxTokens = Math.floor((originalMaxTokens || error.maxTokens) * 0.7);
          logger.info(`[AgentLoop] Auto-recovery: maxTokens reduced from ${originalMaxTokens} to ${ctx.runtime.modelConfig.maxTokens}`);

          try {
            return await ctx.inference();
          } finally {
            ctx.runtime._contextOverflowRetried = false;
            ctx.runtime.modelConfig.maxTokens = originalMaxTokens;
          }
        }
      } catch (recoveryError) {
        logger.error('[AgentLoop] Auto-recovery failed:', recoveryError);
      }

      // 恢复失败，回退到原行为
      ctx.runtime.onEvent({
        type: 'error',
        data: {
          code: 'CONTEXT_LENGTH_EXCEEDED',
          message: '上下文压缩后仍超限，建议新开会话。',
          suggestion: '建议新开一个会话继续对话。',
          details: {
            requested: error.requestedTokens,
            max: error.maxTokens,
            provider: error.provider,
          },
        },
      });

      ctx.taskProgress.emitTaskProgress('failed', '上下文超限');
      return { type: 'text', content: '' };
    }

    // 网络/TLS 瞬态错误：在 agentLoop 层做有限重试（provider 层重试已耗尽后的最后兜底）
    const errMsg = error instanceof Error ? error.message : String(error);
    const errCode = (error as NodeJS.ErrnoException).code;
    const isIncompleteToolStream = /stream ended before \[DONE\] with tool calls|refusing to execute incomplete tool arguments|invalid streamed tool arguments/i.test(errMsg);
    if (isIncompleteToolStream && artifactRequest && !ctx.runtime._artifactNonStreamingRetried) {
      ctx.runtime._artifactNonStreamingRetried = true;
      logger.warn('[AgentLoop] Artifact tool stream ended incomplete; retrying once with non-streaming inference');
      logCollector.agent('WARN', 'Artifact tool stream incomplete; retrying non-streaming');
      ctx.runtime.onEvent({
        type: 'notification',
        data: {
          message: '生成文件时模型流中断，正在切换到更稳的非流式方式重试。',
        },
      } as AgentEvent);
      ctx.taskProgress.emitTaskProgress('generating', '模型流中断，正在用非流式方式重试 artifact 生成...');
      try {
        const retryResult = await runEngineInference(
          ctx,
          modelMessages,
          effectiveTools,
          effectiveConfig,
          undefined,
          undefined,
          { forceNonStreaming: true, disableProviderTransientRetry: true },
        );
        ctx.runtime._artifactNonStreamingRetried = false;
        return retryResult;
      } catch (retryErr) {
        ctx.runtime._artifactNonStreamingRetried = false;
        logger.error('[AgentLoop] Artifact non-streaming retry also failed:', retryErr);
      }
    }
    const isSlowProviderTimeout =
      /request timeout|timeout after \d+ms|timed out/i.test(errMsg)
      || /ETIMEDOUT/i.test(errCode || '');
    const shouldCompactRetryArtifactRepairWrite =
      Boolean(ctx.runtime.artifactRepairGuard)
      && artifactRepairWritePriority
      && isSlowProviderTimeout
      && !ctx.runtime._artifactRepairCompactWriteRetried;
    if (shouldCompactRetryArtifactRepairWrite) {
      ctx.runtime._artifactRepairCompactWriteRetried = true;
      logger.warn('[AgentLoop] Artifact repair write-priority timed out; retrying once with compact mutation-only context');
      logCollector.agent('WARN', 'Artifact repair write-priority timed out; retrying compact mutation-only context');
      ctx.taskProgress.emitTaskProgress('generating', 'artifact 修复写入超时，正在用更小上下文重试...');
      try {
        const compactMessages = buildCompactArtifactRepairWriteRetryMessages(ctx, modelMessages, errMsg);
        const compactConfig = {
          ...requestConfigForRetry,
          maxTokens: Math.min(
            typeof requestConfigForRetry.maxTokens === 'number' ? requestConfigForRetry.maxTokens : ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS,
            ARTIFACT_REPAIR_COMPACT_WRITE_RETRY_MAX_TOKENS,
          ),
        };
        const compactAbortController = new AbortController();
        ctx.runtime.abortController = compactAbortController;
        const retryResult = await runEngineInference(
          ctx,
          compactMessages,
          effectiveTools,
          compactConfig,
          undefined,
          compactAbortController.signal,
          {
            artifactRepairActive: true,
            artifactRepairWritePriority: true,
            artifactRepairFullRewritePriority,
            forceNonStreaming: true,
            disableProviderTransientRetry: true,
            requestTimeoutMs: 90_000,
            firstByteTimeoutMs: 20_000,
            inactivityTimeoutMs: 45_000,
          },
        );
        ctx.runtime.abortController = null;
        ctx.runtime._artifactRepairCompactWriteRetried = false;
        if (pendingCapabilityFallback && !retryResult.fallback) {
          retryResult.actualProvider = pendingCapabilityFallback.to.provider;
          retryResult.actualModel = pendingCapabilityFallback.to.model;
          retryResult.fallback = pendingCapabilityFallback;
        }
        const retryToolStrategy = buildToolStrategyDiagnostics(effectiveTools, retryResult.usage);
        const retryModelDecision = buildModelDecisionWithToolStrategy(ctx.runtime.currentModelDecision, effectiveTools, retryResult.usage, retryResult);
        retryResult.runtimeDiagnostics = {
          ...retryResult.runtimeDiagnostics,
          visibleToolNames: effectiveTools.map((tool) => tool.name),
          toolStrategy: retryToolStrategy,
          ...(retryModelDecision ? { modelDecision: retryModelDecision } : {}),
          artifactRepairCompactWriteRetry: true,
          artifactRepairGuard: ctx.runtime.artifactRepairGuard
            ? {
                targetFile: ctx.runtime.artifactRepairGuard.targetFile,
                attempts: ctx.runtime.artifactRepairGuard.attempts,
                phase: ctx.runtime.artifactRepairGuard.phase,
                patched: ctx.runtime.artifactRepairGuard.patched,
                repairTurnsWithoutProgress: ctx.runtime.artifactRepairGuard.repairTurnsWithoutProgress,
                activeIssueCodes: ctx.runtime.artifactRepairGuard.activeIssueCodes,
              }
            : undefined,
        };
        return retryResult;
      } catch (retryErr) {
        ctx.runtime.abortController = null;
        ctx.runtime._artifactRepairCompactWriteRetried = false;
        logger.error('[AgentLoop] Compact artifact repair write retry also failed:', retryErr);
      }
    }
    const isNetworkError = /ECONNRESET|ETIMEDOUT|ECONNREFUSED|socket hang up|TLS connection|ERR_SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|SSL_DECRYPTION_FAILED_OR_BAD_RECORD_MAC|bad record mac|network socket disconnected|request timeout|timeout after \d+ms|timed out/i.test(errMsg)
      || /ECONNRESET|ETIMEDOUT|ECONNREFUSED/i.test(errCode || '');
    const maxNetworkRetries = getNetworkRetryBudget(
      errMsg,
      errCode,
      Boolean(ctx.runtime.artifactRepairGuard),
    );
    const networkRetryCount = ctx.runtime._networkRetryCount ?? (ctx.runtime._networkRetried ? 1 : 0);
    const shouldRetryNetworkError =
      isNetworkError
      && networkRetryCount < maxNetworkRetries
      && ctx.runtime.inferenceOptions?.disableRuntimeNetworkRetry !== true
      && !(ctx.runtime.artifactRepairGuard && isSlowProviderTimeout);
    if (shouldRetryNetworkError) {
      ctx.runtime._networkRetried = true;
      ctx.runtime._networkRetryCount = networkRetryCount + 1;
      logger.warn(`[AgentLoop] Network error "${errMsg}" (code=${errCode}), retrying inference (${ctx.runtime._networkRetryCount}/${maxNetworkRetries})...`);
      await new Promise(r => setTimeout(r, 2000));
      try {
        const retryResult = await ctx.inference();
        ctx.runtime._networkRetried = false;
        ctx.runtime._networkRetryCount = 0;
        return retryResult;
      } catch (retryErr) {
        if ((ctx.runtime._networkRetryCount ?? 0) >= maxNetworkRetries) {
          ctx.runtime._networkRetried = false;
          ctx.runtime._networkRetryCount = 0;
        }
        logger.error('[AgentLoop] Network retry also failed:', retryErr);
      }
    }

    throw error;
  }
}
