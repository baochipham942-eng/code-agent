// ============================================================================
// Model Router - Routes requests to different AI model providers
// ============================================================================

import type {
  ModelConfig,
  ToolDefinition,
  ModelCapability,
  ModelInfo,
  ModelProvider
} from '../../shared/contract';
import { PROVIDER_REGISTRY } from './providerRegistry';
import { AGENT_DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_MODELS, PROVIDER_FALLBACK_CHAIN } from '../../shared/constants';
import { isFallbackEligible } from './providers/retryStrategy';
import { getModelMaxOutputTokens } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import { getInferenceCache } from './inferenceCache';
import { getAdaptiveRouter } from './adaptiveRouter';
import { getConfigService } from '../services/core/configService';
import { getProviderHealthMonitor } from './providerHealthMonitor';
import { needsArtifactTaskBrief } from '../prompts/artifactGeneration';
import { combineAbortSignals, createTimedAbortController } from '../agent/shutdownProtocol';

const logger = createLogger('ModelRouter');
import type { InferenceOptions, ModelMessage, ModelResponse, StreamCallback, MessageContent } from './types';
export { ContextLengthExceededError } from './types';

// Import provider implementations
import { callViaCloudProxy } from './providers';
import type { Provider } from './types';
import { MoonshotProvider } from './providers/moonshotProvider';
import { GroqProvider } from './providers/groqProvider';
import { QwenProvider } from './providers/qwenProvider';
import { MinimaxProvider } from './providers/minimaxProvider';
import { PerplexityProvider } from './providers/perplexityProvider';
import { LocalProvider } from './providers/localProvider';
import { OpenAIProvider } from './providers/openaiProvider';
import { DeepSeekProvider } from './providers/deepseekProvider';
import { OpenRouterProvider } from './providers/openrouterProvider';
import { ZhipuProvider } from './providers/zhipuProvider';
import { ClaudeProvider } from './providers/claudeProvider';
import { GeminiProvider } from './providers/geminiProvider';
import { VolcengineProvider } from './providers/volcengineProvider';
import { XiaomiProvider } from './providers/xiaomiProvider';

// Re-export PROVIDER_REGISTRY for external use
export { PROVIDER_REGISTRY };

// Reasoning-model 友好的 timeout 默认值。原 120s/45s/90s 在 MiMo Max 等
// 长 thinking 模型上会误杀。所有常量都支持同名 env 覆盖，无需重新打包。
function envTimeoutMs(name: string, defaultMs: number): number {
  const raw = typeof process !== 'undefined' ? process.env?.[name] : undefined;
  if (!raw) return defaultMs;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : defaultMs;
}
const ARTIFACT_PROVIDER_TIMEOUT_MS = envTimeoutMs('ARTIFACT_PROVIDER_TIMEOUT_MS', 1_200_000);
const ARTIFACT_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_FIRST_BYTE_TIMEOUT_MS', 60_000);
const ARTIFACT_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_INACTIVITY_TIMEOUT_MS', 480_000);
const ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS', 480_000);
const ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS', 60_000);
const ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS', 240_000);
const ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS', 600_000);
const ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS', 60_000);
const ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS', 360_000);
const ARTIFACT_REPAIR_WRITE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_TIMEOUT_MS', 900_000);
const ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS', 60_000);
const ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS = envTimeoutMs('ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS', 480_000);
const ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS = process.env.NODE_ENV === 'test'
  ? [0, 0]
  : [1_000, 2_500];
const PERSISTENT_PROVIDER_ERROR_PATTERN = /401|403|unauthorized|forbidden|incorrect api key|invalid[_ ]api[_ ]key|model_not_allowed|subscription plan does not include access|insufficient balance|余额不足/i;
const ARTIFACT_UNUSABLE_RESPONSE_PATTERN = /empty artifact response/i;

type ProviderFallbackCategory =
  | 'timeout'
  | 'rate_limit'
  | 'quota'
  | 'auth'
  | 'provider_unavailable'
  | 'network'
  | 'artifact_response'
  | 'model'
  | 'unknown';

// ----------------------------------------------------------------------------
// Model Router
// ----------------------------------------------------------------------------

export class ModelRouter {
  // --------------------------------------------------------------------------
  // Provider Registry (new Provider interface, incremental migration)
  // --------------------------------------------------------------------------

  private providers = new Map<string, Provider>([
    ['moonshot', new MoonshotProvider()],
    ['groq', new GroqProvider()],
    ['qwen', new QwenProvider()],
    ['minimax', new MinimaxProvider()],
    ['perplexity', new PerplexityProvider()],
    ['local', new LocalProvider()],
    ['openai', new OpenAIProvider()],
    ['deepseek', new DeepSeekProvider()],
    ['openrouter', new OpenRouterProvider()],
    ['zhipu', new ZhipuProvider()],
    ['claude', new ClaudeProvider()],
    ['anthropic', new ClaudeProvider()],
    ['gemini', new GeminiProvider()],
    ['volcengine', new VolcengineProvider()],
    ['xiaomi', new XiaomiProvider()],
  ]);

