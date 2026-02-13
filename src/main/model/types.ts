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

/**
 * 结构化工具调用（OpenAI wire format）
 * 由 buildModelMessages() 从 Message.toolCalls 转换而来
 */
export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string; // JSON string
}

export interface ModelMessage {
  role: string;
  content: string | MessageContent[];
  /** assistant 消息的结构化工具调用（保留 id/name/args） */
  toolCalls?: ModelToolCall[];
  /** tool 消息关联的 tool_call_id（OpenAI 协议要求） */
  toolCallId?: string;
  /** 文本回退（给不支持 tool calling 的模型用） */
  toolCallText?: string;
  /** 推理/思考内容（Kimi reasoning / DeepSeek reasoning_content） */
  thinking?: string;
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
  // Token usage from API response
  usage?: { inputTokens: number; outputTokens: number };
}

// ----------------------------------------------------------------------------
// Streaming Types
// ----------------------------------------------------------------------------

export interface StreamChunk {
  type: 'text' | 'reasoning' | 'tool_call_start' | 'tool_call_delta' | 'token_estimate' | 'complete' | 'usage' | 'error';
  content?: string;
  toolCall?: {
    index: number;
    id?: string;
    name?: string;
    argumentsDelta?: string;
  };
  // Real-time token estimation (type: 'token_estimate')
  inputTokens?: number;
  outputTokens?: number;
  // complete event
  finishReason?: string;
  // error event
  error?: string;
  errorCode?: string;
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
// Provider Interface
// ----------------------------------------------------------------------------

export interface Provider {
  readonly name: string;
  inference(
    messages: ModelMessage[],
    tools: import('../../shared/types').ToolDefinition[],
    config: import('../../shared/types').ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal
  ): Promise<ModelResponse>;
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
