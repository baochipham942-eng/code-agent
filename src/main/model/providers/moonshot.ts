// ============================================================================
// Moonshot (Kimi) Provider Implementation
// 支持 Kimi K2.5 第三方代理的 SSE 流式响应
// ============================================================================

import https from 'https';
import http from 'http';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  safeJsonParse,
} from './shared';

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
    ? (process.env.KIMI_K25_API_URL || 'https://cn.haioi.net/v1')
    : (config.baseUrl || 'https://api.moonshot.cn/v1');
  const apiKey = isKimiK25
    ? (process.env.KIMI_K25_API_KEY || config.apiKey)
    : config.apiKey;

  if (!apiKey) {
    throw new Error('Moonshot API key not configured');
  }

  const moonshotTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'moonshot-v1-8k',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: true, // 始终使用流式响应
  };

  if (moonshotTools.length > 0) {
    requestBody.tools = moonshotTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`[Moonshot] 请求: model=${requestBody.model}, baseUrl=${baseUrl}, stream=true`);

  // 使用原生 https 模块处理 SSE 流式响应
  return callMoonshotStream(baseUrl, requestBody, apiKey, onStream, signal);
}

/**
 * Moonshot 流式 API 调用（使用原生 https 模块）
 * 正确处理 SSE 格式，包括代理的注释行
 */
function callMoonshotStream(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  apiKey: string,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  return new Promise((resolve, reject) => {
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

    logger.debug(`[Moonshot] 发起请求到: ${url.hostname}${url.pathname}`);

    const req = httpModule.request(options, (res) => {
      logger.debug(`[Moonshot] 响应状态码: ${res.statusCode}`);

      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          logger.error(`[Moonshot] API 错误: ${res.statusCode}`, errorData);
          let errorMessage = `Moonshot API 错误 (${res.statusCode})`;
          try {
            const parsed = JSON.parse(errorData);
            if (parsed.error?.message) {
              errorMessage = `Moonshot API: ${parsed.error.message}`;
            }
          } catch {
            errorMessage = `Moonshot API error: ${res.statusCode} - ${errorData.substring(0, 200)}`;
          }
          reject(new Error(errorMessage));
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // 处理 SSE 数据行
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          // 忽略 SSE 注释行（以冒号开头，如 ": OPENROUTER PROCESSING"）
          if (line.startsWith(':')) {
            logger.debug(`[Moonshot] 忽略注释行: ${line.substring(0, 50)}`);
            continue;
          }

          // 忽略空行
          if (!line.trim()) {
            continue;
          }

          // 只处理 data: 开头的行
          if (!line.startsWith('data:')) {
            logger.debug(`[Moonshot] 忽略非 data 行: ${line.substring(0, 50)}`);
            continue;
          }

          const data = line.slice(5).trim(); // 移除 "data:" 前缀

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

            logger.info('[Moonshot] stream complete:', {
              contentLength: content.length,
              toolCallCount: toolCalls.size,
              finishReason,
            });

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
              // 处理文本内容
              if (delta.content) {
                content += delta.content;
                if (onStream) {
                  onStream({ type: 'text', content: delta.content });
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
          } catch (parseError) {
            // 忽略 JSON 解析错误，可能是不完整的数据
            logger.debug(`[Moonshot] JSON 解析跳过: ${data.substring(0, 50)}`);
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
          reject(new Error('[Moonshot] 流式响应无内容'));
        }
      });

      res.on('error', (err) => {
        logger.error('[Moonshot] 响应错误:', err);
        reject(err);
      });
    });

    req.on('error', (err) => {
      logger.error('[Moonshot] 请求错误:', err);
      reject(err);
    });

    req.on('timeout', () => {
      logger.error('[Moonshot] 请求超时 (5分钟)');
      req.destroy(new Error('Moonshot API 请求超时 (5分钟)'));
    });

    // 支持取消
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
