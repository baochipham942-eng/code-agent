import type { Message } from '@shared/contract';

/**
 * 把消息流里独立到达的 toolResults 回填到对应 toolCall.result 上。
 * 历史加载 / 追加消息 / 向上翻页三条路径共用。
 */
export function hydrateToolCallResults(messages: Message[]): Message[] {
  const resultsByToolCallId = new Map<string, NonNullable<Message['toolResults']>[number]>();

  for (const message of messages) {
    for (const result of message.toolResults ?? []) {
      if (result.toolCallId) {
        resultsByToolCallId.set(result.toolCallId, result);
      }
    }
  }

  if (resultsByToolCallId.size === 0) {
    return messages;
  }

  return messages.map((message) => {
    if (!message.toolCalls?.length) {
      return message;
    }

    let changed = false;
    const toolCalls = message.toolCalls.map((toolCall) => {
      if (toolCall.result) {
        return toolCall;
      }
      const result = resultsByToolCallId.get(toolCall.id);
      if (!result) {
        return toolCall;
      }
      changed = true;
      return { ...toolCall, result };
    });

    return changed ? { ...message, toolCalls } : message;
  });
}
