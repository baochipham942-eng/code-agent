// ============================================================================
// OpenAI-Compatible SSE Stream Handler
// 共享的 SSE 流式解析逻辑，消除 4 个 provider 的重复代码
// ============================================================================

import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelResponse, StreamCallback } from '../types';
import { logger, httpsAgent, safeJsonParse } from './shared';

export interface SSEStreamOptions {
  providerName: string;
  baseUrl: string;
  apiKey: string;
  requestBody: Record<string, unknown>;
  onStream?: StreamCallback;
  signal?: AbortSignal;
  agent?: https.Agent | http.Agent;
  extraHeaders?: Record<string, string>;
  timeout?: number;
  /** API 路径，默认 '/chat/completions' */
  endpoint?: string;
}

/**
 * 通用 OpenAI 兼容 SSE 流式请求处理
 *
 * 支持的特性（自动检测）：
 * - SSE 注释行（`:` 开头，如代理中继的 `: OPENROUTER PROCESSING`）
 * - reasoning_content（DeepSeek R1 / GLM 推理模型）
 * - usage 数据捕获（prompt_tokens / completion_tokens）
 * - 实时 token 估算（每 500ms）
 * - AbortSignal 取消支持
 */
export function openAISSEStream(options: SSEStreamOptions): Promise<ModelResponse> {
  const {
    providerName,
    baseUrl,
    apiKey,
    requestBody,
    onStream,
    signal,
    agent,
    extraHeaders,
    timeout = 300000,
    endpoint = '/chat/completions',
  } = options;

  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('Request was cancelled before starting'));
      return;
    }

    const url = new URL(`${baseUrl}${endpoint}`);
    const isHttps = url.protocol === 'https:';
    const httpModule = isHttps ? https : http;

    // 累积状态
    let content = '';
    let reasoning = '';
    let finishReason: string | undefined;
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();
    let charCount = 0;
    let lastEstimateTime = 0;
    let usageData: { inputTokens: number; outputTokens: number } | undefined;

    const reqOptions: https.RequestOptions = {
      hostname: url.hostname,
      port: url.port || (isHttps ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        Accept: 'text/event-stream',
        ...extraHeaders,
      },
      agent: agent || httpsAgent,
      timeout,
    };

    const req = httpModule.request(reqOptions, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.error(`[${providerName}] API 错误: ${res.statusCode}`, errorData);
          let errorMessage = `${providerName} API 错误 (${res.statusCode})`;
          try {
            const parsed = JSON.parse(errorData);
            if (parsed.error?.message) {
              errorMessage = `${providerName} API (${res.statusCode}): ${parsed.error.message}`;
            }
          } catch {
            errorMessage = `${providerName} API error: ${res.statusCode} - ${errorData.substring(0, 200)}`;
          }
          // Emit error event
          if (onStream) {
            onStream({
              type: 'error',
              error: errorMessage,
              errorCode: String(res.statusCode),
            });
          }

          reject(new Error(errorMessage));
        });
        return;
      }

      let buffer = '';
      const decoder = new StringDecoder('utf8');

      res.on('data', (chunk: Buffer) => {
        buffer += decoder.write(chunk);
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // 忽略 SSE 注释行
          if (line.startsWith(':')) continue;
          if (!line.trim()) continue;

          // 兼容 "data:" 和 "data: " 两种格式
          if (!line.startsWith('data:')) continue;
          const data = line.slice(5).trim();

          if (data === '[DONE]') {
            // 从 content 中提取 <think> 块，合并到 reasoning
            const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
            let thinkMatch;
            while ((thinkMatch = thinkRegex.exec(content)) !== null) {
              reasoning += (reasoning ? '\n' : '') + thinkMatch[1].trim();
            }
            content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

            const truncated = finishReason === 'length';
            const result: ModelResponse = {
              type: toolCalls.size > 0 ? 'tool_use' : 'text',
              content: content || undefined,
              truncated,
              finishReason,
              thinking: reasoning || undefined,
              usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
            };

            if (toolCalls.size > 0) {
              result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
                id: tc.id,
                name: tc.name,
                arguments: safeJsonParse(tc.arguments),
              }));
            }

            logger.info(`[${providerName}] stream complete:`, {
              contentLength: content.length,
              toolCallCount: toolCalls.size,
              finishReason,
            });

            if (truncated) {
              logger.warn(`[${providerName}] ⚠️ Output was truncated due to max_tokens limit!`);
            }

            // Emit usage event (if data available)
            if (onStream && usageData) {
              onStream({
                type: 'usage',
                inputTokens: usageData.inputTokens,
                outputTokens: usageData.outputTokens,
              });
            }

            // Emit complete event
            if (onStream) {
              onStream({
                type: 'complete',
                finishReason: finishReason || 'stop',
              });
            }

            resolve(result);
            return;
          }

          try {
            const parsed = JSON.parse(data);
            const choice = parsed.choices?.[0];
            const delta = choice?.delta;

            // 捕获 usage
            if (parsed.usage) {
              usageData = {
                inputTokens: parsed.usage.prompt_tokens || 0,
                outputTokens: parsed.usage.completion_tokens || 0,
              };
            }

            // 捕获 finish_reason
            if (choice?.finish_reason) {
              finishReason = choice.finish_reason;
            }

            if (delta) {
              // 推理内容（DeepSeek R1 / GLM 推理模型）
              if (delta.reasoning_content) {
                reasoning += delta.reasoning_content;
                if (onStream) {
                  onStream({ type: 'reasoning', content: delta.reasoning_content });
                }
              }

              // Kimi K2.5 的推理内容（delta.reasoning 字段）
              if (delta.reasoning) {
                reasoning += delta.reasoning;
                if (onStream) {
                  onStream({ type: 'reasoning', content: delta.reasoning });
                }
              }

              // 文本内容
              const textContent = delta.content;
              if (textContent) {
                content += textContent;
                charCount += textContent.length;
                if (onStream) {
                  onStream({ type: 'text', content: textContent });
                  // 每 500ms 估算 token 数
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

              // 工具调用
              if (delta.tool_calls) {
                for (const tc of delta.tool_calls) {
                  const index = tc.index ?? 0;

                  if (!toolCalls.has(index)) {
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

                  const existing = toolCalls.get(index)!;

                  if (tc.id && existing.id.startsWith('call_')) {
                    existing.id = tc.id;
                  }
                  if (tc.function?.name && !existing.name) {
                    existing.name = tc.function.name;
                  }
                  if (tc.function?.arguments) {
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
            logger.debug(`[${providerName}] JSON 解析跳过: ${data.substring(0, 50)}`);
          }
        }
      });

      res.on('end', () => {
        // 从 content 中提取 <think> 块，合并到 reasoning
        const thinkRegex = /<think>([\s\S]*?)<\/think>/g;
        let thinkMatch;
        while ((thinkMatch = thinkRegex.exec(content)) !== null) {
          reasoning += (reasoning ? '\n' : '') + thinkMatch[1].trim();
        }
        content = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();

        if (content || toolCalls.size > 0) {
          const result: ModelResponse = {
            type: toolCalls.size > 0 ? 'tool_use' : 'text',
            content: content || undefined,
            finishReason,
            thinking: reasoning || undefined,
            usage: usageData || { inputTokens: 0, outputTokens: Math.ceil(charCount / 4) },
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
          reject(new Error(`[${providerName}] 流式响应无内容`));
        }
      });

      res.on('error', (err) => {
        logger.error(`[${providerName}] 响应错误:`, err);
        if (onStream) {
          onStream({
            type: 'error',
            error: err.message,
          });
        }
        reject(err);
      });
    });

    req.on('error', (err) => {
      const errCode = (err as NodeJS.ErrnoException).code;
      logger.error(`[${providerName}] 请求错误: ${err.message} (code=${errCode})`);
      if (onStream) {
        onStream({
          type: 'error',
          error: err.message,
          errorCode: errCode,
        });
      }
      reject(err);
    });

    req.on('timeout', () => {
      logger.error(`[${providerName}] 请求超时`);
      req.destroy(new Error(`${providerName} API 请求超时`));
    });

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
