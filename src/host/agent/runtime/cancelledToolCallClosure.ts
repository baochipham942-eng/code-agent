import type { Message, ToolCall, ToolResult } from '../../../shared/contract';

const CANCELLED_TOOL_CALL_PLACEHOLDER =
  '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]';

/**
 * 崩溃清算占位（逐字保持历史串，renderer/e2e 按文本识别，不得改写）。
 * 不分层：begin 写入链路全层 fail-safe 吞错（toolExecutionLedger.begin 的 catch →
 * databaseService.appendToolExecutionBegin 未就绪/只读静默、BUSY/磁盘满仅 warn），
 * 「账本无 begin 行」推不出「从未执行」，只能一律按结果未知处理（N-CRASH-OUTCOME-TIERS 返修 r1）。
 */
export const INTERRUPTED_TOOL_CALL_PLACEHOLDER =
  'interrupted: process crashed before a result was recorded; do not assume it ran or succeeded';

interface ToolCallClosureInput<TPersistResult extends void | Promise<void>> {
  messages: readonly Message[];
  assistantMessage: Message;
  toolCalls: readonly ToolCall[];
  persistMessage: (message: Message) => TPersistResult;
  placeholder?: string;
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

  const closureResults: ToolResult[] = missingToolCalls.map((toolCall) => ({
    toolCallId: toolCall.id,
    success: false,
    error: input.placeholder ?? CANCELLED_TOOL_CALL_PLACEHOLDER,
    duration: 0,
  }));
  return input.persistMessage({
    id: `${input.assistantMessage.id}:${input.messageIdSuffix ?? 'cancelled-tool-results'}`,
    role: 'tool',
    content: JSON.stringify(closureResults),
    timestamp: Date.now(),
    toolResults: closureResults,
    ...(input.assistantMessage.isMeta ? { isMeta: true } : {}),
  });
}
