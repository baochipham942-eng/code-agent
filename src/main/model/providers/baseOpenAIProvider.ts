// ============================================================================
// BaseOpenAIProvider - OpenAI 兼容 Provider 基类
// ============================================================================

import https from 'https';
import http from 'http';
import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/contract';
import type { ModelMessage, ModelResponse, StreamCallback, Provider } from '../types';
import { convertToolsToOpenAI, convertToOpenAIMessages, convertToTextOnlyMessages } from './shared';
import { openAISSEStream } from './sseStream';
import { withTransientRetry } from './retryStrategy';
import { MODEL_MAX_TOKENS, DEFAULT_MODEL } from '../../../shared/constants';
import { PROVIDER_REGISTRY } from '../providerRegistry';
import { createLogger } from '../../services/infra/logger';

const logger = createLogger('BaseOpenAIProvider');

/**
 * OpenAI 兼容 Provider 抽象基类
 *
 * 封装通用逻辑，子类只需实现：
 * - getBaseUrl(config) — 返回 API base URL
 * - getApiKey(config) — 返回 API key
 *
 * 可选 override：
 * - getAgent() — 返回自定义 HTTPS Agent
 * - getExtraHeaders() — 返回额外请求头
 * - buildRequestBody(messages, tools, config) — 自定义请求体
 */
export abstract class BaseOpenAIProvider implements Provider {
  abstract readonly name: string;

  /** 返回 API base URL */
  protected abstract getBaseUrl(config: ModelConfig): string;

  /** 返回 API key */
  protected abstract getApiKey(config: ModelConfig): string;

  /** 返回自定义 HTTPS Agent（可选） */
  protected getAgent(): https.Agent | http.Agent | undefined {
    return undefined;
  }

  /** 返回额外请求头（可选） */
  protected getExtraHeaders(): Record<string, string> | undefined {
    return undefined;
  }

  /** API 路径（可选 override），默认使用 openAISSEStream 的 /chat/completions */
  protected getEndpoint(): string | undefined {
    return undefined;
  }

  /** 是否要求 API key（Local/Ollama 不需要） */
  protected requiresApiKey(): boolean {
    return true;
  }

  /** 从 PROVIDER_REGISTRY 查找模型信息 */
  protected getModelInfo(config: ModelConfig): ModelInfo | null {
    const provider = PROVIDER_REGISTRY[config.provider];
    if (!provider) return null;
    return provider.models.find(m => m.id === config.model) || null;
  }

  /**
   * 是否走 thinking-mode 协议（DeepSeek/Kimi 这类要求 history 中所有 assistant 消息
   * 携带 reasoning_content 字段的模型）。子类按需 override 返回 true。
   */
  protected isThinkingMode(_config: ModelConfig): boolean {
    return false;
  }

  /**
   * 构建请求体
   * 默认实现，子类可 override 来定制
   */
  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig
  ): Record<string, unknown> {
    const openAITools = convertToolsToOpenAI(tools);

    const body: Record<string, unknown> = {
      model: config.model || DEFAULT_MODEL,
      messages: convertToOpenAIMessages(messages, { thinkingMode: this.isThinkingMode(config) }),
      temperature: config.temperature ?? 0.7,
      max_tokens: config.maxTokens ?? MODEL_MAX_TOKENS.DEFAULT,
      stream: true,
      stream_options: { include_usage: true },
    };

    if (openAITools.length > 0) {
      body.tools = openAITools;
      body.tool_choice = 'auto';
    }

    return body;
  }

  /**
   * 主推理入口
   */
  async inference(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal
  ): Promise<ModelResponse> {
    const baseUrl = this.getBaseUrl(config);
    const apiKey = this.getApiKey(config);

    if (this.requiresApiKey() && !apiKey) {
      throw new Error(`${this.name} API key not configured`);
    }

    const requestBody = this.buildRequestBody(messages, tools, config);

    logger.info(`[${this.name}] 请求: model=${requestBody.model}, baseUrl=${baseUrl}, stream=true`);

    return withTransientRetry(
      () => openAISSEStream({
        providerName: this.name,
        baseUrl,
        apiKey,
        requestBody,
        onStream,
        signal,
        agent: this.getAgent(),
        extraHeaders: this.getExtraHeaders(),
        endpoint: this.getEndpoint(),
      }),
      { providerName: this.name, signal }
    );
  }
}
