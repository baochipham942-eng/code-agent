// ============================================================================
// XiaomiProvider - 小米 MiMo (Token Plan 包月) Provider 实现
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { getModelMaxOutputTokens } from '../../../shared/constants';
import { resolveProviderBaseUrl, resolveProviderApiKey } from './providerResolution';

const XIAOMI_DEFAULT_MODEL = 'mimo-v2.5-pro';

export class XiaomiProvider extends BaseOpenAIProvider {
  readonly name = 'Xiaomi';

  protected getBaseUrl(config: ModelConfig): string {
    return resolveProviderBaseUrl(config);
  }

  protected getApiKey(config: ModelConfig): string {
    return resolveProviderApiKey(config);
  }

  // 所有 mimo-v2/v2.5 系列均返回 reasoning_content（thinking-mode），
  // history 里的 assistant 消息需带 reasoning_content 字段才能正常续聊。
  protected isThinkingMode(_config: ModelConfig): boolean {
    return true;
  }

  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const modelInfo = this.getModelInfo(config);
    const useToolCalling = modelInfo?.supportsTool !== false;
    const openaiTools = convertToolsToOpenAI(tools);

    // Sampling: align with mimo official guidance for thinking-mode models
    // (temperature=1.0, top_p=0.95). Caller-supplied config.temperature
    // wins. top_p is only set when not provided by the caller.
    const body: Record<string, unknown> = {
      model: config.model || XIAOMI_DEFAULT_MODEL,
      messages: useToolCalling
        ? convertToOpenAIMessages(messages, { thinkingMode: this.isThinkingMode(config) })
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 1.0,
      top_p: 0.95,
      max_completion_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || XIAOMI_DEFAULT_MODEL),
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
