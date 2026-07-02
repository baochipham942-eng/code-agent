// ============================================================================
// Request Prefix Shape Hash（WP2-2b prefixHash 归因，仅 telemetry 诊断）
//
// 目的：量化上下文压缩对 provider prompt cache 的破坏——压缩前后请求前缀的
// shape hash 必然不同，telemetry 可据此把「缓存命中率跌落」归因到具体压缩事件。
// shape = systemPrompt 全文 + 每条消息的结构（role / 内容长度 / 工具调用数），
// 不含消息全文（避免快照膨胀与敏感内容外泄）。不参与任何运行时决策。
// ============================================================================

import { createHash } from 'crypto';

interface ShapeMessageLike {
  role?: string;
  content?: unknown;
  toolCalls?: unknown[];
  tool_calls?: unknown[];
}

export interface RequestPrefixShapeInput {
  systemPrompt?: string;
  messages: ShapeMessageLike[];
}

/** 返回 16 位 hex 的请求前缀 shape hash。 */
export function computeRequestPrefixShapeHash(input: RequestPrefixShapeInput): string {
  const shape = {
    systemPrompt: input.systemPrompt ?? '',
    messages: input.messages.map((message) => {
      const content = typeof message.content === 'string'
        ? message.content
        : message.content == null
          ? ''
          : JSON.stringify(message.content);
      const toolCalls = message.toolCalls ?? message.tool_calls ?? [];
      return {
        role: String(message.role ?? 'unknown'),
        contentLength: content.length,
        toolCallCount: Array.isArray(toolCalls) ? toolCalls.length : 0,
      };
    }),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex').slice(0, 16);
}
