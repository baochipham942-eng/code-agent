import type { Message } from '@shared/contract';
import { hydrateToolCallResults } from '../utils/messageHydration';

function liveMessageExtendsSnapshot(snapshotMessage: Message | undefined, liveMessage: Message): boolean {
  if (!snapshotMessage) return true;
  if ((liveMessage.content?.length ?? 0) > (snapshotMessage.content?.length ?? 0)) return true;
  if ((liveMessage.reasoning?.length ?? 0) > (snapshotMessage.reasoning?.length ?? 0)) return true;
  if ((liveMessage.toolCalls?.length ?? 0) > (snapshotMessage.toolCalls?.length ?? 0)) return true;
  if ((liveMessage.artifacts?.length ?? 0) > (snapshotMessage.artifacts?.length ?? 0)) return true;
  return false;
}

export function mergeSnapshotWithLiveTail(snapshot: Message[], live: Message[]) {
  const snapshotById = new Map(snapshot.map((message) => [message.id, message]));
  const hasLiveTail = live.some((message) => liveMessageExtendsSnapshot(snapshotById.get(message.id), message));
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
  return {
    messages: hydrateToolCallResults([...merged, ...liveById.values()]),
    hasLiveTail,
  };
}
