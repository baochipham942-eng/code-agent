// ============================================================================
// GeminiProvider - Google Gemini API Provider 实现
// 完全不同的 API 格式：generateContent / streamGenerateContent
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback, Provider } from '../types';
import {
  electronFetch,
  convertToGeminiMessages,
  parseGeminiResponse,
  handleGeminiStream,
  parseContextLengthError,
} from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';
import { isFallbackEligible } from './retryStrategy';

export class GeminiProvider implements Provider {
  readonly name = 'Gemini';

  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.gemini;
    const model = config.model || 'gemini-3-flash-preview';

    const geminiContents = convertToGeminiMessages(messages);

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
      if (error instanceof Error && (error.name === 'AbortError' || error.message === 'Request was cancelled before starting')) {
        throw error;
      }

      const errMsg = error instanceof Error ? error.message : String(error);

      const contextError = parseContextLengthError(errMsg, 'gemini');
      if (contextError) {
        throw contextError;
      }

      if (isFallbackEligible(errMsg)) {
        const fallbackError = new Error(`Gemini request failed: ${errMsg}`);
        (fallbackError as unknown as Record<string, unknown>).fallbackEligible = true;
        throw fallbackError;
      }

      throw error;
    }
  }
}
