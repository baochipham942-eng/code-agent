// ContextAssembly - AI SDK provider fallback machinery（从 inference.ts 纯结构性抽出，零行为改动）。
// 主 loop 推理的 provider 降级链执行、fallback trace 构建、降级事件广播/通知。
import type { ToolDefinition } from '../../../../shared/contract';
import { inferenceViaAiSdk, aiSdkSupportsProvider } from '../../../model/adapters/aiSdkAdapter';
import { getConfigService } from '../../../services';
import { getModelMaxOutputTokens } from '../../../../shared/constants';
import type { ModelMessage } from '../../../agent/loopTypes';
import type { StreamCallback, InferenceOptions, ModelResponse as RouterModelResponse } from '../../../model/types';
import type { ModelConfig, ModelProvider } from '../../../../shared/contract/model';
import type { ModelDecisionEventData, ModelFallbackInfo, ModelFallbackTraceStep } from '../../../../shared/contract/modelDecision';
import { buildModelProviderIdentity } from '../../../model/modelDecision';
import { classifyProviderFallbackReason, formatFallbackReason, getFallbackChainForRequest, type ProviderFallbackCategory } from '../../../model/modelRouterPolicy';
import { getProviderHealthMonitor } from '../../../model/providerHealthMonitor';
import { isFallbackEligible } from '../../../model/providers/retryStrategy';
import type { ContextAssemblyCtx } from './shared';
import { logger } from './shared';

export function formatFallbackEndpoint(target: { provider: string; model?: string }): string {
  return target.model ? `${target.provider}/${target.model}` : target.provider;
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getErrorCode(error: unknown): string | undefined {
  return typeof (error as NodeJS.ErrnoException | null)?.code === 'string'
    ? (error as NodeJS.ErrnoException).code
    : undefined;
}

export function getModelFallbackFromError(error: unknown): ModelFallbackInfo | undefined {
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

// ============================================================================
// 视觉预处理失败诊断（T7）：识图预处理链路对每个候选模型的失败分类 + 用户可见提示。
// 复用既有 provider fallback 的分类器/toast 通道，而非另起一套——见 modelRouterPolicy
// 的 classifyProviderFallbackReason（超时/限流/额度/认证/网络等）与 ProviderStatusNotice
// 的 provider:fallback toast 订阅。
// ============================================================================

export interface VisionPreflightAttempt {
  provider: string;
  model: string;
  category: ProviderFallbackCategory;
  detail: string;
}

/** 分类 + 落日志一步做完，调用点（inference.ts 的候选循环）只留一行。 */
export function classifyAndLogVisionPreflightFailure(
  provider: string,
  model: string,
  error: unknown,
): VisionPreflightAttempt {
  const message = getErrorMessage(error);
  const attempt: VisionPreflightAttempt = {
    provider,
    model,
    category: classifyProviderFallbackReason(message, getErrorCode(error)),
    detail: formatFallbackReason(message),
  };
  logger.warn(`[Fallback] 视觉预处理失败（${attempt.provider}/${attempt.model}, category=${attempt.category}）：${attempt.detail}，尝试下一个识图模型`);
  return attempt;
}

/**
 * 识图预处理全部未成功时的汇总日志——区分"零候选"（一个已配 Key 的识图模型都没有，
 * 2026-08-07 真机场景的实际根因）和"候选都配了但调用报错"，别再用同一句笼统文案盖过去。
 */
export function logVisionPreflightExhausted(hadCandidates: boolean, attempts: VisionPreflightAttempt[]): void {
  if (!hadCandidates) {
    logger.warn('[Fallback] 未找到已配置 API Key 的识图模型（零候选），图片将转换为文字描述');
    return;
  }
  logger.warn(`[Fallback] 所有已配置的识图模型预处理均失败或不可用（尝试了 ${attempts.length} 个：${attempts.map((a) => `${a.provider}/${a.model}[${a.category}]`).join(', ')}）`);
}

/**
 * 识图预处理全失败（含"零候选"——一个已配 Key 的识图模型都没有）时，给用户一条
 * 可见 toast。走已上线的 provider:fallback 通道（ProviderStatusNotice 订阅），
 * category 用 'vision_no_key' / 'vision_unavailable' 两个新值区分"零候选"和
 * "候选都报错了"，渲染侧据此给出不同文案（前者引导去设置配 Key，后者提示重试/查网络）。
 * from/to 都是当前主模型——vision 预处理不切换主模型，只是没能读到图。
 */
export async function broadcastVisionPreflightUnavailable(
  config: { provider: string; model: string },
  detail: { category: 'vision_no_key' | 'vision_unavailable'; attempts: VisionPreflightAttempt[] },
): Promise<void> {
  try {
    const { broadcastToRenderer } = await import('../../../platform/windowBridge');
    broadcastToRenderer?.('provider:fallback', {
      from: { provider: config.provider, model: config.model },
      to: { provider: config.provider, model: config.model },
      reason: detail.category,
      category: detail.category,
      tried: detail.attempts.map((attempt) => ({
        provider: attempt.provider,
        model: attempt.model,
        status: 'tried' as const,
        reason: 'vision_preflight_failed',
        category: attempt.category,
        detail: attempt.detail,
      })),
    });
  } catch {
    /* toast 是 best-effort，不影响主链路 */
  }
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
      if (!aiSdkSupportsProvider(fallback.provider, fallback.model)) {
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

export function emitModelFallbackNoticeFromResponse(
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
      turnId: ctx.runtime.turn.currentTurnId,
    },
  });
}
