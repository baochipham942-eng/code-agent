// ============================================================================
// Model Types - Type definitions for model routing
// ============================================================================

import type { ToolCall } from '../../shared/types';

// ----------------------------------------------------------------------------
// Message Types
// ----------------------------------------------------------------------------

export interface ModelMessage {
  role: string;
  content: string | MessageContent[];
}

export interface MessageContent {
  type: 'text' | 'image';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
}

// ----------------------------------------------------------------------------
// Response Types
// ----------------------------------------------------------------------------

export interface ModelResponse {
  type: 'text' | 'tool_use';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean; // 标记输出是否因 max_tokens 限制被截断
  finishReason?: string; // 原始的 finish_reason
}

// ----------------------------------------------------------------------------
// Stream Types
// ----------------------------------------------------------------------------

export interface StreamChunk {
  type: 'text' | 'tool_call_start' | 'tool_call_delta';
  content?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
}

export type StreamCallback = (chunk: string | StreamChunk) => void;

// ----------------------------------------------------------------------------
// Error Types
// ----------------------------------------------------------------------------

/**
 * 上下文长度超限错误
 * 当请求的 token 数超过模型最大上下文限制时抛出
 */
export class ContextLengthExceededError extends Error {
  public readonly code = 'CONTEXT_LENGTH_EXCEEDED';

  constructor(
    public readonly requestedTokens: number,
    public readonly maxTokens: number,
    public readonly provider: string
  ) {
    super(`上下文长度超出限制: 请求 ${requestedTokens.toLocaleString()} tokens，最大 ${maxTokens.toLocaleString()} tokens`);
    this.name = 'ContextLengthExceededError';
  }
}

/**
 * 检测错误消息是否为上下文超限错误，并提取相关信息
 */
export function parseContextLengthError(errorMessage: string, provider: string): ContextLengthExceededError | null {
  // DeepSeek 格式: "This model's maximum context length is 131072 tokens. However, you requested 5472941 tokens"
  const deepseekMatch = errorMessage.match(
    /maximum context length is (\d+).*?requested (\d+)/i
  );
  if (deepseekMatch) {
    return new ContextLengthExceededError(
      parseInt(deepseekMatch[2]),
      parseInt(deepseekMatch[1]),
      provider
    );
  }

  // OpenAI 格式: "This model's maximum context length is X tokens, however you requested Y tokens"
  const openaiMatch = errorMessage.match(
    /maximum context length is (\d+).*?you requested (\d+)/i
  );
  if (openaiMatch) {
    return new ContextLengthExceededError(
      parseInt(openaiMatch[2]),
      parseInt(openaiMatch[1]),
      provider
    );
  }

  // Claude 格式: "prompt is too long: X tokens > Y maximum"
  const claudeMatch = errorMessage.match(
    /prompt is too long:\s*(\d+)\s*tokens?\s*>\s*(\d+)/i
  );
  if (claudeMatch) {
    return new ContextLengthExceededError(
      parseInt(claudeMatch[1]),
      parseInt(claudeMatch[2]),
      provider
    );
  }

  // 通用检测：包含 "context length" 或 "token limit" 等关键词
  if (/context.?length|token.?limit|max.?tokens?.*exceeded/i.test(errorMessage)) {
    // 尝试提取数字
    const numbers = errorMessage.match(/\d+/g);
    if (numbers && numbers.length >= 2) {
      const sorted = numbers.map(n => parseInt(n)).sort((a, b) => b - a);
      return new ContextLengthExceededError(sorted[0], sorted[1], provider);
    }
  }

  return null;
}
