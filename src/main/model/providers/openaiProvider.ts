// ============================================================================
// OpenAIProvider - OpenAI API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages } from './shared';
import { MODEL_API_ENDPOINTS, getModelMaxOutputTokens } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('OpenAIProvider');

export class OpenAIProvider extends BaseOpenAIProvider {
  readonly name = 'OpenAI';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.openai;
  }

  protected getApiKey(config: ModelConfig): string {
    return config.apiKey || '';
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const openaiTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || 'gpt-4o',
      messages: convertToOpenAIMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'gpt-4o'),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (config.responseFormat) {
      body.response_format = config.responseFormat;
      logger.debug('OpenAI: Using response_format:', config.responseFormat.type);
    }

    if (openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