  private recordProviderHardFailure(provider: string): void {
    getProviderHealthMonitor().recordFailure(provider);
    getProviderHealthMonitor().recordFailure(provider);
    getProviderHealthMonitor().recordFailure(provider);
  }

  private classifyProviderFallbackReason(message: string, code?: string): ProviderFallbackCategory {
    const normalized = `${message} ${code || ''}`.toLowerCase();
    if (/timeout|timed out|etimedout|first-byte timeout|inactivity timeout/.test(normalized)) return 'timeout';
    if (/429|rate.?limit|too many requests|requests per minute/.test(normalized)) return 'rate_limit';
    if (/402|insufficient[_ ]quota|insufficient balance|payment required|quota exceeded|billing|credit|余额不足/.test(normalized)) return 'quota';
    if (/401|403|unauthorized|forbidden|invalid[_ ]api[_ ]key|invalid token|authentication/.test(normalized)) return 'auth';
    if (/no available accounts|503|502|504|service unavailable|bad gateway|gateway timeout|overloaded|capacity/.test(normalized)) return 'provider_unavailable';
    if (/econnreset|econnrefused|enotfound|eai_again|socket hang up|socket disconnected|secure tls connection|network request failed|network error|fetch failed/.test(normalized)) return 'network';
    if (ARTIFACT_UNUSABLE_RESPONSE_PATTERN.test(message)) return 'artifact_response';
    if (/model_not_allowed|model.*(?:deprecated|decommissioned|retired|not found|does not exist)/.test(normalized)) return 'model';
    return 'unknown';
  }

  private formatFallbackReason(message: string): string {
    return message.split('\n')[0]?.slice(0, 240) || 'unknown';
  }

  // --------------------------------------------------------------------------
  // Public Methods
  // --------------------------------------------------------------------------

  /**
   * 根据能力需求选择最佳模型
   */
  selectModelByCapability(
    capability: ModelCapability,
    availableProviders: string[]
  ): { provider: string; model: string } | null {
    for (const providerId of availableProviders) {
      const provider = PROVIDER_REGISTRY[providerId];
      if (!provider) continue;

      const model = provider.models.find((m) =>
        m.capabilities.includes(capability)
      );
      if (model) {
        return { provider: providerId, model: model.id };
      }
    }
    return null;
  }

