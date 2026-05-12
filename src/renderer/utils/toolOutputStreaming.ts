import type { ToolCall, ToolOutputDeltaData } from '@shared/contract';

const MAX_LIVE_TOOL_OUTPUT_LENGTH = 8_000;
const TRUNCATED_PREFIX = '[Earlier live output truncated]\n';

function appendCappedOutput(existing: string | undefined, delta: string): { value: string; truncated: boolean } {
  const next = `${existing || ''}${delta}`;
  if (next.length <= MAX_LIVE_TOOL_OUTPUT_LENGTH) {
    return { value: next, truncated: false };
  }

  const retainedLength = Math.max(0, MAX_LIVE_TOOL_OUTPUT_LENGTH - TRUNCATED_PREFIX.length);
  return {
    value: `${TRUNCATED_PREFIX}${next.slice(-retainedLength)}`,
    truncated: true,
  };
}

export function applyToolOutputDelta(
  toolCalls: ToolCall[],
  delta: ToolOutputDeltaData,
  updatedAt: number = Date.now(),
): ToolCall[] {
  return toolCalls.map((toolCall) => {
    if (toolCall.id !== delta.toolCallId || !delta.content) {
      return toolCall;
    }

    const liveOutput = toolCall.liveOutput || {};
    const current = delta.stream === 'stderr' ? liveOutput.stderr : liveOutput.stdout;
    const appended = appendCappedOutput(current, delta.content);

    return {
      ...toolCall,
      liveOutput: {
        ...liveOutput,
        [delta.stream]: appended.value,
        truncated: Boolean(liveOutput.truncated || delta.truncated || appended.truncated),
        updatedAt,
      },
    };
  });
}
