// ============================================================================
// 智谱 GLM Provider Implementation
// ============================================================================

import type { ModelConfig, ToolDefinition, ModelInfo, ProviderConfig } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import { logger, httpsAgent, convertToolsToOpenAI, convertToOpenAIMessages } from './shared';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';

// ============================================================================
// 智谱 API 限流器 - 防止并发过高触发限流
// ============================================================================

class ZhipuRateLimiter {
  private queue: Array<{
    resolve: () => void;
    reject: (error: Error) => void;
  }> = [];
  private activeRequests = 0;
  private readonly maxConcurrent: number;
  private readonly minInterval: number;
  private lastRequestTime = 0;

  constructor(maxConcurrent = 3, minIntervalMs = 200) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minIntervalMs;
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

  getStatus(): { active: number; queued: number } {
    return { active: this.activeRequests, queued: this.queue.length };
  }
}

// 全局限流器实例
const zhipuLimiter = new ZhipuRateLimiter(
  parseInt(process.env.ZHIPU_MAX_CONCURRENT || '3'),
  parseInt(process.env.ZHIPU_MIN_INTERVAL_MS || '200')
);

/**
 * Call 智谱 GLM API
 * @param signal - AbortSignal for cancellation support
 */
export async function callZhipu(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  providerConfig: ProviderConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  logger.debug(`进入智谱调用, model=${config.model}, hasApiKey=${!!config.apiKey}, useCloudProxy=${config.useCloudProxy}`);

  // GLM-4.7 等 Coding 套餐模型使用专用端点
  let baseUrl: string;
  if (modelInfo?.useCodingEndpoint && providerConfig.codingBaseUrl) {
    baseUrl = providerConfig.codingBaseUrl;
    logger.info(`[智谱] 使用 Coding 套餐端点: ${baseUrl}, 模型: ${config.model}`);
  } else {
    baseUrl = config.baseUrl || providerConfig.baseUrl || MODEL_API_ENDPOINTS.zhipu;
    logger.info(`[智谱] 使用标准端点: ${baseUrl}, 模型: ${config.model}`);
  }

  const zhipuTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || DEFAULT_MODELS.quick,
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (zhipuTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = zhipuTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`[智谱] 请求: model=${requestBody.model}, max_tokens=${requestBody.max_tokens}, stream=true`);

  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  // 限流：等待获取请求许可
  await zhipuLimiter.acquire(signal);

  try {
    return await openAISSEStream({
      providerName: '智谱',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
    });
  } finally {
    zhipuLimiter.release();
  }
}
