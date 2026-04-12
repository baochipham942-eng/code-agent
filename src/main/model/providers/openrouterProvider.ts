// ============================================================================
// OpenRouterProvider - OpenRouter API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToOpenAIMessages, convertToTextOnlyMessages, normalizeJsonSchema } from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('OpenRouterProvider');

export class OpenRouterProvider extends BaseOpenAIProvider {
  readonly name = 'OpenRouter';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.openrouter;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected getExtraHeaders(): Record<string, string> {
    return {
      'HTTP-Referer': 'https://code-agent.app',
      'X-Title': 'Code Agent',
    };
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const recommendedMaxTokens = modelInfo?.maxTokens || getModelMaxOutputTokens(config.model || 'google/gemini-3-flash-preview');

    // OpenRouter 使用自定义 tool 转换（normalizeJsonSchema）
    const openrouterTools = tools.map((tool) => ({
      type: 'function' as const,
      function: {
        name: tool.name,
        description: tool.description,
        parameters: normalizeJsonSchema(tool.inputSchema as unknown as Record<string, unknown>) as Record<string, unknown>,
      },
    }));

    const body: Record<string, unknown> = {
      model: config.model || 'google/gemini-3-flash-preview',
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? recommendedMaxTokens,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (config.responseFormat) {
      body.response_format = config.responseFormat;
      logger.debug('OpenRouter: Using response_format:', config.responseFormat.type);
    }

    if (useToolCalling && openrouterTools.length > 0) {
      body.tools = openrouterTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
