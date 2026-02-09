// ============================================================================
// Moonshot (Kimi) Provider Implementation
// 支持 Kimi K2.5 第三方代理的 SSE 流式响应
// ============================================================================

import https from 'https';
import type { ModelConfig, ToolDefinition } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import { logger, httpsAgent, convertToolsToOpenAI, convertToOpenAIMessages } from './shared';
import { MODEL_API_ENDPOINTS, MODEL_MAX_TOKENS, DEFAULT_MODEL } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';

// 专用 HTTPS Agent: 禁用 keepAlive 避免 SSE 流结束后连接复用导致 "socket hang up"
// Node.js 19+ 的 globalAgent 默认 keepAlive=true，会导致并发子代理请求复用已关闭的连接
const moonshotAgent = httpsAgent || new https.Agent({
  keepAlive: false,
  maxSockets: 10,
});

/**
 * Call Moonshot (Kimi) API
 * 支持 Kimi K2.5 包月套餐（第三方代理）
 * @param signal - AbortSignal for cancellation support
 */
export async function callMoonshot(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  // Kimi K2.5 使用单独的 API key 和 URL（包月套餐）
  const isKimiK25 = config.model === 'kimi-k2.5';
  const baseUrl = isKimiK25
    ? (process.env.KIMI_K25_API_URL || MODEL_API_ENDPOINTS.kimiK25)
    : (config.baseUrl || MODEL_API_ENDPOINTS.moonshot);
  const apiKey = isKimiK25
    ? (process.env.KIMI_K25_API_KEY || config.apiKey)
    : config.apiKey;

  if (!apiKey) {
    throw new Error('Moonshot API key not configured');
  }

  const moonshotTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || DEFAULT_MODEL,
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? MODEL_MAX_TOKENS.DEFAULT,
    stream: true,
  };

  if (moonshotTools.length > 0) {
    requestBody.tools = moonshotTools;
    requestBody.tool_choice = 'auto';
  }

  logger.info(`[Moonshot] 请求: model=${requestBody.model}, baseUrl=${baseUrl}, stream=true`);

  // 带重试的流式请求（处理 socket hang up 等瞬态错误）
  const MAX_RETRIES = 2;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      return await openAISSEStream({
        providerName: 'Moonshot',
        baseUrl,
        apiKey,
        requestBody,
        onStream,
        signal,
        agent: moonshotAgent,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient = msg.includes('socket hang up') || msg.includes('ECONNRESET') || msg.includes('ECONNREFUSED');
      if (isTransient && attempt < MAX_RETRIES && !signal?.aborted) {
        const delay = (attempt + 1) * 1000;
        logger.warn(`[Moonshot] 瞬态错误 "${msg}", ${delay}ms 后重试 (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw new Error('[Moonshot] 不应到达此处');
}
