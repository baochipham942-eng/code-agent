// ============================================================================
// ZhipuProvider - 智谱 GLM API Provider 实现
// 包含自适应限流器，防止并发过高触发限流
// ============================================================================

import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { InferenceOptions, ModelMessage, ModelResponse, StreamCallback } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { DEFAULT_MODELS, getModelMaxOutputTokens } from '../../../shared/constants';
import { getProviderLimiter } from '../concurrencyLimiter';
import { resolveProviderBaseUrl, resolveProviderApiKey } from './providerResolution';

// 智谱并发限流器：与 quick model 路径共用同一实例（见 concurrencyLimiter + PROVIDER_CONCURRENCY_LIMITS）
const zhipuLimiter = getProviderLimiter('zhipu');

export class ZhipuProvider extends BaseOpenAIProvider {
  readonly name = '智谱';

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
    const zhipuTools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || DEFAULT_MODELS.quick,
      messages: useToolCalling
        ? convertToOpenAIMessages(messages)
        : convertToTextOnlyMessages(messages),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? getModelMaxOutputTokens(config.model || DEFAULT_MODELS.quick),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (useToolCalling && zhipuTools.length > 0) {
      body.tools = zhipuTools;
      body.tool_choice = 'auto';
    }

    return body;
  }

  /**
   * Override inference to wrap with rate limiter
   */
  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
  ): Promise<ModelResponse> {
    if (signal?.aborted) {
      throw new Error('Request was cancelled before starting');
    }

    // 限流：等待获取请求许可
    await zhipuLimiter?.acquire(signal);

    try {
      const result = await super.inference(messages, tools, config, onStream, signal, options);
      zhipuLimiter?.onSuccess();
      return result;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('1302') || msg.includes('速率限制') || msg.includes('rate limit')) {
        zhipuLimiter?.onRateLimit();
      }
      throw err;
    } finally {
      zhipuLimiter?.release();
    }
  }
}
