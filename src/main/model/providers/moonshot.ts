// ============================================================================
// Moonshot (Kimi) Provider Implementation
// 支持 Kimi K2.5 第三方代理的 SSE 流式响应
// ============================================================================

import https from 'https';
import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import { logger, httpsAgent, convertToolsToOpenAI, convertToOpenAIMessages } from './shared';
import { MODEL_API_ENDPOINTS, MODEL_MAX_TOKENS, DEFAULT_MODEL } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';
import { withTransientRetry } from './retryStrategy';

// 专用 HTTPS Agent: 禁用 keepAlive 避免 SSE 流结束后连接复用导致 "socket hang up"
// Node.js 19+ 的 globalAgent 默认 keepAlive=true，会导致并发子代理请求复用已关闭的连接
const moonshotAgent = httpsAgent || new https.Agent({
  keepAlive: false,
  maxSockets: 10,
});

// ============================================================================
// Moonshot 并发限流器
// cn.haioi.net 第三方代理在 ≥4 并发 SSE 连接时频繁断开 TLS
// 安全并发上限: 2（留余量，避免与 retry 请求叠加超限）
// ============================================================================
class MoonshotRateLimiter {
  private queue: Array<{ resolve: () => void; reject: (err: Error) => void }> = [];
  private activeRequests = 0;
  private readonly maxConcurrent: number;

  constructor(maxConcurrent = 2) {
    this.maxConcurrent = maxConcurrent;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('Request was cancelled');
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
    if (this.activeRequests >= this.maxConcurrent || this.queue.length === 0) return;
    const next = this.queue.shift();
    if (next) {
      this.activeRequests++;
      logger.debug(`[Moonshot限流] 请求开始, 当前并发: ${this.activeRequests}/${this.maxConcurrent}, 队列: ${this.queue.length}`);
      next.resolve();
    }
  }
}

const moonshotLimiter = new MoonshotRateLimiter(
  parseInt(process.env.MOONSHOT_MAX_CONCURRENT || '2')
);

/**
 * Call Moonshot (Kimi) API
 * 支持 Kimi K2.5 包月套餐（第三方代理）
 * @param signal - AbortSignal for cancellation support
 */
export async function callMoonshot(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  // Kimi K2.5 使用单独的 API key 和 URL（包月套餐）
  const isKimiK25 = config.model === 'kimi-k2.5';
  const baseUrl = isKimiK25
    ? (process.env.KIMI_K25_API_URL || MODEL_API_ENDPOINTS.kimiK25)
    : (config.baseUrl || MODEL_API_ENDPOINTS.moonshot);
  const apiKey = isKimiK25
    ? (process.env.KIMI_K25_API_KEY || config.apiKey)
    : config.apiKey;

  if (!apiKey) {
    throw new Error('Moonshot API key not configured');
  }

  const moonshotTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || DEFAULT_MODEL,
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? MODEL_MAX_TOKENS.DEFAULT,
    stream: true,
    stream_options: { include_usage: true },
  };

  if (moonshotTools.length > 0) {
    requestBody.tools = moonshotTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`[Moonshot] 请求: model=${requestBody.model}, baseUrl=${baseUrl}, stream=true`);

  // 限流：等待获取请求许可（cn.haioi.net 代理安全并发上限 2）
  await moonshotLimiter.acquire(signal);
  try {
    // 带重试的流式请求（处理 socket hang up 等瞬态错误）
    return await withTransientRetry(
      () => openAISSEStream({
        providerName: 'Moonshot',
        baseUrl,
        apiKey,
        requestBody,
        onStream,
        signal,
        agent: moonshotAgent,
        extraHeaders: { 'User-Agent': 'claude-code/1.0' },
      }),
      { providerName: 'Moonshot', signal }
    );
  } finally {
    moonshotLimiter.release();
  }
}
