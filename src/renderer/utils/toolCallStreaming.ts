import type { ToolCall } from '@shared/contract';

export interface ToolCallArgumentDelta {
  index: number;
  name?: string;
  argumentsDelta?: string;
}

export function applyToolCallArgumentDelta(
  toolCalls: ToolCall[],
  delta: ToolCallArgumentDelta,
): ToolCall[] {
  return toolCalls.map((toolCall, index) => {
    if (index !== delta.index) {
      return toolCall;
    }

    const nextToolCall = { ...toolCall };
    if (delta.name && !toolCall.name) {
      nextToolCall.name = delta.name;
    }

    if (!delta.argumentsDelta) {
      return nextToolCall;
    }

    nextToolCall._argumentsRaw = (toolCall._argumentsRaw || '') + delta.argumentsDelta;

    try {
      const parsed = JSON.parse(nextToolCall._argumentsRaw) as Record<string, unknown>;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        const meta = (parsed as { _meta?: unknown })._meta;
        if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
          const metadata = meta as Record<string, unknown>;
          if (typeof metadata.shortDescription === 'string') {
            nextToolCall.shortDescription = metadata.shortDescription;
          }
          if (typeof metadata.expectedOutcome === 'string') {
            nextToolCall.expectedOutcome = metadata.expectedOutcome;
          }
          if (
            metadata.targetContext &&
            typeof metadata.targetContext === 'object' &&
            !Array.isArray(metadata.targetContext)
          ) {
            nextToolCall.targetContext = metadata.targetContext as ToolCall['targetContext'];
          }
          delete (parsed as { _meta?: unknown })._meta;
        }
        nextToolCall.arguments = parsed;
      } else {
        nextToolCall.arguments = parsed;
      }
    } catch {
      // JSON is still incomplete.
    }

    return nextToolCall;
  });
}
