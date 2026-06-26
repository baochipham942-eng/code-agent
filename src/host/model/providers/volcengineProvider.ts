// ============================================================================
// VolcengineProvider - 火山引擎 (豆包) API Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { getModelMaxOutputTokens } from '../../../shared/constants';
import { resolveProviderBaseUrl, resolveProviderApiKey } from './providerResolution';

export class VolcengineProvider extends BaseOpenAIProvider {
  readonly name = 'Volcengine';

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
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const openaiTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || 'doubao-1.5-pro-256k',
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || 'doubao-1.5-pro-256k'),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useToolCalling && openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
