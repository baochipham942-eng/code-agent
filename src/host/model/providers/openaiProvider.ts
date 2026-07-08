// ============================================================================
// OpenAIProvider - OpenAI API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages } from './shared';
import { getModelMaxOutputTokens } from '../../../shared/constants';
import { resolveProviderBaseUrl, resolveProviderApiKey } from './providerResolution';
import { createLogger } from '../../services/infra/logger';
import { resolveModelRequestTemperature } from '../../../shared/modelSampling';

const logger = createLogger('OpenAIProvider');

export class OpenAIProvider extends BaseOpenAIProvider {
  readonly name = 'OpenAI';

  protected getBaseUrl(config: ModelConfig): string {
    return resolveProviderBaseUrl(config);
  }

  protected getApiKey(config: ModelConfig): string {
    return resolveProviderApiKey(config);
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
      temperature: resolveModelRequestTemperature(config.model, config.temperature ?? 0.7),
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
