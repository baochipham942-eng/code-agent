import type { Message, ToolCall, ToolResult } from '../../../shared/contract';

const CANCELLED_TOOL_CALL_PLACEHOLDER =
  '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]';

/**
 * 崩溃清算占位（OUTCOME_UNKNOWN 档）：账本有 begin 事件，执行可能已经发生，
 * 结果未知，先核对外部状态。与历史串逐字相同，renderer/e2e 按文本识别。
 */
export const INTERRUPTED_TOOL_CALL_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';

/**
 * 崩溃清算占位（NOT_STARTED 档）：账本无 begin 事件，该调用从未开始，可安全重发。
 */
export const INTERRUPTED_TOOL_CALL_PLACEHOLDER_NOT_STARTED =
  'interrupted: process crashed before this tool call started; it never began running and is safe to re-issue';

/** 崩溃清算分层：从未开始（无 begin 事件）vs 结果未知（有 begin 事件） */
export type CrashRecoveryTier = 'NOT_STARTED' | 'OUTCOME_UNKNOWN';

/** 单个孤儿 tool call 的清算覆盖：占位文案 + 机器可读分层戳 */
interface ToolCallClosureOverride {
  error: string;
  metadata?: Record<string, unknown>;
}

interface ToolCallClosureInput<TPersistResult extends void | Promise<void>> {
  messages: readonly Message[];
  assistantMessage: Message;
  toolCalls: readonly ToolCall[];
  persistMessage: (message: Message) => TPersistResult;
  placeholder?: string;
  /** 逐 call 覆盖（崩溃清算分层用）：返回 undefined 时回落到 placeholder */
  resolveClosure?: (toolCall: ToolCall) => ToolCallClosureOverride | undefined;
  messageIdSuffix?: string;
}

export function persistCancelledToolCallClosures<TPersistResult extends void | Promise<void>>(
  input: ToolCallClosureInput<TPersistResult>,
): TPersistResult | void {
  const completedToolCallIds = new Set(
    input.messages
      .filter((message) => message.role === 'tool')
      .flatMap((message) => message.toolResults ?? [])
      .map((result) => result.toolCallId),
  );
  const missingToolCalls = input.toolCalls.filter(
    (toolCall) => !completedToolCallIds.has(toolCall.id),
  );
  if (missingToolCalls.length === 0) return;

  const closureResults: ToolResult[] = missingToolCalls.map((toolCall) => {
    const override = input.resolveClosure?.(toolCall);
    return {
      toolCallId: toolCall.id,
      success: false,
      error: override?.error ?? input.placeholder ?? CANCELLED_TOOL_CALL_PLACEHOLDER,
      duration: 0,
      ...(override?.metadata ? { metadata: override.metadata } : {}),
    };
  });
  return input.persistMessage({
    id: `${input.assistantMessage.id}:${input.messageIdSuffix ?? 'cancelled-tool-results'}`,
    role: 'tool',
    content: JSON.stringify(closureResults),
    timestamp: Date.now(),
    toolResults: closureResults,
    ...(input.assistantMessage.isMeta ? { isMeta: true } : {}),
  });
}
