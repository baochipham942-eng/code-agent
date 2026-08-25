import type { Message, ToolCall, ToolResult } from '../../../shared/contract';

const CANCELLED_TOOL_CALL_PLACEHOLDER =
  '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]';

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
