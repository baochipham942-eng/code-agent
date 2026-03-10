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
  convertToTextOnlyMessages,
  parseOpenAIResponse,
  parseContextLengthError,
} from './shared';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS, getModelMaxOutputTokens, PROVIDER_TIMEOUT } from '../../../shared/constants';
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

  // R1 等推理模型不支持 tool calling，使用纯文本回退
  const useToolCalling = modelInfo?.supportsTool !== false;
  const convertedMessages = useToolCalling
    ? convertToOpenAIMessages(messages)
    : convertToTextOnlyMessages(messages);

  const requestBody: Record<string, unknown> = {
    model: config.model || DEFAULT_MODELS.chat,
    messages: convertedMessages,
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? recommendedMaxTokens,
    stream: useStream,
    ...(useStream ? { stream_options: { include_usage: true } } : {}),
  };

  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' DeepSeek: Using response_format:', config.responseFormat.type);
  }

  if (useToolCalling && openaiTools.length > 0) {
    // Sort tools by name for stable cache prefix (prompt caching optimization)
    openaiTools.sort((a, b) => a.function.name.localeCompare(b.function.name));
    requestBody.tools = openaiTools;
    requestBody.tool_choice = 'auto';
  }

  // Reasoner models: map thinkingBudget to reasoning_effort
  if (config.model?.includes('reasoner') && config.thinkingBudget) {
    const effort = config.thinkingBudget <= 4096 ? 'low' : config.thinkingBudget <= 16384 ? 'medium' : 'high';
    requestBody.reasoning_effort = effort;
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
      timeout: PROVIDER_TIMEOUT,
      httpsAgent,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
      responseType: 'json',
      signal,
    });

    logger.info(' DeepSeek raw response:', JSON.stringify(response.data, null, 2).substring(0, 2000));
    return parseOpenAIResponse(response.data);
  } catch (error: unknown) {
    const errMsg = error instanceof Error ? error.message : String(error);
    if (axios.isCancel(error) || (error instanceof Error ? error.name : undefined) === 'AbortError' || (error instanceof Error ? error.name : undefined) === 'CanceledError') {
      throw new Error('Request was cancelled');
    }
    if (axios.isAxiosError(error) && error.response) {
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
    throw new Error(`DeepSeek request failed: ${errMsg}`);
  }
}
