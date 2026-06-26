// ============================================================================
// Model Router Types
// ============================================================================

import type { ToolCall } from '../../shared/contract';
import type { ModelDecisionEventData, ModelFallbackInfo, ModelToolStrategyDiagnostics } from '../../shared/contract/modelDecision';

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
  /** tool 消息是否为失败结果（Claude tool_result 需要 is_error） */
  toolError?: boolean;
  /** 文本回退（给不支持 tool calling 的模型用） */
  toolCallText?: string;
  /** 推理/思考内容（Kimi reasoning / DeepSeek reasoning_content） */
  thinking?: string;
}

// ----------------------------------------------------------------------------
// Response Types
// ----------------------------------------------------------------------------

// 内容块顺序（保留 text 和 tool_call 的交错信息）
export type ResponseContentPart =
  | { type: 'text'; text: string }
  | { type: 'tool_call'; toolCallId: string };

export interface ModelResponse {
  type: 'text' | 'tool_use' | 'thinking';
  content?: string;
  toolCalls?: ToolCall[];
  truncated?: boolean;
  finishReason?: string;
  actualProvider?: string;
  actualModel?: string;
  fallback?: ModelFallbackInfo;
  // Adaptive Thinking: 思考过程
  thinking?: string;
  // Token usage from API response
  usage?: { inputTokens: number; outputTokens: number; providerReportedSavedTokens?: number };
  // 内容块顺序（text 和 tool_call 的交错顺序，用于前端渲染）
  contentParts?: ResponseContentPart[];
  runtimeDiagnostics?: {
    visibleToolNames?: string[];
    toolStrategy?: ModelToolStrategyDiagnostics;
    modelDecision?: ModelDecisionEventData;
    artifactRepairCompactWriteRetry?: boolean;
    artifactRepairGuard?: {
      targetFile?: string;
      attempts?: number;
      phase?: string;
      patched?: boolean;
      repairTurnsWithoutProgress?: number;
      activeIssueCodes?: string[];
    };
    artifactValidationAttemptCompletion?: {
      targetFile: string;
    };
    /** Max Mode（best-of-N）本步诊断：候选/幸存/赢家索引/是否降级/judge 是否解析成功 */
    maxMode?: {
      candidates: number;
      survivors: number;
      winner: number;
      degraded: boolean;
      judgeParsed: boolean;
      overheadInputTokens: number;
      overheadOutputTokens: number;
    };
  };
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
  providerReportedSavedTokens?: number;
  // complete event
  finishReason?: string;
  // error event
  error?: string;
  errorCode?: string;
}

export type StreamCallback = (chunk: string | StreamChunk) => void;

export interface InferenceOptions {
  onSnapshot?: (snapshot: import('./providers/sseStream').StreamSnapshot) => void;
  snapshotIntervalMs?: number;
  forceNonStreaming?: boolean;
  artifactRepairActive?: boolean;
  artifactRepairWritePriority?: boolean;
  artifactRepairFullRewritePriority?: boolean;
  disableProviderTransientRetry?: boolean;
  disableRuntimeNetworkRetry?: boolean;
  maxInputTokens?: number;
  maxOutputTokens?: number;
  requestTimeoutMs?: number;
  firstByteTimeoutMs?: number;
  inactivityTimeoutMs?: number;
  /**
   * Caller-level reasoning intensity for thinking-mode models. modelRouter
   * defaults this to 'low' on artifact generation/repair turns so reasoning
   * tokens don't crowd out content output. Mirrored onto ModelConfig before
   * the provider runs so buildRequestBody can read config.reasoningEffort.
   */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /**
   * 强制工具选择（dynamic-workflow forced structured output 用）。仅 AI SDK 路径生效，
   * legacy provider 路径忽略。'required'=必须调某工具；{type:'tool',toolName}=必须调指定工具。
   * 形状对齐 AI SDK 的 ToolChoice，透传时直接映射。
   */
  toolChoice?: 'auto' | 'none' | 'required' | { type: 'tool'; toolName: string };
  /**
   * 抑制 model_decision 事件发射（Max Mode 候选/judge 的静默调用用，Codex R1-M1）：
   * 路由决策行为不变，只是不把 N 条 propose-only 调用的决策事件混进 UI/遥测。
   */
  suppressModelDecisionEvent?: boolean;
}

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
    tools: import('../../shared/contract').ToolDefinition[],
    config: import('../../shared/contract').ModelConfig,
    onStream?: StreamCallback,
    signal?: AbortSignal,
    options?: InferenceOptions,
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
