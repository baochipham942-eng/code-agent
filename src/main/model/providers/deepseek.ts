// ============================================================================
// DeepSeek Provider Implementation
// ============================================================================

import axios from 'axios';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  httpsAgent,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  parseContextLengthError,
} from './shared';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS, getModelMaxOutputTokens } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';
import { withTransientRetry } from './retryStrategy';

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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.deepseek;
  const openaiTools = convertToolsToOpenAI(tools, true);
  const recommendedMaxTokens = modelInfo?.maxTokens || getModelMaxOutputTokens(config.model || DEFAULT_MODELS.chat);
  const useStream = !!onStream;

  const requestBody: Record<string, unknown> = {
    model: config.model || DEFAULT_MODELS.chat,
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? recommendedMaxTokens,
    stream: useStream,
    ...(useStream ? { stream_options: { include_usage: true } } : {}),
  };

  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' DeepSeek: Using response_format:', config.responseFormat.type);
  }

  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
    requestBody.tool_choice = 'auto';
  }

  if (useStream) {
    return withTransientRetry(
      () => openAISSEStream({
        providerName: 'DeepSeek',
        baseUrl,
        apiKey: config.apiKey!,
        requestBody,
        onStream,
        signal,
      }),
      { providerName: 'DeepSeek', signal }
    );
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

      const contextError = parseContextLengthError(errorMessage, 'deepseek');
      if (contextError) {
        throw contextError;
      }

      throw new Error(`DeepSeek API error: ${error.response.status} - ${errorMessage}`);
    }
    throw new Error(`DeepSeek request failed: ${error.message}`);
  }
}
