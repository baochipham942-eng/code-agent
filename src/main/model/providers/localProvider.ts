// ============================================================================
// LocalProvider - Ollama 本地模型 Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';

export class LocalProvider extends BaseOpenAIProvider {
  readonly name = 'Local';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || MODEL_API_ENDPOINTS.ollama;
  }

  protected getApiKey(): string {
    return 'ollama'; // Ollama 不需要 API key，但 HTTP header 需要非空值
  }

  protected requiresApiKey(): boolean {
    return false;
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool === true;
    const openaiTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || 'qwen2.5-coder:7b',
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      stream: true,
    };

    if (useToolCalling && openaiTools.length > 0) {
      body.tools = openaiTools;
      body.tool_choice = 'auto';
    }

    return body;
  }
}
