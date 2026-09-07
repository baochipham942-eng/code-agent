import type { Message } from '@shared/contract';
import { hydrateToolCallResults } from '../utils/messageHydration';

/** 短前言（「好的。」）不能当成同一条流式草稿的前缀。 */
const STREAMING_COUNTERPART_MIN_PREFIX = 32;

function liveMessageExtendsSnapshot(snapshotMessage: Message | undefined, liveMessage: Message): boolean {
  if (!snapshotMessage) return true;
  if ((liveMessage.content?.length ?? 0) > (snapshotMessage.content?.length ?? 0)) return true;
  if ((liveMessage.reasoning?.length ?? 0) > (snapshotMessage.reasoning?.length ?? 0)) return true;
  if ((liveMessage.toolCalls?.length ?? 0) > (snapshotMessage.toolCalls?.length ?? 0)) return true;
  if ((liveMessage.artifacts?.length ?? 0) > (snapshotMessage.artifacts?.length ?? 0)) return true;
  return false;
}

function precedingUserId(messages: Message[], target: Message): string | undefined {
  const index = messages.findIndex((message) => message.id === target.id);
  if (index < 0) return undefined;
  for (let i = index - 1; i >= 0; i -= 1) {
    if (messages[i].role === 'user') return messages[i].id;
  }
  return undefined;
}

function isStreamingAssistantCounterpart(left: string | undefined, right: string | undefined): boolean {
  const a = left ?? '';
  const b = right ?? '';
  if (!a || !b) return false;
  if (a === b) return true;
  const shorter = a.length <= b.length ? a : b;
  const longer = a.length <= b.length ? b : a;
  return shorter.length >= STREAMING_COUNTERPART_MIN_PREFIX && longer.startsWith(shorter);
}

function findLiveCounterpart(
  snapshotMessage: Message,
  snapshot: Message[],
  live: Message[],
  liveById: Map<string, Message>,
  snapshotById: Map<string, Message>,
): Message | undefined {
  if (snapshotMessage.role !== 'assistant') return undefined;
  const snapshotUserId = precedingUserId(snapshot, snapshotMessage);
  for (const liveMessage of live) {
    if (!liveById.has(liveMessage.id)) continue;
    if (snapshotById.has(liveMessage.id)) continue;
    if (liveMessage.role !== 'assistant') continue;
    if (precedingUserId(live, liveMessage) !== snapshotUserId) continue;
    if (!isStreamingAssistantCounterpart(snapshotMessage.content, liveMessage.content)) continue;
    if (hasConflictingToolCalls(snapshotMessage, liveMessage)) continue;
    return liveMessage;
  }
  return undefined;
}

/**
 * 正文相似只是**弱**证据：两轮回答碰巧一样就会被并掉，而 mergeAssistantPair 只保留
 * 工具调用较多的那一边 ⇒ 另一边的工具调用整组消失（ai-review #1696 第三轮）。
 *
 * 这里不做「更聪明的相似度」——那还是猜。只加一条硬约束把误合并的**代价**封住：
 * 两边都有工具调用且互不为子集时，说明它们是两轮不同的工作，拒绝合并。
 * 真正的解法是按结构化关联键（metadata.correlation.turnId）合并，但真库里近期
 * assistant 消息只有约四分之一带 correlation，host 侧先填齐才谈得上 ⇒
 * N-CHAT-MERGE-BY-CORRELATION。
 */
function hasConflictingToolCalls(a: Message, b: Message): boolean {
  const idsOf = (m: Message) => new Set((m.toolCalls ?? []).map((call) => call.id).filter(Boolean));
  const left = idsOf(a);
  const right = idsOf(b);
  if (left.size === 0 || right.size === 0) return false;
  const subset = (small: Set<string>, big: Set<string>) => [...small].every((id) => big.has(id));
  return !subset(left, right) && !subset(right, left);
}

function mergeAssistantPair(snapshotMessage: Message, liveMessage: Message): Message {
  const longer = (left: string | undefined, right: string | undefined) => (
    (right?.length ?? 0) > (left?.length ?? 0) ? right : left
  );
  return {
    ...snapshotMessage,
    ...liveMessage,
    content: longer(snapshotMessage.content, liveMessage.content) ?? '',
    reasoning: longer(snapshotMessage.reasoning, liveMessage.reasoning),
    toolCalls: (liveMessage.toolCalls?.length ?? 0) >= (snapshotMessage.toolCalls?.length ?? 0)
      ? liveMessage.toolCalls
      : snapshotMessage.toolCalls,
  };
}

export function mergeSnapshotWithLiveTail(snapshot: Message[], live: Message[]) {
  const snapshotById = new Map(snapshot.map((message) => [message.id, message]));
  const hasLiveTail = live.some((message) => liveMessageExtendsSnapshot(snapshotById.get(message.id), message));
  const liveById = new Map(live.map((message) => [message.id, message]));
  const merged = snapshot.map((message) => {
    const liveMessage = liveById.get(message.id)
      ?? findLiveCounterpart(message, snapshot, live, liveById, snapshotById);
    if (!liveMessage) return message;
    liveById.delete(liveMessage.id);
    return mergeAssistantPair(message, liveMessage);
  });
  return {
    messages: hydrateToolCallResults([...merged, ...liveById.values()]),
    hasLiveTail,
  };
}
