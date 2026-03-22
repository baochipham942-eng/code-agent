// ============================================================================
// PerplexityProvider - Perplexity API Provider 实现（联网搜索）
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToOpenAIMessages } from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';

export class PerplexityProvider extends BaseOpenAIProvider {
  readonly name = 'Perplexity';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.perplexity;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    _tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    // Perplexity 不支持 tool calling，忽略 tools
    return {
      model: config.model || 'sonar-pro',
      messages: convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'sonar-pro'),
      stream: true,
      stream_options: { include_usage: true },
    };
  }
}
