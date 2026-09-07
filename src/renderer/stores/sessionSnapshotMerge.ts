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

/**
 * 合并必须是**无损**的：配对判据是「前置 user 相同 + 正文相似」这种弱证据，一定会有
 * 误配的时候；只要合并本身不丢东西，误配的代价就从「数据消失」降到「两段一样的正文
 * 并成一条」——后者正是本单要的效果，前者是新 bug。
 *
 * 🔴 别再走「哪边多留哪边」那条路：那等于每加一种结构化载荷（toolCalls、artifacts、
 * deliverables…）就要补一条挑选规则，而载荷种类是开放的，ai-review 已经按这个形状
 * 连点两轮（工具调用一轮、artifacts 一轮）。数组一律按 id 取并集，缺 id 的按引用去重。
 */
/**
 * 同 id 时**后来的（live）赢**：live 那份带着刚到的执行结果/输出路径，旧快照那份可能还是
 * 「运行中」。先到先得会把已完成工具的结果清掉（ai-review #1696 第五轮①）。
 * 顺序按首次出现位置保持稳定，避免合并后卡片跳动。
 */
function unionById<T>(
  left: T[] | undefined,
  right: T[] | undefined,
): T[] | undefined {
  if (!left?.length) return right;
  if (!right?.length) return left;
  const order: unknown[] = [];
  const byKey = new Map<unknown, T>();
  for (const item of [...left, ...right]) {
    const key = (item as { id?: unknown } | undefined)?.id ?? item;
    if (!byKey.has(key)) order.push(key);
    byKey.set(key, item); // 后写覆盖 ⇒ live 赢
  }
  return order.map((key) => byKey.get(key) as T);
}

/**
 * 消息上的数组载荷一律按 id 取并集，**不逐个点名**：载荷种类是开放的
 * （toolCalls / toolResults / attachments / artifacts / …），点名式合并每加一种就要补一条
 * 规则，ai-review 已按这个形状连点三轮。这里反过来：默认全部取并集，
 * 只把**顺序敏感**的字段列进例外。
 */
const ORDER_SENSITIVE_ARRAY_FIELDS = new Set(['contentParts']);

function mergeArrayPayloads(snapshotMessage: Message, liveMessage: Message): Partial<Message> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(snapshotMessage), ...Object.keys(liveMessage)]);
  for (const key of keys) {
    const a = (snapshotMessage as unknown as Record<string, unknown>)[key];
    const b = (liveMessage as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(a) && !Array.isArray(b)) continue;
    if (ORDER_SENSITIVE_ARRAY_FIELDS.has(key)) {
      // 交错顺序有语义，取并集会打乱 ⇒ 取更长的那份。
      out[key] = ((b as unknown[])?.length ?? 0) >= ((a as unknown[])?.length ?? 0) ? b : a;
      continue;
    }
    out[key] = unionById(a as unknown[] | undefined, b as unknown[] | undefined);
  }
  return out as Partial<Message>;
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
    // 所有数组载荷统一处理，不逐个点名（见 mergeArrayPayloads 的注释）。
    ...mergeArrayPayloads(snapshotMessage, liveMessage),
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
