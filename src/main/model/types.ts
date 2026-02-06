// ============================================================================
// Model Router Types
// ============================================================================

import type { ToolCall } from '../../shared/types';

// ----------------------------------------------------------------------------
// Message Types
// ----------------------------------------------------------------------------

export interface MessageContent {
  type: 'text' | 'image' | 'thinking' | 'compaction';
  text?: string;
  source?: {
    type: 'base64';
    media_type: string;
    data: string;
  };
  // Adaptive Thinking: 思考内容
  thinking?: string;
  // Compaction: 压缩摘要
  compaction?: string;
}

export interface ModelMessage {
  role: string;
  content: string | MessageContent[];
}

// ----------------------------------------------------------------------------
// Response Types
// ----------------------------------------------------------------------------

export interface ModelResponse {
  type: 'text' | 'tool_use' | 'thinking';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean;
  finishReason?: string;
  // Adaptive Thinking: 思考过程
  thinking?: string;
}

// ----------------------------------------------------------------------------
// Streaming Types
// ----------------------------------------------------------------------------

export interface StreamChunk {
  type: 'text' | 'reasoning' | 'tool_call_start' | 'tool_call_delta';
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
// Tool Call Accumulator (for streaming)
// ----------------------------------------------------------------------------

export interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

// ----------------------------------------------------------------------------
// Custom Error Types
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
