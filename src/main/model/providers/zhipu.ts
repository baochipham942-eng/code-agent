// ============================================================================
// 智谱 GLM Provider Implementation
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelConfig, ToolDefinition, ModelInfo, ProviderConfig } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  safeJsonParse,
} from './shared';

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
  private readonly minInterval: number; // 最小请求间隔（毫秒）
  private lastRequestTime = 0;

  constructor(maxConcurrent = 3, minIntervalMs = 200) {
    this.maxConcurrent = maxConcurrent;
    this.minInterval = minIntervalMs;
  }

  async acquire(signal?: AbortSignal): Promise<void> {
    // 检查是否已取消
    if (signal?.aborted) {
      throw new Error('Request was cancelled');
    }

    return new Promise((resolve, reject) => {
      // 设置取消监听
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
      // 等待最小间隔后重试
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
    baseUrl = config.baseUrl || providerConfig.baseUrl || 'https://open.bigmodel.cn/api/paas/v4';
    logger.info(`[智谱] 使用标准端点: ${baseUrl}, 模型: ${config.model}`);
  }

  // 智谱使用 OpenAI 兼容格式
  const zhipuTools = convertToolsToOpenAI(tools);

  // 智谱 API 总是使用流式响应
  const requestBody: Record<string, unknown> = {
    model: config.model || 'glm-4.7',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: true,
  };

  // 检查模型是否支持工具调用
  if (zhipuTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = zhipuTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`[智谱] 请求: model=${requestBody.model}, max_tokens=${requestBody.max_tokens}, stream=true`);
  logger.debug(`[智谱] 完整请求体:`, JSON.stringify(requestBody).substring(0, 500));

  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  // 限流：等待获取请求许可
  await zhipuLimiter.acquire(signal);

  try {
    // 使用原生 https 模块处理流式响应
    return await callZhipuStream(baseUrl, requestBody, config.apiKey!, onStream, signal);
  } finally {
    // 释放请求许可
    zhipuLimiter.release();
  }
}

/**
 * 智谱流式 API 调用（使用原生 https 模块）
 * @param signal - AbortSignal for cancellation support
 */
function callZhipuStream(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  apiKey: string,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  return new Promise((resolve, reject) => {
    // Check for cancellation before starting
    if (signal?.aborted) {
      reject(new Error('Request was cancelled before starting'));
      return;
    }

    const url = new URL(`${baseUrl}/chat/completions`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // 累积响应数据
    let content = '';
    let finishReason: string | undefined;
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

    // Real-time token estimation
    let charCount = 0;
    let lastEstimateTime = 0;

    const options: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
      },
      agent: httpsAgent,
      timeout: 300000, // 5 分钟超时
    };

    logger.debug(`[智谱] 发起请求到: ${url.hostname}${url.pathname}`);

    const req = httpModule.request(options, (res) => {
      logger.debug(`[智谱] 响应状态码: ${res.statusCode}`);

      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.error(`[智谱] API 错误: ${res.statusCode}`, errorData);
          let errorMessage = `智谱 API 错误 (${res.statusCode})`;
          try {
            const parsed = JSON.parse(errorData);
            if (parsed.error?.message) {
              errorMessage = `智谱 API: ${parsed.error.message}`;
              if (parsed.error.code === '1210') {
                errorMessage += ' (请检查模型是否支持当前请求参数)';
              }
            }
          } catch {
            errorMessage = `智谱 API error: ${res.statusCode} - ${errorData}`;
          }
          reject(new Error(errorMessage));
        });
        return;
      }

      let buffer = '';
      // 使用 StringDecoder 正确处理 UTF-8 多字节字符边界
      const decoder = new StringDecoder('utf8');

      res.on('data', (chunk: Buffer) => {
        // 使用 decoder.write() 而不是 chunk.toString()
        // 这样可以正确处理被分割到多个 chunk 的 UTF-8 字符
        buffer += decoder.write(chunk);

        // 处理 SSE 数据行
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();

            if (data === '[DONE]') {
              // 流式输出完成
              const truncated = finishReason === 'length';
              const result: ModelResponse = {
                type: toolCalls.size > 0 ? 'tool_use' : 'text',
                content: content || undefined,
                truncated,
                finishReason,
              };

              if (toolCalls.size > 0) {
                result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                  id: tc.id,
                  name: tc.name,
                  arguments: safeJsonParse(tc.arguments),
                }));
              }

              logger.info('[智谱] stream complete:', {
                contentLength: content.length,
                toolCallCount: toolCalls.size,
                finishReason,
                truncated,
              });

              if (truncated) {
                logger.warn('[智谱] ⚠️ Output was truncated due to max_tokens limit!');
              }

              resolve(result);
              return;
            }

            try {
              const parsed = JSON.parse(data);
              const choice = parsed.choices?.[0];
              const delta = choice?.delta;

              // 捕获 finish_reason
              if (choice?.finish_reason) {
                finishReason = choice.finish_reason;
              }

              if (delta) {
                // 处理推理内容 (glm-4.7 等推理模型)
                if (delta.reasoning_content) {
                  // 推理内容作为思考过程展示，但不计入最终 content
                  logger.debug(`[智谱] 收到推理块: "${delta.reasoning_content.substring(0, 30)}..."`);
                  if (onStream) {
                    onStream({ type: 'reasoning', content: delta.reasoning_content });
                  }
                }

                // 处理文本内容
                if (delta.content) {
                  content += delta.content;
                  charCount += delta.content.length;
                  logger.debug(`[智谱] 收到文本块: "${delta.content.substring(0, 30)}..."`);
                  if (onStream) {
                    onStream({ type: 'text', content: delta.content });
                    // Periodic token estimation (~every 500ms)
                    const now = Date.now();
                    if (now - lastEstimateTime > 500) {
                      lastEstimateTime = now;
                      onStream({
                        type: 'token_estimate',
                        inputTokens: 0,
                        outputTokens: Math.ceil(charCount / 4),
                      });
                    }
                  }
                }

                // 处理工具调用
                if (delta.tool_calls) {
                  for (const tc of delta.tool_calls) {
                    const index = tc.index ?? 0;
                    const isNewToolCall = !toolCalls.has(index);

                    if (isNewToolCall) {
                      toolCalls.set(index, {
                        id: tc.id || `call_${index}`,
                        name: tc.function?.name || '',
                        arguments: '',
                      });
                      if (onStream) {
                        onStream({
                          type: 'tool_call_start',
                          toolCall: {
                            index,
                            id: tc.id || `call_${index}`,
                            name: tc.function?.name || '',
                          },
                        });
                      }
                    }

                    // 累积参数
                    if (tc.function?.arguments) {
                      const existing = toolCalls.get(index)!;
                      existing.arguments += tc.function.arguments;
                      if (onStream) {
                        onStream({
                          type: 'tool_call_delta',
                          toolCall: {
                            index,
                            argumentsDelta: tc.function.arguments,
                          },
                        });
                      }
                    }
                  }
                }
              }
            } catch {
              // 忽略解析错误
            }
          }
        }
      });

      res.on('end', () => {
        // 如果没有收到 [DONE]，也返回结果
        if (content || toolCalls.size > 0) {
          const result: ModelResponse = {
            type: toolCalls.size > 0 ? 'tool_use' : 'text',
            content: content || undefined,
            finishReason,
          };

          if (toolCalls.size > 0) {
            result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: safeJsonParse(tc.arguments),
            }));
          }

          resolve(result);
        } else {
          reject(new Error('[智谱] 流式响应无内容'));
        }
      });

      res.on('error', (err) => {
        logger.error('[智谱] 响应错误:', err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      logger.error('[智谱] 请求错误:', err);
      reject(err);
    });

    req.on('timeout', () => {
      logger.error('[智谱] 请求超时 (5分钟)');
      req.destroy(new Error('智谱 API 请求超时 (5分钟)'));
    });

    // Set up abort listener for cancellation
    if (signal) {
      signal.addEventListener('abort', () => {
        req.destroy();
        reject(new Error('Request was cancelled'));
      }, { once: true });
    }

    req.write(JSON.stringify(requestBody));
    req.end();
  });
}
