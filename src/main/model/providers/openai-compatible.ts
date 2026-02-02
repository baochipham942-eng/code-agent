// ============================================================================
// OpenAI-Compatible Provider Implementations
// Including: OpenAI, Groq, Qwen, Moonshot, MiniMax, Perplexity, Local (Ollama)
// ============================================================================

import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  electronFetch,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  parseOpenAIResponse,
  handleStream,
  normalizeJsonSchema,
} from './shared';

/**
 * Call OpenAI API
 * @param signal - AbortSignal for cancellation support
 */
export async function callOpenAI(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  _onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';

  const openaiTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'gpt-4o',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
  };

  if (config.responseFormat) {
    requestBody.response_format = config.responseFormat;
    logger.debug(' OpenAI: Using response_format:', config.responseFormat.type);
  }

  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
  }

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`OpenAI API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

/**
 * Call Groq API
 * @param signal - AbortSignal for cancellation support
 */
export async function callGroq(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://api.groq.com/openai/v1';

  const groqTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'llama-3.3-70b-versatile',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onStream,
  };

  // Groq 部分模型不支持 tools
  if (groqTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = groqTools;
    requestBody.tool_choice = 'auto';
  }

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Groq API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

/**
 * Call Local (Ollama) API
 * @param signal - AbortSignal for cancellation support
 */
export async function callLocal(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'http://localhost:11434/v1';

  const openaiTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'qwen2.5-coder:7b',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    stream: !!onStream,
  };

  if (openaiTools.length > 0) {
    requestBody.tools = openaiTools;
  }

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Local model error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

/**
 * Call Qwen (通义千问) API
 * @param signal - AbortSignal for cancellation support
 */
export async function callQwen(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://dashscope.aliyuncs.com/compatible-mode/v1';

  const qwenTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'qwen-max',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onStream,
  };

  if (qwenTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = qwenTools;
    requestBody.tool_choice = 'auto';
  }

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`千问 API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

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
    ? (process.env.KIMI_K25_API_URL || 'https://cn.haioi.net/v1')
    : (config.baseUrl || 'https://api.moonshot.cn/v1');
  const apiKey = isKimiK25
    ? (process.env.KIMI_K25_API_KEY || config.apiKey)
    : config.apiKey;

  const moonshotTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'moonshot-v1-8k',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onStream,
  };

  if (moonshotTools.length > 0) {
    requestBody.tools = moonshotTools;
    requestBody.tool_choice = 'auto';
  }

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Moonshot API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

/**
 * Call MiniMax API
 * @param signal - AbortSignal for cancellation support
 */
export async function callMinimax(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  modelInfo: ModelInfo | null,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://api.minimax.chat/v1';

  const minimaxTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'abab6.5s-chat',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onStream,
  };

  if (minimaxTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = minimaxTools;
    requestBody.tool_choice = 'auto';
  }

  const response = await electronFetch(`${baseUrl}/text/chatcompletion_v2`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`MiniMax API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}

/**
 * Call Perplexity API (联网搜索)
 * @param signal - AbortSignal for cancellation support
 */
export async function callPerplexity(
  messages: ModelMessage[],
  _tools: ToolDefinition[],
  config: ModelConfig,
  onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || 'https://api.perplexity.ai';

  // Perplexity 不支持工具调用
  const requestBody: Record<string, unknown> = {
    model: config.model || 'sonar-pro',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 4096,
    stream: !!onStream,
  };

  const response = await electronFetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(requestBody),
    signal,
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Perplexity API error: ${response.status} - ${error}`);
  }

  if (onStream && response.body) {
    return handleStream(response.body, onStream, signal);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}
