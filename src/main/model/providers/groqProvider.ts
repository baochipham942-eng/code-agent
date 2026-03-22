// ============================================================================
// GroqProvider - Groq API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';

export class GroqProvider extends BaseOpenAIProvider {
  readonly name = 'Groq';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.groq;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const groqTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || 'llama-3.3-70b-versatile',
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'llama-3.3-70b-versatile'),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useToolCalling && groqTools.length > 0) {
      body.tools = groqTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
