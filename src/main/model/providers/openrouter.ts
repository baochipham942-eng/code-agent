// ============================================================================
// OpenRouter Provider Implementation
// ============================================================================

import axios from 'axios';
import https from 'https';
import http from 'http';
import { StringDecoder } from 'string_decoder';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  normalizeJsonSchema,
  safeJsonParse,
} from './shared';

/**
 * Call OpenRouter API
 * @param signal - AbortSignal for cancellation support
 */
export async function callOpenRouter(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://openrouter.ai/api/v1';

  // OpenRouter 使用 OpenAI 兼容格式
  const openrouterTools = tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeJsonSchema(tool.inputSchema),
    },
  }));

  // 获取模型信息
  const recommendedMaxTokens = modelInfo?.maxTokens || 8192;

  // 启用流式输出
  const useStream = !!onStream;

  const requestBody: Record<string, unknown> = {
    model: config.model || 'google/gemini-2.0-flash-001',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? recommendedMaxTokens,
    stream: useStream,
  };

  // T6: Add response_format for structured output
  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' OpenRouter: Using response_format:', config.responseFormat.type);
  }

  // 只有支持工具的模型才添加 tools
  if (openrouterTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = openrouterTools;
    requestBody.tool_choice = 'auto';
  }

  // OpenRouter 需要额外的 headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${config.apiKey}`,
    'HTTP-Referer': 'https://code-agent.app',
    'X-Title': 'Code Agent',
  };

  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  // 如果启用流式输出，使用 SSE 处理
  if (useStream) {
    return callOpenRouterStream(baseUrl, requestBody, config.apiKey!, headers, onStream!, signal);
  }

  // 非流式输出
  try {
    const response = await axios.post(`${baseUrl}/chat/completions`, requestBody, {
      headers,
      timeout: 300000,
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'json',
      signal,
    });

    logger.info(' OpenRouter raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
    return parseOpenAIResponse(response.data);
  } catch (error: any) {
    if (axios.isCancel(error) || error.name === 'AbortError' || error.name === 'CanceledError') {
      throw new Error('Request was cancelled');
    }
    if (error.response) {
      throw new Error(`OpenRouter API error: ${error.response.status} - ${JSON.stringify(error.response.data)}`);
    }
    throw new Error(`OpenRouter request failed: ${error.message}`);
  }
}

/**
 * 流式调用 OpenRouter API
 * @param signal - AbortSignal for cancellation support
 */
function callOpenRouterStream(
  baseUrl: string,
  requestBody: Record<string, unknown>,
  apiKey: string,
  extraHeaders: Record<string, string>,
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
        ...extraHeaders,
      },
      agent: httpsAgent,
    };

    const req = httpModule.request(options, (res) => {
      if (res.statusCode !== 200) {
        let errorData = '';
        res.on('data', (chunk) => { errorData += chunk; });
        res.on('end', () => {
          reject(new Error(`OpenRouter API error: ${res.statusCode} - ${errorData}`));
        });
        return;
      }

      let buffer = '';
      // 使用 StringDecoder 正确处理 UTF-8 多字节字符边界
      const decoder = new StringDecoder('utf8');

      res.on('data', (chunk: Buffer) => {
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

              logger.info(' OpenRouter stream complete:', {
                contentLength: content.length,
                toolCallCount: toolCalls.size,
                finishReason,
                truncated,
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
              logger.warn(' Failed to parse OpenRouter SSE data:', data.substring(0, 100));
            }
          }
        }
      });

      res.on('end', () => {
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
        reject(new Error(`OpenRouter stream error: ${error.message}`));
      });
    });

    req.on('error', (error) => {
      reject(new Error(`OpenRouter request error: ${error.message}`));
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
