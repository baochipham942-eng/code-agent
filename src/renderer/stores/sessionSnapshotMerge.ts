import type { Message } from '@shared/contract';
import { hydrateToolCallResults } from '../utils/messageHydration';

export function mergeSnapshotWithLiveTail(snapshot: Message[], live: Message[]): Message[] {
  const liveById = new Map(live.map((message) => [message.id, message]));
  const merged = snapshot.map((message) => {
    const liveMessage = liveById.get(message.id);
    if (!liveMessage) return message;
    liveById.delete(message.id);
    const longer = (left: string | undefined, right: string | undefined) => (
      (right?.length ?? 0) > (left?.length ?? 0) ? right : left
    );
    return {
      ...message,
      ...liveMessage,
      content: longer(message.content, liveMessage.content) ?? '',
      reasoning: longer(message.reasoning, liveMessage.reasoning),
      toolCalls: (liveMessage.toolCalls?.length ?? 0) >= (message.toolCalls?.length ?? 0)
        ? liveMessage.toolCalls
        : message.toolCalls,
    };
  });
  return hydrateToolCallResults([...merged, ...liveById.values()]);
}
