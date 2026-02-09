// ============================================================================
// OpenAI-Compatible Provider Implementations
// Including: OpenAI, Groq, Qwen, MiniMax, Perplexity, Local (Ollama)
// ============================================================================

import type { ModelConfig, ToolDefinition, ModelInfo } from '../../../shared/types';
import type { ModelMessage, ModelResponse, StreamCallback } from '../types';
import {
  logger,
  electronFetch,
  convertToolsToOpenAI,
  convertToOpenAIMessages,
  parseOpenAIResponse,
} from './shared';
import { MODEL_API_ENDPOINTS } from '../../../shared/constants';
import { openAISSEStream } from './sseStream';

/**
 * Call OpenAI API (non-streaming only)
 * @param signal - AbortSignal for cancellation support
 */
export async function callOpenAI(
  messages: ModelMessage[],
  tools: ToolDefinition[],
  config: ModelConfig,
  _onStream?: StreamCallback,
  signal?: AbortSignal
): Promise<ModelResponse> {
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.openai;

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

  const openaiTools = convertToolsToOpenAI(tools);
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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.groq;
  const groqTools = convertToolsToOpenAI(tools);

  const requestBody: Record<string, unknown> = {
    model: config.model || 'llama-3.3-70b-versatile',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 8192,
    stream: !!onStream,
  };

  if (groqTools.length > 0 && modelInfo?.supportsTool) {
    requestBody.tools = groqTools;
    requestBody.tool_choice = 'auto';
  }

  if (onStream) {
    return openAISSEStream({
      providerName: 'Groq',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
    });
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

  if (onStream) {
    return openAISSEStream({
      providerName: 'Local',
      baseUrl,
      apiKey: '',
      requestBody,
      onStream,
      signal,
    });
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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.qwen;
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

  if (onStream) {
    return openAISSEStream({
      providerName: 'Qwen',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
    });
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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.minimax;
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

  if (onStream) {
    return openAISSEStream({
      providerName: 'MiniMax',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
      endpoint: '/text/chatcompletion_v2',
    });
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
  const baseUrl = config.baseUrl || MODEL_API_ENDPOINTS.perplexity;

  const requestBody: Record<string, unknown> = {
    model: config.model || 'sonar-pro',
    messages: convertToOpenAIMessages(messages),
    temperature: config.temperature ?? 0.7,
    max_tokens: config.maxTokens ?? 4096,
    stream: !!onStream,
  };

  if (onStream) {
    return openAISSEStream({
      providerName: 'Perplexity',
      baseUrl,
      apiKey: config.apiKey!,
      requestBody,
      onStream,
      signal,
    });
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
    throw new Error(`Perplexity API error: ${response.status} - ${error}`);
  }

  const data = await response.json();
  return parseOpenAIResponse(data);
}
