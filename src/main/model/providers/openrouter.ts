// ============================================================================
// OpenRouter Provider Implementation
// ============================================================================

import axios from 'axios';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  normalizeJsonSchema,
} from './shared';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';

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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.openrouter;

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

  // 流式输出
  if (useStream) {
    return openAISSEStream({
      providerName: 'OpenRouter',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
      extraHeaders: {
        'HTTP-Referer': 'https://code-agent.app',
        'X-Title': 'Code Agent',
      },
    });
  }

  // 非流式输出（fallback）
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
