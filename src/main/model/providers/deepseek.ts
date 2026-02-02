// ============================================================================
// DeepSeek Provider Implementation
// ============================================================================

import axios from 'axios';
import https from 'https';
import http from 'http';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  parseContextLengthError,
  safeJsonParse,
} from './shared';

/**
 * Call DeepSeek API
 * @param signal - AbortSignal for cancellation support
 */
export async function callDeepSeek(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://api.deepseek.com/v1';

  // Convert tools to OpenAI format with strict schema
  const openaiTools = convertToolsToOpenAI(tools, true);

  // 根据模型能力获取推荐的 maxTokens
  const recommendedMaxTokens = modelInfo?.maxTokens || 8192;

  // 启用流式输出
  const useStream = !!onStream;

  const requestBody: Record<string, unknown> = {
    model: config.model || 'deepseek-chat',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? recommendedMaxTokens,
    stream: useStream,
  };

  // T6: Add response_format for structured output
  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' DeepSeek: Using response_format:', config.responseFormat.type);
  }

  // Only add tools if we have any
  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
    requestBody.tool_choice = 'auto';
  }

  // 如果启用流式输出，使用 SSE 处理
  if (useStream) {
    return callDeepSeekStream(baseUrl, requestBody, config.apiKey!, onStream!, signal);
  }

  // 非流式输出（fallback）
  try {
    const response = await axios.post(`${baseUrl}/chat/completions`, requestBody, {
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      timeout: 300000,
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'json',
      signal,
    });

    logger.info(' DeepSeek raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
    return parseOpenAIResponse(response.data);
  } catch (error: any) {
    if (axios.isCancel(error) || error.name === 'AbortError' || error.name === 'CanceledError') {
      throw new Error('Request was cancelled');
    }
    if (error.response) {
      const errorData = error.response.data;
      const errorMessage = typeof errorData === 'string'
        ? errorData
        : JSON.stringify(errorData);

      // 检测上下文超限错误
      const contextError = parseContextLengthError(errorMessage, 'deepseek');
      if (contextError) {
        throw contextError;
      }

      throw new Error(`DeepSeek API error: ${error.response.status} - ${errorMessage}`);
    }
    throw new Error(`DeepSeek request failed: ${error.message}`);
  }
}

/**
 * 流式调用 DeepSeek API
 * 使用 SSE (Server-Sent Events) 处理流式响应
 * @param signal - AbortSignal for cancellation support
 */
function callDeepSeekStream(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  apiKey: string,
  onStream: StreamCallback,
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
    };

    const req = httpModule.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          reject(new Error(`DeepSeek API error: ${res.statusCode} - ${errorData}`));
        });
        return;
      }

      let buffer = '';

      res.on('data', (chunk: Buffer) => {
        buffer += chunk.toString();

        // 处理 SSE 数据行
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // 保留不完整的行

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

              logger.info(' DeepSeek stream complete:', {
                contentLength: content.length,
                toolCallCount: toolCalls.size,
                finishReason,
                truncated,
              });

              if (truncated) {
                logger.warn(' ⚠️ Output was truncated due to max_tokens limit!');
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
                // 处理文本内容
                if (delta.content) {
                  content += delta.content;
                  // 发送文本流式更新
                  onStream({ type: 'text', content: delta.content });
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
                      // 发送新工具调用开始事件
                      onStream({
                        type: 'tool_call_start',
                        toolCall: {
                          index,
                          id: tc.id,
                          name: tc.function?.name,
                        },
                      });
                    }

                    const existing = toolCalls.get(index)!;

                    if (tc.id && !existing.id.startsWith('call_')) {
                      existing.id = tc.id;
                    }
                    if (tc.function?.name && !existing.name) {
                      existing.name = tc.function.name;
                      // 工具名称更新
                      onStream({
                        type: 'tool_call_delta',
                        toolCall: {
                          index,
                          name: tc.function.name,
                        },
                      });
                    }
                    if (tc.function?.arguments) {
                      existing.arguments += tc.function.arguments;
                      // 发送参数增量更新
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
            } catch {
              // 忽略解析错误（可能是不完整的 JSON）
              logger.warn(' Failed to parse SSE data:', data.substring(0, 100));
            }
          }
        }
      });

      res.on('end', () => {
        // 如果没有通过 [DONE] 结束，在这里处理
        if (content || toolCalls.size > 0) {
          const result: ModelResponse = {
            type: toolCalls.size > 0 ? 'tool_use' : 'text',
            content: content || undefined,
          };

          if (toolCalls.size > 0) {
            result.toolCalls = Array.from(toolCalls.values()).map((tc) => ({
              id: tc.id,
              name: tc.name,
              arguments: safeJsonParse(tc.arguments),
            }));
          }

          resolve(result);
        }
      });

      res.on('error', (error) => {
        reject(new Error(`DeepSeek stream error: ${error.message}`));
      });
    });

    req.on('error', (error) => {
      reject(new Error(`DeepSeek request error: ${error.message}`));
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
