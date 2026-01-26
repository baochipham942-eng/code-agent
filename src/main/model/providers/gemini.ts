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
} from './shared';

/**
 * Call Google Gemini API
 */
export async function callGemini(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://generativelanguage.googleapis.com/v1beta';
  const model = config.model || 'gemini-2.5-flash';

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

  const requestBody: Record<string, unknown> = {
    contents: geminiContents,
    generationConfig: {
      temperature: config.temperature ?? 0.7,
      maxOutputTokens: config.maxTokens ?? 8192,
    },
  };

  if (geminiTools) {
    requestBody.tools = geminiTools;
  }

  const endpoint = onStream ? 'streamGenerateContent' : 'generateContent';
  const url = `${baseUrl}/models/${model}:${endpoint}?key=${config.apiKey}`;

  const response = await electronFetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Gemini API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleGeminiStream(response.body, onStream);
  }

  const data = await response.json();
  return parseGeminiResponse(data);
}
