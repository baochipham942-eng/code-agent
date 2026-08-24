import type { Message, ToolCall, ToolResult } from '../../../shared/contract';

const CANCELLED_TOOL_CALL_PLACEHOLDER =
  '[no result: this tool call was cancelled before a result was recorded; do not assume it ran or succeeded]';

export async function persistCancelledToolCallClosures(input: {
  messages: readonly Message[];
  assistantMessage: Message;
  toolCalls: readonly ToolCall[];
  persistMessage: (message: Message) => Promise<void>;
}): Promise<void> {
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

  const cancelledResults: ToolResult[] = missingToolCalls.map((toolCall) => ({
    toolCallId: toolCall.id,
    success: false,
    error: CANCELLED_TOOL_CALL_PLACEHOLDER,
    duration: 0,
  }));
  await input.persistMessage({
    id: `${input.assistantMessage.id}:cancelled-tool-results`,
    role: 'tool',
    content: JSON.stringify(cancelledResults),
    timestamp: Date.now(),
    toolResults: cancelledResults,
    ...(input.assistantMessage.isMeta ? { isMeta: true } : {}),
  });
}
