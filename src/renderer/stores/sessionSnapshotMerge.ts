import type { ContentPart, Message } from '@shared/contract';
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

function correlationTurnId(message: Message): string | undefined {
  const turnId = message.metadata?.correlation?.turnId?.trim();
  return turnId || undefined;
}

function liveMatchesTurnId(liveMessage: Message, turnId: string): boolean {
  const liveKey = correlationTurnId(liveMessage);
  if (liveKey) return liveKey === turnId;
  return liveMessage.id === turnId;
}

function findLiveCounterpart(
  snapshotMessage: Message,
  snapshot: Message[],
  live: Message[],
  liveById: Map<string, Message>,
  snapshotById: Map<string, Message>,
): Message | undefined {
  if (snapshotMessage.role !== 'assistant') return undefined;
  const snapshotKey = correlationTurnId(snapshotMessage);
  if (snapshotKey) {
    for (const liveMessage of live) {
      if (!liveById.has(liveMessage.id)) continue;
      if (snapshotById.has(liveMessage.id)) continue;
      if (liveMessage.role !== 'assistant') continue;
      if (!liveMatchesTurnId(liveMessage, snapshotKey)) continue;
      return liveMessage;
    }
    return undefined;
  }

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
 * 正文相似只是**弱**证据：两轮回答碰巧一样就会被并掉。
 * 有 correlation.turnId 时按该键配对，正文相似度只在双方都没有关联键时回落。
 * 无键回落仍保留工具调用冲突护栏：两边都有工具调用且互不为子集时拒绝合并。
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

/** contentParts 承载的正文 = 各 text 段拼接（tool_call 段不产正文）。 */
function contentPartsText(parts: ContentPart[]): string {
  let text = '';
  for (const part of parts) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

/** 正文取舍：更长的那份，等长留 snapshot。分叉正文在配对层就已被拒（见下方注释）。 */
function pickBody(snapshotBody: string | undefined, liveBody: string | undefined): string | undefined {
  if (snapshotBody == null) return liveBody;
  if (liveBody == null) return snapshotBody;
  return liveBody.length > snapshotBody.length ? liveBody : snapshotBody;
}

function mergedContentOf(snapshotMessage: Message, liveMessage: Message): string {
  return pickBody(snapshotMessage.content, liveMessage.content) ?? '';
}

/**
 * contentParts 只能整份选一边（交错顺序有语义，取并集会打乱）。判据不是
 * 「元素更多」——带工具分段的旧快照元素更多、承载的正文却可能更短，选中它
 * 投影就只渲染旧分段，live 已显示的新正文整个消失（ai-review #1696 第六轮）。
 * 判据是承载正文必须覆盖合并后的 content；两边都覆盖不了就整份弃用，
 * 宁可回落到 content 直渲，也不能让已显示的正文消失。同分时 live 赢。
 */
function pickContentParts(
  snapshotParts: ContentPart[] | undefined,
  liveParts: ContentPart[] | undefined,
  mergedContent: string,
): ContentPart[] | undefined {
  let best: ContentPart[] | undefined;
  for (const parts of [snapshotParts, liveParts]) {
    if (!parts?.length) continue;
    if (!contentPartsText(parts).startsWith(mergedContent)) continue;
    if (!best || parts.length >= best.length) best = parts;
  }
  return best;
}

function mergeArrayPayloads(snapshotMessage: Message, liveMessage: Message): Partial<Message> {
  const out: Record<string, unknown> = {};
  const keys = new Set([...Object.keys(snapshotMessage), ...Object.keys(liveMessage)]);
  for (const key of keys) {
    const a = (snapshotMessage as unknown as Record<string, unknown>)[key];
    const b = (liveMessage as unknown as Record<string, unknown>)[key];
    if (!Array.isArray(a) && !Array.isArray(b)) continue;
    if (ORDER_SENSITIVE_ARRAY_FIELDS.has(key)) {
      out[key] = pickContentParts(
        a as ContentPart[] | undefined,
        b as ContentPart[] | undefined,
        mergedContentOf(snapshotMessage, liveMessage),
      );
      continue;
    }
    out[key] = unionById(a as unknown[] | undefined, b as unknown[] | undefined);
  }
  return out as Partial<Message>;
}

function mergeAssistantPair(snapshotMessage: Message, liveMessage: Message): Message {
  return {
    ...snapshotMessage,
    ...liveMessage,
    content: mergedContentOf(snapshotMessage, liveMessage),
    reasoning: pickBody(snapshotMessage.reasoning, liveMessage.reasoning),
    // live 草稿的 metadata 可能只有 correlation 一个键（turn_start 建的草稿就是），
    // 整体铺开会把 snapshot 落库的 agentError / turnQuality 等键抹掉——按键合并，
    // live 提供的键赢，snapshot 独有的键保留（ai-review #1706）。
    metadata: (snapshotMessage.metadata || liveMessage.metadata)
      ? { ...snapshotMessage.metadata, ...liveMessage.metadata }
      : undefined,
    // 所有数组载荷统一处理，不逐个点名（见 mergeArrayPayloads 的注释）。
    ...mergeArrayPayloads(snapshotMessage, liveMessage),
  };
}

export function mergeSnapshotWithLiveTail(snapshot: Message[], live: Message[]) {
  const snapshotById = new Map(snapshot.map((message) => [message.id, message]));
  const hasLiveTail = live.some((message) => liveMessageExtendsSnapshot(snapshotById.get(message.id), message));
  const liveById = new Map(live.map((message) => [message.id, message]));
  const merged = snapshot.map((message) => {
    const sameIdLive = liveById.get(message.id);
    const liveMessage = sameIdLive
      ?? findLiveCounterpart(message, snapshot, live, liveById, snapshotById);
    if (!liveMessage) return message;
    // 跨 id 键配对只接前缀相关的正文：同一 turn 可以落多条 assistant（工具回复 A
    // 在先、最终回复 B 在后，messageProcessor :783 vs :956），分叉正文就是「这两条
    // 不是同一条」的信号——合并会让较早落库者覆盖用户已看到的最终回复
    // （ai-review #1706 第三轮），不配对则两条都保留，宁可多一条草稿也不少一条终版。
    if (!sameIdLive && correlationTurnId(message) !== undefined) {
      const snapshotBody = message.content ?? '';
      const liveBody = liveMessage.content ?? '';
      // 空正文快照（工具消息这类占位落库）不抢非空 live：'' 是任何正文的前缀，
      // 不挡就会先把 live 终版合并进工具消息，让快照里真正的终版落单再显示一遍
      // （ai-review #1706 第四轮）。live 为空草稿则照常合并（草稿占位找正文宿主）。
      if (!snapshotBody && liveBody) {
        return message;
      }
      if (!snapshotBody.startsWith(liveBody) && !liveBody.startsWith(snapshotBody)) {
        return message;
      }
    }
    liveById.delete(liveMessage.id);
    return mergeAssistantPair(message, liveMessage);
  });
  return {
    messages: hydrateToolCallResults([...merged, ...liveById.values()]),
    hasLiveTail,
  };
}
