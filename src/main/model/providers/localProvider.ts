// ============================================================================
// LocalProvider - Ollama 本地模型 Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToTextOnlyMessages } from './shared';

export class LocalProvider extends BaseOpenAIProvider {
  readonly name = 'Local';

  protected getBaseUrl(config: ModelConfig): string {
    return config.baseUrl || 'http://localhost:11434/v1';
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
    const openaiTools = convertToolsToOpenAI(tools);

    // 大多数本地模型 tool calling 支持不完整，用纯文本回退
    const body: Record<string, unknown> = {
      model: config.model || 'qwen2.5-coder:7b',
      messages: convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      stream: true,
    };

    if (openaiTools.length > 0) {
      body.tools = openaiTools;
    }

    return body;
  }
}
