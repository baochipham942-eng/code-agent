// ============================================================================
// streamRecoveryMessage - 重水化时把 host 的 StreamRecoverySnapshot 回填成一条
// 流式 assistant 消息（F4：生成中切会话再回来，已渲染内容消失）。
//
// 关键设计：回填消息的 id 直接用 snapshot.turnId。本轮剩余流式事件（stream_chunk /
// message_delta / message_snapshot / 'message'）都按 turnId 寻址
// （useConversationStreamEffects），重水化后 hook 的 currentTurnMessageId 已丢、
// DB 消息 id 是 host messageId ≠ turnId —— 只有让回填消息 id === snapshot.turnId，
// 后续事件才能自然命中同一条消息无缝续接，不需要额外映射表。
// ============================================================================

import type { Message, ToolCall } from '@shared/contract';
import type { StreamRecoverySnapshot } from '@shared/contract/session';

/** metadata 标记：这条 assistant 消息是从 streamSnapshot 回填的（非 DB 落库消息）。 */
const STREAM_RECOVERY_META_KEY = 'streamRecovery';

export function isStreamRecoveryMessage(message: Message, turnId?: string): boolean {
  const marker = message.metadata?.[STREAM_RECOVERY_META_KEY];
  if (!marker) return false;
  return turnId === undefined || marker.turnId === turnId;
}

/** snapshot.toolCalls[].arguments 是原始字符串，流式中断时可能是半截 JSON。 */
function parseSnapshotToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // 半截参数：工具节点照常渲染（无 result → 呈现为在途），参数留空。
  }
  return {};
}

export function buildStreamRecoveryMessage(snapshot: StreamRecoverySnapshot): Message {
  const toolCalls: ToolCall[] = snapshot.toolCalls
    .filter((toolCall) => Boolean(toolCall.name))
    .map((toolCall) => ({
      id: toolCall.id,
      name: toolCall.name,
      arguments: parseSnapshotToolArguments(toolCall.arguments),
    }));

  return {
    id: snapshot.turnId,
    role: 'assistant',
    content: snapshot.content,
    ...(snapshot.reasoning ? { reasoning: snapshot.reasoning } : {}),
    timestamp: snapshot.timestamp,
    toolCalls,
    metadata: { [STREAM_RECOVERY_META_KEY]: { turnId: snapshot.turnId } },
  };
}

/**
 * 把非 final 的 snapshot 追加成当前会话末尾的 streaming assistant 消息。
 * final / 空 partial / 已存在同 id 消息时原样返回，保证幂等。
 */
export function mergeStreamSnapshotIntoMessages(
  messages: Message[],
  snapshot: StreamRecoverySnapshot | null | undefined,
): Message[] {
  if (!snapshot || snapshot.isFinal) return messages;
  if (messages.some((message) => message.id === snapshot.turnId)) return messages;
  const hasPartial =
    Boolean(snapshot.content.trim() || snapshot.reasoning.trim()) ||
    snapshot.toolCalls.some((toolCall) => Boolean(toolCall.name));
  if (!hasPartial) return messages;
  return [...messages, buildStreamRecoveryMessage(snapshot)];
}
