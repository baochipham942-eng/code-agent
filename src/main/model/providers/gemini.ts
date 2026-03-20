// ============================================================================
// Google Gemini Provider Implementation
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  electronFetch,
  convertToGeminiMessages,
  parseGeminiResponse,
  handleGeminiStream,
  parseContextLengthError,
} from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';
import { isFallbackEligible } from './retryStrategy';

/**
 * Call Google Gemini API
 * @param signal - AbortSignal for cancellation support
 */
export async function callGemini(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.gemini;
  const model = config.model || 'gemini-3-flash-preview';

  // 转换消息为 Gemini 格式
  const geminiContents = convertToGeminiMessages(messages);

  // 转换工具为 Gemini 格式
  const geminiTools = tools.length > 0 ? [{
    function_declarations: tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    })),
  }] : undefined;

  const recommendedMaxTokens = getModelMaxOutputTokens(config.model || 'gemini-2.5-flash');

  const requestBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      temperature: config.temperature ?? 0.7,
      maxOutputTokens: config.maxTokens ?? recommendedMaxTokens,
    },
  };

  if (geminiTools) {
    requestBody.tools = geminiTools;
  }

  // Check for cancellation before starting
  if (signal?.aborted) {
    throw new Error('Request was cancelled before starting');
  }

  const endpoint = onStream ? 'streamGenerateContent' : 'generateContent';
  const url = `${baseUrl}/models/${model}:${endpoint}`;

  try {
    const response = await electronFetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': config.apiKey!,
      },
      body: JSON.stringify(requestBody),
      signal,
    });

    if (!response.ok) {
      const error = await response.text();

      const contextError = parseContextLengthError(error, 'gemini');
      if (contextError) {
        throw contextError;
      }

      throw new Error(`Gemini API error: ${response.status} - ${error}`);
    }

    if (onStream && response.body) {
      return handleGeminiStream(response.body, onStream, signal);
    }

    const data = await response.json();
    return parseGeminiResponse(data);
  } catch (error: unknown) {
    // Re-throw cancellation errors directly
    if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Request was cancelled before starting')) {
      throw error;
    }

    const errMsg = error instanceof Error ? error.message : String(error);

    // Check for context length errors
    const contextError = parseContextLengthError(errMsg, 'gemini');
    if (contextError) {
      throw contextError;
    }

    // Mark fallback-eligible errors
    if (isFallbackEligible(errMsg)) {
      const fallbackError = new Error(`Gemini request failed: ${errMsg}`);
      (fallbackError as unknown as Record<string, unknown>).fallbackEligible = true;
      throw fallbackError;
    }

    throw error;
  }
}