  /**
   * 获取模型信息
   */
  getModelInfo(provider: string, modelId: string): ModelInfo | null {
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) return null;
    return providerConfig.models.find((m) => m.id === modelId) || null;
  }

  /**
   * 能力补充配置 - 当主模型缺少某能力时，使用哪个备用模型
   * 优先使用包年/包月模型，节省按量付费成本
   */
  private fallbackModels: Record<ModelCapability, { provider: string; model: string }> = {
    // 视觉 - 智谱 GLM-4.6V (旗舰视觉)
    vision: { provider: 'zhipu', model: DEFAULT_MODELS.vision },
    // 推理 - 智谱 GLM-4.6V (带推理能力)
    reasoning: { provider: 'zhipu', model: DEFAULT_MODELS.vision },
    // 代码 - 默认主力包月
    code: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.code },
    // 快速 - 智谱 GLM-4.7 Flash (免费)
    fast: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
    // 通用 - 默认主力包月
    general: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.chat },
    // GUI - 智谱 GLM-4.6V Flash (免费视觉)
    gui: { provider: 'zhipu', model: DEFAULT_MODELS.visionFast },
    // 搜索 - Perplexity (按需)
    search: { provider: 'perplexity', model: 'sonar-pro' },
    // 压缩 - Kimi 需要走 Moonshot provider，不能和 DEFAULT_PROVIDER 机械拼接
    compact: { ...AGENT_DEFAULT_MODEL },
    // 快速判断 - 智谱 GLM-4.7 Flash (免费)
    quick: { provider: 'zhipu', model: DEFAULT_MODELS.quick },
    // 长上下文 - 默认主力包月
    longContext: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.longContext },
    // 无限制 - 默认主力包月
    unlimited: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.unlimited },
  };

  /**
   * 设置能力补充的备用模型
   */
  setFallbackModel(capability: ModelCapability, provider: string, model: string): void {
    this.fallbackModels[capability] = { provider, model };
  }

  /**
   * 获取备用模型配置
   */
  getFallbackConfig(
    capability: ModelCapability,
    originalConfig: ModelConfig
  ): ModelConfig | null {
    // 1. 优先检查当前 provider 是否有支持该能力的模型
    const sameProviderModel = this.findSameProviderFallback(
      originalConfig.provider,
      capability,
      originalConfig.model
    );
    if (sameProviderModel) {
      logger.debug(`使用同 provider (${originalConfig.provider}) 的 ${capability} 模型: ${sameProviderModel}`);
      const fallbackModelInfo = this.getModelInfo(originalConfig.provider, sameProviderModel);
      return {
        ...originalConfig,
        model: sameProviderModel,
        maxTokens: fallbackModelInfo?.maxTokens || 1024,
      };
    }

    // 2. 使用默认 fallback 配置
    const fallback = this.fallbackModels[capability];
    if (!fallback) return null;

    logger.debug(`使用默认 fallback: ${fallback.provider}/${fallback.model}`);

    const fallbackProvider = fallback.provider as ModelProvider;
    const fallbackModelInfo = this.getModelInfo(fallbackProvider, fallback.model);
    const providerSettings = this.getProviderSettings(fallbackProvider);
    return {
      ...originalConfig,
      provider: fallbackProvider,
      model: fallback.model,
      apiKey: getConfigService().getApiKey(fallbackProvider),
      baseUrl: providerSettings?.baseUrl,
      maxTokens: fallbackModelInfo?.maxTokens || 1024,
    };
  }

  private getProviderSettings(provider: ModelProvider): { baseUrl?: string } | undefined {
    try {
      return getConfigService().getSettings().models?.providers?.[provider];
    } catch {
      return undefined;
    }
  }

  private getArtifactWriteRequiredPreferredConfig(
    messages: ModelMessage[],
    config: ModelConfig,
  ): ModelConfig | null {
    if (!this.hasArtifactFileWriteRequiredMarker(messages)) return null;
    if (this.isArtifactLikeRequest(messages)) return null;

    const chain = this.getFallbackChainForRequest(messages, config.provider);
    if (!chain || chain.length === 0) return null;

    for (const fallback of chain) {
      const fallbackProvider = fallback.provider as ModelProvider;
      const fallbackHealth = getProviderHealthMonitor().getHealth(fallback.provider);
      if (fallbackHealth?.status === 'unavailable') continue;

      const apiKey = getConfigService().getApiKey(fallbackProvider);
      if (!apiKey) continue;

      logger.info(
        `[ModelRouter] Artifact write-required follow-up detected; preferring ${fallback.provider}/${fallback.model} over ${config.provider}/${config.model}`
      );

      return {
        ...config,
        provider: fallbackProvider,
        model: fallback.model,
        apiKey,
        maxTokens: getModelMaxOutputTokens(fallback.model),
      };
    }

    return null;
  }

  private getFallbackChainForRequest(
    messages: ModelMessage[],
    provider: ModelProvider,
  ): Array<{ provider: string; model: string }> {
    const chain = PROVIDER_FALLBACK_CHAIN[provider];
    if (!chain || chain.length === 0) return [];
    if (!this.isArtifactLikeRequest(messages)) return chain;

    const artifactPriority = new Map([
      ['zhipu', 0],
      ['deepseek', 1],
      ['openai', 2],
      ['moonshot', 3],
    ]);

    return [...chain].sort((a, b) => {
      const aRank = artifactPriority.get(a.provider) ?? 99;
      const bRank = artifactPriority.get(b.provider) ?? 99;
      return aRank - bRank;
    });
  }

  /**
   * 查找同 provider 中支持指定能力的模型
   */
  private findSameProviderFallback(
    provider: ModelProvider,
    capability: ModelCapability,
    originalModel?: string
  ): string | null {
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) return null;

    if (capability === 'compact') {
      const currentModel = providerConfig.models.find((m) => m.id === originalModel);
      if (currentModel && this.canSummarizeForCompaction(currentModel)) {
        return currentModel.id;
      }
      return null;
    }

    const capabilityToFlag: Partial<Record<ModelCapability, keyof typeof providerConfig.models[0]>> = {
      vision: 'supportsVision',
    };

    const flag = capabilityToFlag[capability];
    if (!flag) return null;

    // 排除不支持 base64 的模型（如 glm-4.6v-flash）
    const supportingModels = providerConfig.models.filter(
      (m) => m[flag] === true && m.id !== DEFAULT_MODELS.visionFast
    );

    if (supportingModels.length === 0) return null;

    // 优先返回快速/便宜模型
    const fastModel = supportingModels.find(
      (m) =>
        m.id.toLowerCase().includes('flash') ||
        m.id.toLowerCase().includes('fast') ||
        m.id.toLowerCase().includes('mini')
    );

    return fastModel?.id || supportingModels[0].id;
  }

  private canSummarizeForCompaction(model: ModelInfo): boolean {
    return model.supportsStreaming !== false && model.capabilities.some((capability) =>
      capability === 'general' ||
      capability === 'code' ||
      capability === 'longContext' ||
      capability === 'unlimited'
    );
  }

  /**
   * 检测消息内容是否需要特定能力
   */
  detectRequiredCapabilities(messages: ModelMessage[]): ModelCapability[] {
    const capabilities: Set<ModelCapability> = new Set();

    for (const msg of messages) {
      const content = typeof msg.content === 'string' ? msg.content : '';
      const contentLower = content.toLowerCase();

      // 检测视觉需求
      if (Array.isArray(msg.content)) {
        const hasImage = msg.content.some((c) => c.type === 'image');
        if (hasImage) {
          const annotationKeywords = ['框', '圈', '标注', '标记', '画', 'annotate', 'mark', 'highlight', 'box'];
          const isAnnotationRequest = annotationKeywords.some(kw => contentLower.includes(kw));

          if (!isAnnotationRequest) {
            capabilities.add('vision');
          }
        }
      }

      // 检测推理需求
      if (contentLower.includes('深度推理') ||
          contentLower.includes('think step by step') ||
          contentLower.includes('逐步推导') ||
          contentLower.includes('数学证明') ||
          contentLower.includes('逻辑推理')) {
        capabilities.add('reasoning');
      }
    }

    return Array.from(capabilities);
  }

  /**
   * 简便方法：纯文本对话（无工具调用）
   */
  async chat(options: {
    provider: ModelProvider;
    model: string;
    messages: Array<{ role: string; content: string }>;
    maxTokens?: number;
  }): Promise<{ content: string | null; finishReason?: string }> {
    const apiKey = getConfigService().getApiKey(options.provider);
    const config: ModelConfig = {
      provider: options.provider,
      model: options.model,
      maxTokens: options.maxTokens ?? 2000,
      apiKey,
    };

    const response = await this.inference(
      options.messages as ModelMessage[],
      [],
      config
    );

    return { content: response.content ?? null, finishReason: response.finishReason };
  }

  /**
   * 主推理入口
   * @param signal - AbortSignal for cancellation support (allows interrupting API calls)
   */
  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    const normalizedOptions = this.normalizeInferenceOptions(messages, onStream, options);

    // Check for cancellation before starting
    if (signal?.aborted) {
      throw new Error('Request was cancelled before starting');
    }

    // 如果启用云端代理，走云端 model-proxy
    if (config.useCloudProxy) {
      const modelInfo = this.getModelInfo(config.provider, config.model);
      return callViaCloudProxy(messages, tools, config, modelInfo, onStream, signal, normalizedOptions);
    }

    // Inference cache (non-streaming only)
    if (!onStream) {
      const cache = getInferenceCache();
      const cacheKey = cache.computeKey(messages, config);
      const cached = cache.get(cacheKey);
      if (cached) {
        logger.info(`[Cache] Hit for ${config.provider}/${config.model}`);
        return cached;
      }
    }

    // Adaptive routing for simple tasks — 仅在用户选了"自动"时启用
    const adaptiveRouter = getAdaptiveRouter();
    const complexity = adaptiveRouter.estimateComplexity(messages);
    if (config.adaptive === true && complexity.level === 'simple' && !config.useCloudProxy) {
      const adaptedConfig = adaptiveRouter.selectModel(complexity, config);
      if (adaptedConfig.provider !== config.provider || adaptedConfig.model !== config.model) {
        // 切换 provider 时需要获取对应的 apiKey
        let canUseFreeModel = true;
        if (adaptedConfig.provider !== config.provider) {
          const adaptedApiKey = getConfigService().getApiKey(adaptedConfig.provider);
          if (!adaptedApiKey) {
            adaptiveRouter.disableFreeModel(`no API key for ${adaptedConfig.provider}`);
            canUseFreeModel = false;
          } else {
            adaptedConfig.apiKey = adaptedApiKey;
          }
        }
        if (canUseFreeModel) {
          try {
            const result = await this._callProviderWithArtifactFallback(messages, tools, adaptedConfig, onStream, signal, normalizedOptions);
            this.assertUsableArtifactResponse(messages, result, adaptedConfig);
            adaptiveRouter.recordOutcome(complexity, adaptedConfig.provider, true, 0);
            // Cache non-streaming text responses
            if (!onStream && result.type === 'text') {
              const cache = getInferenceCache();
              const cacheKey = cache.computeKey(messages, config);
              cache.set(cacheKey, result);
            }
            return result;
          } catch (err) {
            const errMsg = err instanceof Error ? err.message : String(err);
            // 401/403 是持久性错误（key 过期/无效），禁用 free model 避免重复失败
            if (/401|403|unauthorized|forbidden/i.test(errMsg)) {
              adaptiveRouter.disableFreeModel(errMsg.split('\n')[0]);
            } else {
              logger.warn(`[AdaptiveRouter] Free model failed, falling back to default: ${errMsg.split('\n')[0]}`);
            }
            adaptiveRouter.recordOutcome(complexity, adaptedConfig.provider, false, 0);
            // Fall through to default provider
          }
        }
      }
    }

    const effectiveConfig = this.getArtifactWriteRequiredPreferredConfig(messages, config) ?? config;

    try {
      const result = await this._callProviderWithArtifactFallback(messages, tools, effectiveConfig, onStream, signal, normalizedOptions);
      this.assertUsableArtifactResponse(messages, result, effectiveConfig);

      // Cache non-streaming text responses
      if (!onStream && result.type === 'text') {
        const cache = getInferenceCache();
        const cacheKey = cache.computeKey(messages, effectiveConfig);
        cache.set(cacheKey, result);
      }

      return result;
    } catch (primaryErr) {
      // ---- Cross-provider fallback chain ----
      const errMsg = primaryErr instanceof Error ? primaryErr.message : String(primaryErr);
      const errCode = (primaryErr as NodeJS.ErrnoException).code;

      if (PERSISTENT_PROVIDER_ERROR_PATTERN.test(errMsg) || ARTIFACT_UNUSABLE_RESPONSE_PATTERN.test(errMsg)) {
        this.recordProviderHardFailure(effectiveConfig.provider);
      }

      if (!isFallbackEligible(errMsg, errCode)) {
        throw primaryErr;
      }

      const fallbackCategory = this.classifyProviderFallbackReason(errMsg, errCode);
      const fallbackReason = this.formatFallbackReason(errMsg);
      const artifactLikeRequest = this.isArtifactLikeRequest(messages);
      const artifactRepairActive = normalizedOptions?.artifactRepairActive === true;

      if (
        artifactRepairActive
        && artifactLikeRequest
        && !this.shouldRetrySelectedArtifactProvider(fallbackCategory, normalizedOptions)
      ) {
        logger.warn(
          `[ModelRouter] Artifact repair failed with non-transient ${fallbackCategory}; keeping selected provider/model: ${fallbackReason}`
        );
        throw primaryErr;
      }

      if (this.shouldKeepArtifactRequestOnSelectedProvider(messages, fallbackCategory)) {
        const selectedProviderRetry = await this.retrySelectedProviderForArtifactTransient(
          messages,
          tools,
          effectiveConfig,
          fallbackCategory,
          onStream,
          signal,
          normalizedOptions,
        );
        if (selectedProviderRetry) {
          return selectedProviderRetry;
        }

        if (!this.shouldAllowArtifactFallbackAfterSelectedRetry(fallbackCategory, normalizedOptions)) {
          logger.warn(
            `[ModelRouter] Provider ${effectiveConfig.provider} hit artifact transient error; keeping selected provider/model instead of cross-provider fallback: ${fallbackReason}`
          );
          throw primaryErr;
        }

        logger.warn(
          `[ModelRouter] Selected artifact provider retry exhausted; allowing cross-provider fallback for ${fallbackCategory}: ${fallbackReason}`
        );
      }

      const chain = this.getFallbackChainForRequest(messages, effectiveConfig.provider);
      if (!chain || chain.length === 0) {
        throw primaryErr;
      }

      logger.warn(
        `[ModelRouter] Provider ${effectiveConfig.provider} fallback triggered (${fallbackCategory}): ${fallbackReason}`
      );

      for (const fallback of chain) {
        // Skip providers that are known to be unavailable
        const fallbackHealth = getProviderHealthMonitor().getHealth(fallback.provider);
        if (fallbackHealth?.status === 'unavailable') {
          logger.warn(`[ModelRouter] Skipping unavailable fallback: ${fallback.provider}`);
          continue;
        }

        const fallbackApiKey = getConfigService().getApiKey(fallback.provider as ModelProvider);
        if (!fallbackApiKey) continue;

        const fallbackConfig: ModelConfig = {
          ...effectiveConfig,
          provider: fallback.provider as ModelProvider,
          model: fallback.model,
          apiKey: fallbackApiKey,
          maxTokens: getModelMaxOutputTokens(fallback.model),
        };

        try {
          logger.warn(
            `[ModelRouter] Fallback → ${fallback.provider}/${fallback.model} (reason=${fallbackCategory})`
          );
          const result = await this._callProviderWithArtifactFallback(messages, tools, fallbackConfig, onStream, signal, normalizedOptions);
          this.assertUsableArtifactResponse(messages, result, fallbackConfig);
          const fallbackMetadata = {
            from: { provider: effectiveConfig.provider, model: effectiveConfig.model },
            to: { provider: fallback.provider, model: fallback.model },
            reason: fallbackReason,
            category: fallbackCategory,
          };
          result.actualProvider = fallback.provider;
          result.actualModel = fallback.model;
          result.fallback = fallbackMetadata;

          // Cache non-streaming text responses
          if (!onStream && result.type === 'text') {
            const cache = getInferenceCache();
            const cacheKey = cache.computeKey(messages, effectiveConfig);
            cache.set(cacheKey, result);
          }

          // Notify renderer about the fallback switch
          try {
            const { broadcastToRenderer } = await import('../platform/windowBridge');
            broadcastToRenderer?.('provider:fallback', {
              from: { provider: effectiveConfig.provider, model: effectiveConfig.model },
              to: { provider: fallback.provider, model: fallback.model },
              reason: fallbackReason,
              category: fallbackCategory,
            });
          } catch { /* push failure must not affect main flow */ }

          return result;
        } catch (fallbackErr) {
          const fbMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
          if (PERSISTENT_PROVIDER_ERROR_PATTERN.test(fbMsg) || ARTIFACT_UNUSABLE_RESPONSE_PATTERN.test(fbMsg)) {
            this.recordProviderHardFailure(fallback.provider);
          }
          logger.warn(`[ModelRouter] Fallback ${fallback.provider} failed: ${fbMsg.split('\n')[0]}`);
          continue;
        }
      }

      // All fallbacks exhausted
      throw primaryErr;
    }
  }

  /**
   * Call the appropriate provider based on config
   */
  private async _callProvider(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    const provider = this.providers.get(config.provider);
    if (!provider) {
      throw new Error(`Unsupported provider: ${config.provider}`);
    }
    const timeoutMs = options?.requestTimeoutMs;
    const timedAbort = typeof timeoutMs === 'number' && timeoutMs > 0
      ? createTimedAbortController(timeoutMs, { label: `model-router:${config.provider}/${config.model}` })
      : null;
    const combined = timedAbort
      ? signal
        ? combineAbortSignals(signal, timedAbort.controller.signal)
        : timedAbort.controller
      : null;
    const effectiveSignal = combined?.signal ?? signal;
    try {
      if (effectiveSignal?.aborted) {
        throw new Error('Request was cancelled before starting');
      }
      return await provider.inference(messages, tools, config, onStream, effectiveSignal, options);
    } catch (error) {
      if (timedAbort?.controller.signal.aborted && !signal?.aborted) {
        throw new Error(`${config.provider} request timeout after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      timedAbort?.cleanup();
    }
  }

  private async _callProviderWithArtifactFallback(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    try {
      return await this._callProvider(messages, tools, config, onStream, signal, options);
    } catch (err) {
      if (!this.shouldRetryArtifactNonStreaming(messages, err, onStream, signal, options)) {
        throw err;
      }

      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(
        `[ModelRouter] Artifact stream failed on ${config.provider}/${config.model}; retrying once with non-streaming: ${errMsg.split('\n')[0]}`
      );

      return this._callProvider(
        messages,
        tools,
        config,
        undefined,
        signal,
        {
          ...options,
          forceNonStreaming: true,
          disableProviderTransientRetry: true,
        },
      );
    }
  }

  private shouldRetryArtifactNonStreaming(
    messages: ModelMessage[],
    err: unknown,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): boolean {
    if (!onStream) return false;
    if (signal?.aborted) return false;
    if (options?.forceNonStreaming === true) return false;
    if (!this.isArtifactLikeRequest(messages)) return false;
    if (this.hasArtifactRepairToolBlockedMarker(messages)) return false;

    const errMsg = err instanceof Error ? err.message : String(err);
    return /stream inactivity timeout|first-byte timeout|流式响应无内容|stream ended before \[DONE\]|refusing to execute incomplete tool arguments|invalid streamed tool arguments/i.test(errMsg);
  }

  private shouldKeepArtifactRequestOnSelectedProvider(
    messages: ModelMessage[],
    fallbackCategory: ProviderFallbackCategory,
  ): boolean {
    if (!this.isArtifactLikeRequest(messages)) return false;
    return fallbackCategory !== 'quota'
      && fallbackCategory !== 'auth'
      && fallbackCategory !== 'model'
      && fallbackCategory !== 'artifact_response';
  }

  private shouldRetrySelectedArtifactProvider(
    fallbackCategory: ProviderFallbackCategory,
    options?: InferenceOptions,
  ): boolean {
    return fallbackCategory === 'provider_unavailable'
      || fallbackCategory === 'network'
      || fallbackCategory === 'rate_limit'
      || (fallbackCategory === 'timeout' && options?.artifactRepairActive === true);
  }

  private shouldAllowArtifactFallbackAfterSelectedRetry(
    fallbackCategory: ProviderFallbackCategory,
    options?: InferenceOptions,
  ): boolean {
    return options?.artifactRepairActive === true
      && this.shouldRetrySelectedArtifactProvider(fallbackCategory, options);
  }

  private async retrySelectedProviderForArtifactTransient(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    fallbackCategory: ProviderFallbackCategory,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse | null> {
    if (!this.shouldRetrySelectedArtifactProvider(fallbackCategory, options)) return null;
    if (signal?.aborted) return null;

    for (let attempt = 0; attempt < ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS.length; attempt++) {
      const delay = ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS[attempt];
      logger.warn(
        `[ModelRouter] Retrying selected artifact provider ${config.provider}/${config.model} after transient ${fallbackCategory} (${attempt + 1}/${ARTIFACT_SELECTED_PROVIDER_RETRY_DELAYS_MS.length})`
      );

      await new Promise((resolve) => setTimeout(resolve, delay));
      if (signal?.aborted) return null;

      try {
        return await this._callProviderWithArtifactFallback(messages, tools, config, onStream, signal, options);
      } catch (retryErr) {
        const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
        const retryCode = (retryErr as NodeJS.ErrnoException).code;
        const retryCategory = this.classifyProviderFallbackReason(retryMsg, retryCode);
        logger.warn(
          `[ModelRouter] Selected artifact provider retry ${attempt + 1} failed: ${retryMsg.split('\n')[0]}`
        );
        if (!this.shouldRetrySelectedArtifactProvider(retryCategory, options)) {
          throw retryErr;
        }
      }
    }

    return null;
  }

  private normalizeInferenceOptions(
    messages: ModelMessage[],
    onStream?: StreamCallback,
    options?: InferenceOptions,
  ): InferenceOptions | undefined {
    if (options?.artifactRepairActive === true && options?.forceNonStreaming !== true) {
      const writePriority = options?.artifactRepairWritePriority === true;
      const fullRewritePriority = options?.artifactRepairFullRewritePriority === true;
      logger.info(fullRewritePriority
        ? '[ModelRouter] Runtime artifact repair full-rewrite guard active; preferring non-streaming inference with artifact timeout'
        : writePriority
          ? '[ModelRouter] Runtime artifact repair write-priority guard active; preferring non-streaming inference with targeted write timeout'
          : '[ModelRouter] Runtime artifact repair guard active; preferring non-streaming inference with shorter timeout');
      return {
        ...options,
        forceNonStreaming: true,
        disableProviderTransientRetry: true,
        requestTimeoutMs: options?.requestTimeoutMs ?? (
          fullRewritePriority
            ? ARTIFACT_REPAIR_WRITE_TIMEOUT_MS
            : writePriority
              ? ARTIFACT_REPAIR_TARGETED_WRITE_TIMEOUT_MS
              : ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS
        ),
        firstByteTimeoutMs: options?.firstByteTimeoutMs ?? (
          fullRewritePriority
            ? ARTIFACT_REPAIR_WRITE_FIRST_BYTE_TIMEOUT_MS
            : writePriority
              ? ARTIFACT_REPAIR_TARGETED_WRITE_FIRST_BYTE_TIMEOUT_MS
              : ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS
        ),
        inactivityTimeoutMs: options?.inactivityTimeoutMs ?? (
          fullRewritePriority
            ? ARTIFACT_REPAIR_WRITE_INACTIVITY_TIMEOUT_MS
            : writePriority
              ? ARTIFACT_REPAIR_TARGETED_WRITE_INACTIVITY_TIMEOUT_MS
              : ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS
        ),
      };
    }

    if (this.hasArtifactRepairToolBlockedMarker(messages)) {
      logger.info('[ModelRouter] Artifact repair blocked-tool recovery detected; using shorter streaming timeout');
      return {
        ...options,
        disableProviderTransientRetry: true,
        requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
        firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
        inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
      };
    }

    if (this.hasArtifactValidationFailureMarker(messages)) {
      logger.info('[ModelRouter] Artifact validation repair turn detected; preferring non-streaming inference with shorter timeout');
      return {
        ...options,
        forceNonStreaming: true,
        disableProviderTransientRetry: true,
        requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
        firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
        inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
      };
    }

    if (this.hasExplicitArtifactRepairIntent(messages)) {
      logger.info('[ModelRouter] Explicit artifact repair turn detected; preferring non-streaming inference with shorter timeout');
      return {
        ...options,
        forceNonStreaming: true,
        disableProviderTransientRetry: true,
        requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_TIMEOUT_MS,
        firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_FIRST_BYTE_TIMEOUT_MS,
        inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_REPAIR_RECOVERY_INACTIVITY_TIMEOUT_MS,
      };
    }

    if (this.shouldPreferNonStreamingArtifactFileTurn(messages, onStream, options)) {
      // v2 streaming-first: 保持 SSE chunk 不断流，避开上游网关对长 non-streaming 响应的 ~168s 硬超时（实测 Xiaomi sgp）。
      // tool-arg 解析失败时由 _callProviderWithArtifactFallback 接住，自动退到 forceNonStreaming 重试一次。
      logger.info('[ModelRouter] Artifact file-generation turn detected; v2 streaming-first (non-streaming fallback on tool-arg parse error)');
      return {
        ...options,
        disableProviderTransientRetry: true,
        requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
        firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
        inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
      };
    }

    const shouldDisableProviderRetry =
      Boolean(onStream) &&
      options?.forceNonStreaming !== true &&
      this.isArtifactLikeRequest(messages);

    if (!this.shouldPreferNonStreamingArtifactTurn(messages, onStream, options)) {
      return shouldDisableProviderRetry
        ? {
            ...options,
            disableProviderTransientRetry: true,
            requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
            firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
            inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
          }
        : options;
    }

    // v2 streaming-first（同 file-generation turn）：保持 SSE 流不断，避开网关 ~168s 硬超时。
    logger.info('[ModelRouter] Artifact follow-up turn detected; v2 streaming-first (non-streaming fallback on tool-arg parse error)');
    return {
      ...options,
      disableProviderTransientRetry: true,
      requestTimeoutMs: options?.requestTimeoutMs ?? ARTIFACT_PROVIDER_TIMEOUT_MS,
      firstByteTimeoutMs: options?.firstByteTimeoutMs ?? ARTIFACT_FIRST_BYTE_TIMEOUT_MS,
      inactivityTimeoutMs: options?.inactivityTimeoutMs ?? ARTIFACT_INACTIVITY_TIMEOUT_MS,
    };
  }

  private assertUsableArtifactResponse(
    messages: ModelMessage[],
    response: ModelResponse,
    config: ModelConfig,
  ): void {
    if (!this.isArtifactLikeRequest(messages)) return;
    if (!this.isEmptyTextResponse(response)) return;

    throw new Error(
      `empty artifact response from ${config.provider}/${config.model}: model returned no text and no tool calls for an artifact request`
    );
  }

  private isEmptyTextResponse(response: ModelResponse): boolean {
    if (response.type !== 'text') return false;
    if (response.toolCalls && response.toolCalls.length > 0) return false;
    return !response.content || response.content.trim().length === 0;
  }

  private isArtifactLikeRequest(messages: ModelMessage[]): boolean {
    if (this.hasArtifactRepairContextMarker(messages)) return true;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;

      const text = this.extractMessageText(message);
      if (needsArtifactTaskBrief(text)) return true;
    }
    return false;
  }

  private hasArtifactRepairContextMarker(messages: ModelMessage[]): boolean {
    return messages.some((message) => {
      const text = this.extractMessageText(message);
      return text.includes('<artifact-validation-failed')
        || text.includes('<artifact-repair-')
        || text.includes('<tool-admission-repair>')
        || text.includes('Artifact validation failed for ');
    });
  }

  private shouldPreferNonStreamingArtifactFileTurn(
    messages: ModelMessage[],
    onStream?: StreamCallback,
    options?: InferenceOptions,
  ): boolean {
    if (!onStream) return false;
    if (options?.forceNonStreaming === true) return false;
    if (!this.isArtifactLikeRequest(messages)) return false;
    return this.hasExplicitFileArtifactIntent(messages);
  }

  private hasArtifactRepairToolBlockedMarker(messages: ModelMessage[]): boolean {
    return messages.some((message) => {
      if (message.role !== 'system' && message.role !== 'tool') return false;
      const text = this.extractMessageText(message);
      return text.includes('<artifact-repair-recovery>')
        || text.includes('<artifact-repair-admission-blocked>')
        || text.includes('<artifact-repair-tool-blocked>');
    });
  }

  private hasArtifactValidationFailureMarker(messages: ModelMessage[]): boolean {
    return messages.some((message) => {
      if (message.role !== 'system' && message.role !== 'tool') return false;
      const text = this.extractMessageText(message);
      return text.includes('<artifact-validation-failed');
    });
  }

  private hasExplicitFileArtifactIntent(messages: ModelMessage[]): boolean {
    const explicitFileIntentPattern = /保存到|写到|写入|输出到|生成到|单文件|single[-\s]?file|\.html\b|\.tsx?\b|\.jsx?\b|\.css\b|\.md\b|\/[\w.-]+|\\[\w .-]+|file path|save (it )?to|write (it )?to/i;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user' && message.role !== 'system') continue;
      const text = this.extractMessageText(message);
      if (!text) continue;
      if (text.includes('<artifact-file-write-required>')) return true;
      if (message.role === 'user' && explicitFileIntentPattern.test(text)) return true;
    }

    return false;
  }

  private hasExplicitArtifactRepairIntent(messages: ModelMessage[]): boolean {
    const repairIntentPattern = /\b(fix|repair|patch|correct|restore)\b|修复|修正|修好|改好|失败|不通过|报错|不过/i;
    const artifactTargetPattern = /\b\w[\w.-]*\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)\b|\/[\w .@-]+\/[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)|\\[\w .@-]+\\[\w .@-]+\.(html|tsx?|jsx?|css|md|json|csv|xlsx?|pptx?|docx?)/i;

    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'user') continue;
      const text = this.extractMessageText(message);
      if (!text) continue;
      if (repairIntentPattern.test(text) && artifactTargetPattern.test(text)) return true;
    }

    return false;
  }

  private hasArtifactFileWriteRequiredMarker(messages: ModelMessage[]): boolean {
    return messages.some((message) =>
      message.role === 'system' &&
      this.extractMessageText(message).includes('<artifact-file-write-required>')
    );
  }

  private shouldPreferNonStreamingArtifactTurn(
    messages: ModelMessage[],
    onStream?: StreamCallback,
    options?: InferenceOptions,
  ): boolean {
    if (!onStream) return false;
    if (options?.forceNonStreaming === true) return false;
    if (!this.isArtifactLikeRequest(messages)) return false;
    if (!this.hasToolResultContext(messages)) return false;
    return this.hasIncompleteArtifactToolStream(messages);
  }

  private hasToolResultContext(messages: ModelMessage[]): boolean {
    return messages.some((message) => message.role === 'tool');
  }

  private hasIncompleteArtifactToolStream(messages: ModelMessage[]): boolean {
    for (let i = messages.length - 1; i >= 0; i -= 1) {
      const message = messages[i];
      if (message.role !== 'tool') continue;

      const content = this.extractMessageText(message).toLowerCase();
      return (
        content.includes('stream ended before [done]') ||
        content.includes('invalid streamed tool arguments') ||
        content.includes('refusing to execute incomplete tool arguments') ||
        content.includes('工具参数不完整') ||
        content.includes('代码完整性警告')
      );
    }
    return false;
  }

  private extractMessageText(message: ModelMessage): string {
    if (typeof message.content === 'string') return message.content;
    return message.content
      .filter((part) => part.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('\n');
  }

  /**
   * 带视觉能力的推理
   */
  async inferenceWithVision(
    messages: ModelMessage[],
    images: Array<{ data: string; mediaType: string }>,
    config: ModelConfig,
    onStream?: StreamCallback
  ): Promise<ModelResponse> {
    const modelInfo = this.getModelInfo(config.provider, config.model);
    if (!modelInfo?.supportsVision) {
      throw new Error(`Model ${config.model} does not support vision`);
    }

    // 构建带图片的消息
    const lastMessage = messages[messages.length - 1];
    if (lastMessage && typeof lastMessage.content === 'string') {
      const content: MessageContent[] = [
        { type: 'text', text: lastMessage.content },
        ...images.map((img) => ({
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: img.mediaType,
            data: img.data,
          },
        })),
      ];
      messages[messages.length - 1] = { ...lastMessage, content };
    }

    return this.inference(messages, [], config, onStream);
  }
}
