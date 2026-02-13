// ============================================================================
// Cloud Proxy Provider Implementation
// ============================================================================

import axios from 'axios';
import type { ModelConfig, ToolDefinition, ToolCall, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import { ContextLengthExceededError } from '../types';
import {
  logger,
  httpsAgent,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  parseContextLengthError,
  normalizeJsonSchema,
} from './shared';
import { getModelMaxOutputTokens } from '../../../shared/constants';

/**
 * Get cloud API URL
 */
function getCloudApiUrl(): string {
  const { getCloudApiUrl: getUrl } = require('../../../shared/constants');
  return getUrl();
}

/**
 * Call via Cloud Proxy (admin-only, server-side API key injection)
 * @param signal - AbortSignal for cancellation support
 */
export async function callViaCloudProxy(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const cloudUrl = getCloudApiUrl();
  const providerName = config.provider;

  const recommendedMaxTokens = modelInfo?.maxTokens || getModelMaxOutputTokens(config.model || 'gpt-4o');

  // 构建工具定义（OpenAI 兼容格式）
  const openaiTools = tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: normalizeJsonSchema(tool.inputSchema),
    },
  }));

  const useStream = !!onStream;

  const requestBody: Record<string, unknown> = {
    model: config.model || 'google/gemini-2.0-flash-001',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? recommendedMaxTokens,
    stream: useStream,
  };

  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' Cloud Proxy: Using response_format:', config.responseFormat.type);
  }

  // 只有支持工具的模型才添加 tools
  if (openaiTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = openaiTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`通过云端代理调用 ${providerName}/${config.model}...`, { streaming: useStream });

  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  try {
    if (useStream) {
      return await callViaCloudProxyStreaming(cloudUrl, providerName, requestBody, onStream, signal);
    }

    const response = await axios.post(`${cloudUrl}/api/model-proxy`, {
      provider: providerName,
      endpoint: '/chat/completions',
      body: requestBody,
    }, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 300000,
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      signal,
    });

    logger.info(' 云端代理响应状态:', response.status);

    if (response.status >= 200 && response.status < 300) {
      return parseOpenAIResponse(response.data);
    } else {
      const errorMessage = JSON.stringify(response.data);
      const contextError = parseContextLengthError(errorMessage, 'cloud-proxy');
      if (contextError) {
        throw contextError;
      }
      throw new Error(`云端代理错误: ${response.status} - ${errorMessage}`);
    }
  } catch (error: any) {
    if (axios.isCancel(error) || error.name === 'AbortError' || error.name === 'CanceledError') {
      throw new Error('Request was cancelled');
    }
    if (error instanceof ContextLengthExceededError) {
      throw error;
    }

    if (error.response) {
      const errorMessage = JSON.stringify(error.response.data);
      const contextError = parseContextLengthError(errorMessage, 'cloud-proxy');
      if (contextError) {
        throw contextError;
      }
      throw new Error(`云端代理 API 错误: ${error.response.status} - ${errorMessage}`);
    }
    throw new Error(`云端代理请求失败: ${error.message}`);
  }
}

/**
 * 通过云端代理进行流式调用
 * @param signal - AbortSignal for cancellation support
 */
async function callViaCloudProxyStreaming(
  cloudUrl: string,
  providerName: string,
  requestBody: Record<string, unknown>,
  onStream: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  const response = await fetch(`${cloudUrl}/api/model-proxy`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      provider: providerName,
      endpoint: '/chat/completions',
      body: requestBody,
    }),
    signal,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`云端代理流式错误: ${response.status} - ${errorText}`);
  }

  if (!response.body) {
    throw new Error('云端代理流式响应无 body');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let fullContent = '';
  const toolCalls: ToolCall[] = [];
  const toolCallsInProgress: Map<number, { id: string; name: string; arguments: string }> = new Map();

  try {
    let buffer = '';
    logger.debug('[云端代理] 开始读取流式响应...');

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        logger.debug('[云端代理] 流式响应读取完成, fullContent长度:', fullContent.length);
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // 处理 SSE 数据行
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;

        const data = line.slice(6).trim();
        if (data === '[DONE]') {
          logger.debug('[云端代理] 收到 [DONE] 标记');
          continue;
        }

        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta;

          if (!delta) {
            logger.debug('[云端代理] delta 为空, parsed:', JSON.stringify(parsed).substring(0, 200));
            continue;
          }

          // 文本内容
          if (delta.content) {
            fullContent += delta.content;
            logger.debug('[云端代理] 收到文本块:', delta.content.substring(0, 50));
            onStream({ type: 'text', content: delta.content });
          }

          // 工具调用
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const index = tc.index ?? 0;

              if (!toolCallsInProgress.has(index)) {
                toolCallsInProgress.set(index, {
                  id: tc.id || `tool-${index}`,
                  name: tc.function?.name || '',
                  arguments: '',
                });
                onStream({
                  type: 'tool_call_start',
                  toolCall: { index, id: tc.id, name: tc.function?.name },
                });
              }

              const inProgress = toolCallsInProgress.get(index)!;

              if (tc.function?.name) {
                inProgress.name = tc.function.name;
              }

              if (tc.function?.arguments) {
                inProgress.arguments += tc.function.arguments;
                onStream({
                  type: 'tool_call_delta',
                  toolCall: { index, name: inProgress.name, argumentsDelta: tc.function.arguments },
                });
              }
            }
          }
        } catch {
          // 忽略解析错误
        }
      }
    }

    // 完成工具调用
    for (const [, tc] of toolCallsInProgress) {
      try {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: JSON.parse(tc.arguments || '{}'),
        });
      } catch {
        toolCalls.push({
          id: tc.id,
          name: tc.name,
          arguments: {},
        });
      }
    }

    if (toolCalls.length > 0) {
      return { type: 'tool_use', toolCalls };
    }

    return { type: 'text', content: fullContent };
  } finally {
    reader.releaseLock();
  }
}
