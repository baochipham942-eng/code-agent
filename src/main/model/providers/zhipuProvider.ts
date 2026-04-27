// ============================================================================
// ZhipuProvider - 智谱 GLM API Provider 实现
// 包含自适应限流器，防止并发过高触发限流
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { InferenceOptions, ModelMessage, ModelResponse, StreamCallback } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS, getModelMaxOutputTokens } from '../../../shared/constants';
import { PROVIDER_REGISTRY } from '../providerRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('ZhipuProvider');

// ============================================================================
// 智谱 API 限流器 - 防止并发过高触发限流
// ============================================================================

class ZhipuRateLimiter {
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private activeRequests = 0;
  private maxConcurrent: number;
  private readonly initialMaxConcurrent: number;
  private readonly minInterval: number;
  private lastRequestTime = 0;
  private lastRateLimitTime = 0;

  constructor(maxConcurrent = 3, minIntervalMs = 200) {
    this.maxConcurrent = maxConcurrent;
    this.initialMaxConcurrent = maxConcurrent;
    this.minInterval = minIntervalMs;
  }

  onRateLimit(): void {
    if (this.maxConcurrent > 1) {
      this.maxConcurrent--;
      this.lastRateLimitTime = Date.now();
      logger.warn(`[智谱限流] 触发降级: maxConcurrent ${this.maxConcurrent + 1} → ${this.maxConcurrent}`);
    }
  }

  onSuccess(): void {
    if (this.maxConcurrent < this.initialMaxConcurrent && Date.now() - this.lastRateLimitTime > 5 * 60 * 1000) {
      this.maxConcurrent++;
      logger.info(`[智谱限流] 恢复并发: maxConcurrent → ${this.maxConcurrent}`);
    }
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      throw new Error('Request was cancelled');
    }

    return new Promise((resolve, reject) => {
      if (signal) {
        signal.addEventListener('abort', () => {
          const idx = this.queue.findIndex(item => item.resolve === resolve);
          if (idx >= 0) {
            this.queue.splice(idx, 1);
            reject(new Error('Request was cancelled while waiting'));
          }
        }, { once: true });
      }

      this.queue.push({ resolve, reject });
      this.tryNext();
    });
  }

  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    this.tryNext();
  }

  private tryNext(): void {
    if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) {
      return;
    }

    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;

    if (timeSinceLastRequest < this.minInterval) {
      setTimeout(() => this.tryNext(), this.minInterval - timeSinceLastRequest);
      return;
    }

    const next = this.queue.shift();
    if (next) {
      this.activeRequests++;
      this.lastRequestTime = Date.now();
      logger.debug(`[智谱限流] 请求开始, 当前并发: ${this.activeRequests}/${this.maxConcurrent}, 队列: ${this.queue.length}`);
      next.resolve();
    }
  }
}

// 全局限流器实例
const zhipuLimiter = new ZhipuRateLimiter(
  parseInt(process.env.ZHIPU_MAX_CONCURRENT || '3'),
  parseInt(process.env.ZHIPU_MIN_INTERVAL_MS || '200')
);

export class ZhipuProvider extends BaseOpenAIProvider {
  readonly name = '智谱';

  protected getBaseUrl(config: ModelConfig): string {
    const modelInfo = this.getModelInfo(config);
    const providerConfig = PROVIDER_REGISTRY.zhipu;

    // Coding 套餐模型使用专用端点（0ki）
    if (modelInfo?.useCodingEndpoint && providerConfig?.codingBaseUrl) {
      logger.info(`[智谱] 使用 Coding 套餐端点: ${providerConfig.codingBaseUrl}, 模型: ${config.model}`);
      return providerConfig.codingBaseUrl;
    }

    const baseUrl = config.baseUrl || providerConfig?.baseUrl || MODEL_API_ENDPOINTS.zhipu;
    logger.info(`[智谱] 使用标准端点: ${baseUrl}, 模型: ${config.model}`);
    return baseUrl;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const zhipuTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || DEFAULT_MODELS.quick,
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || DEFAULT_MODELS.quick),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useToolCalling && zhipuTools.length > 0) {
      body.tools = zhipuTools;
      body.tool_choice = 'auto';
    }

    return body;
  }

  /**
   * Override inference to wrap with rate limiter
   */
  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    if (signal?.aborted) {
      throw new Error('Request was cancelled before starting');
    }

    // 限流：等待获取请求许可
    await zhipuLimiter.acquire(signal);

    try {
      const result = await super.inference(messages, tools, config, onStream, signal, options);
      zhipuLimiter.onSuccess();
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('1302') || msg.includes('速率限制') || msg.includes('rate limit')) {
        zhipuLimiter.onRateLimit();
      }
      throw err;
    } finally {
      zhipuLimiter.release();
    }
  }
}
