// ============================================================================
// Model Router - Routes requests to different AI model providers
// ============================================================================

import type {
  ModelConfig,
  ToolDefinition,
  ModelCapability,
  ModelInfo,
  ModelProvider
} from '../../shared/types';
import { PROVIDER_REGISTRY } from './providerRegistry';
import { DEFAULT_PROVIDER, DEFAULT_MODEL, DEFAULT_MODELS } from '../../shared/constants';
import { createLogger } from '../services/infra/logger';
import { getInferenceCache } from './inferenceCache';
import { getAdaptiveRouter } from './adaptiveRouter';
import { getConfigService } from '../services/core/configService';

const logger = createLogger('ModelRouter');
import type { ModelMessage, ModelResponse, StreamCallback, MessageContent } from './types';
export { ContextLengthExceededError } from './types';

// Import provider implementations
import {
  callDeepSeek,
  callClaude,
  callOpenAI,
  callGroq,
  callLocal,
  callQwen,
  callMoonshot,
  callMinimax,
  callPerplexity,
  callGemini,
  callZhipu,
  callOpenRouter,
  callViaCloudProxy,
} from './providers';

// Re-export PROVIDER_REGISTRY for external use
export { PROVIDER_REGISTRY };

// ----------------------------------------------------------------------------
// Model Router
// ----------------------------------------------------------------------------

export class ModelRouter {
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
    // 压缩 - 默认主力包月无成本
    compact: { provider: DEFAULT_PROVIDER, model: DEFAULT_MODELS.compact },
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
      capability
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

    const fallbackModelInfo = this.getModelInfo(fallback.provider, fallback.model);
    return {
      ...originalConfig,
      provider: fallback.provider as ModelProvider,
      model: fallback.model,
      maxTokens: fallbackModelInfo?.maxTokens || 1024,
    };
  }

  /**
   * 查找同 provider 中支持指定能力的模型
   */
  private findSameProviderFallback(
    provider: ModelProvider,
    capability: ModelCapability
  ): string | null {
    const providerConfig = PROVIDER_REGISTRY[provider];
    if (!providerConfig) return null;

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
  }): Promise<{ content: string | null }> {
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

    return { content: response.content ?? null };
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
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    // Check for cancellation before starting
    if (signal?.aborted) {
      throw new Error('Request was cancelled before starting');
    }

    // 如果启用云端代理，走云端 model-proxy
    if (config.useCloudProxy) {
      const modelInfo = this.getModelInfo(config.provider, config.model);
      return callViaCloudProxy(messages, tools, config, modelInfo, onStream, signal);
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

    // Adaptive routing for simple tasks
    const adaptiveRouter = getAdaptiveRouter();
    const complexity = adaptiveRouter.estimateComplexity(messages);
    if (complexity.level === 'simple' && !config.useCloudProxy) {
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
            const result = await this._callProvider(messages, tools, adaptedConfig, onStream, signal);
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

    const result = await this._callProvider(messages, tools, config, onStream, signal);

    // Cache non-streaming text responses
    if (!onStream && result.type === 'text') {
      const cache = getInferenceCache();
      const cacheKey = cache.computeKey(messages, config);
      cache.set(cacheKey, result);
    }

    return result;
  }

  /**
   * Call the appropriate provider based on config
   */
  private async _callProvider(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const modelInfo = this.getModelInfo(config.provider, config.model);

    switch (config.provider) {
      case 'deepseek':
        return callDeepSeek(messages, tools, config, modelInfo, onStream, signal);
      case 'claude':
        return callClaude(messages, tools, config, onStream, signal);
      case 'openai':
        return callOpenAI(messages, tools, config, onStream, signal);
      case 'gemini':
        return callGemini(messages, tools, config, onStream, signal);
      case 'groq':
        return callGroq(messages, tools, config, modelInfo, onStream, signal);
      case 'local':
        return callLocal(messages, tools, config, onStream, signal);
      case 'zhipu':
        return callZhipu(messages, tools, config, modelInfo, PROVIDER_REGISTRY.zhipu, onStream, signal);
      case 'qwen':
        return callQwen(messages, tools, config, modelInfo, onStream, signal);
      case 'moonshot':
        return callMoonshot(messages, tools, config, onStream, signal);
      case 'minimax':
        return callMinimax(messages, tools, config, modelInfo, onStream, signal);
      case 'perplexity':
        return callPerplexity(messages, tools, config, onStream, signal);
      case 'openrouter':
        return callOpenRouter(messages, tools, config, modelInfo, onStream, signal);
      default:
        throw new Error(`Unsupported provider: ${config.provider}`);
    }
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
