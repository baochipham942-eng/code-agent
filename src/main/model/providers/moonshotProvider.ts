// ============================================================================
// MoonshotProvider - Kimi K2.5 Provider 实现
// ============================================================================

import https from 'https';
import type { ModelConfig, ToolDefinition } from '../../../shared/contract';
import type { ModelMessage } from '../types';
import { BaseOpenAIProvider } from './baseOpenAIProvider';
import { MODEL_API_ENDPOINTS, MODEL_MAX_TOKENS, DEFAULT_MODEL } from '../../../shared/constants';
import { httpsAgent, convertToolsToOpenAI, convertToOpenAIMessages } from './shared';

// 专用 HTTPS Agent: 禁用 keepAlive 避免 SSE 流结束后连接复用导致 "socket hang up"
const moonshotAgent = httpsAgent || new https.Agent({
  keepAlive: false,
  maxSockets: 10,
});

export class MoonshotProvider extends BaseOpenAIProvider {
  readonly name = 'Moonshot';

  protected getBaseUrl(config: ModelConfig): string {
    const isKimiK25 = config.model === 'kimi-k2.5';
    return isKimiK25
      ? (process.env.KIMI_K25_API_URL || MODEL_API_ENDPOINTS.kimiK25)
      : (config.baseUrl || MODEL_API_ENDPOINTS.moonshot);
  }

  protected getApiKey(config: ModelConfig): string {
    const isKimiK25 = config.model === 'kimi-k2.5';
    return isKimiK25
      ? (process.env.KIMI_K25_API_KEY || config.apiKey || '')
      : (config.apiKey || '');
  }

  protected getAgent(): https.Agent {
    return moonshotAgent;
  }

  protected getExtraHeaders(): Record<string, string> {
    return { 'User-Agent': 'claude-code/1.0' };
  }

  protected isThinkingMode(_config: ModelConfig): boolean {
    // Kimi K2.5 走 thinking-mode 协议，与 DeepSeek 同。
    return true;
  }

  // Override base to align sampling defaults with Moonshot's official guidance
  // for thinking-mode Kimi-K2.5: temperature=1.0, top_p=0.95.
  // (Same recipe as mimo-v2.5-pro — both vendors publish identical thinking
  // sampling, distinct from the generic OpenAI-style 0.7 default in base.)
  protected buildRequestBody(
    messages: ModelMessage[],
    tools: ToolDefinition[],
    config: ModelConfig,
  ): Record<string, unknown> {
    const openAITools = convertToolsToOpenAI(tools);
    const body: Record<string, unknown> = {
      model: config.model || DEFAULT_MODEL,
      messages: convertToOpenAIMessages(messages, { thinkingMode: this.isThinkingMode(config) }),
      temperature: config.temperature ?? 1.0,
      top_p: 0.95,
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
}
