// ============================================================================
// DeepSeekProvider - DeepSeek API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { MODEL_API_ENDPOINTS, DEFAULT_MODELS, getModelMaxOutputTokens } from '../../../shared/constants';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('DeepSeekProvider');

export class DeepSeekProvider extends BaseOpenAIProvider {
  readonly name = 'DeepSeek';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.deepseek;
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
    const openaiTools = convertToolsToOpenAI(tools, true);
    const recommendedMaxTokens = modelInfo?.maxTokens || getModelMaxOutputTokens(config.model || DEFAULT_MODELS.chat);

    const body: Record<string, unknown> = {
      model: config.model || DEFAULT_MODELS.chat,
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
      logger.debug('DeepSeek: Using response_format:', config.responseFormat.type);
    }

    if (useToolCalling && openaiTools.length > 0) {
      // Sort tools by name for stable cache prefix (prompt caching optimization)
      openaiTools.sort((a, b) => a.function.name.localeCompare(b.function.name));
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    // Reasoner models: map thinkingBudget to reasoning_effort
    if (config.model?.includes('reasoner') && config.thinkingBudget) {
      const effort = config.thinkingBudget <= 4096 ? 'low' : config.thinkingBudget <= 16384 ? 'medium' : 'high';
      body.reasoning_effort = effort;
    }

    return body;
  }
}
