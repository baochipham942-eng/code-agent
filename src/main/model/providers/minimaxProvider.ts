// ============================================================================
// MinimaxProvider - MiniMax API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';

export class MinimaxProvider extends BaseOpenAIProvider {
  readonly name = 'MiniMax';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.minimax;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected getEndpoint(): string {
    return '/chat/completions';
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const minimaxTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || 'abab6.5s-chat',
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'abab6.5s-chat'),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useToolCalling && minimaxTools.length > 0) {
      body.tools = minimaxTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
