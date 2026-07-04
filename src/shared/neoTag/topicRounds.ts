import type { Message } from '../contract/message';
import type { NeoWorkCardDelta } from '../contract/tag';

// ============================================================================
// Topic 多轮回溯（host prompt 层与 renderer 详情共用的纯函数）：
// 真源是会话消息本身（用户消息带 metadata.neoTag.workCardId），不是 delta 记账。
// ============================================================================

export interface NeoTopicRound {
  /** 用户那轮的原话（含 @neo 前缀，如果有）。 */
  request: string;
  /** 该轮 Neo 的最终回复正文；还在跑/失败无回复时为 null。 */
  reply: string | null;
  /** 该轮发起时间。 */
  at: number;
  /** 该轮实际发生的会话（跨会话聚合时标注；单会话调用可省）。 */
  conversationId?: string;
}

export function extractNeoTopicRounds(
  messages: Message[],
  workCardId: string,
  conversationId?: string,
): NeoTopicRound[] {
  const rounds: NeoTopicRound[] = [];
  let current: NeoTopicRound | null = null;
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.metadata?.neoTag?.workCardId === workCardId) {
        current = { request: message.content, reply: null, at: message.timestamp, conversationId };
        rounds.push(current);
      } else {
        // 任何别的用户消息（普通聊天/别的卡）都终结当前轮
        current = null;
      }
      continue;
    }
    if (current && message.role === 'assistant' && message.content?.trim()) {
      // 最终结论 = 该轮最后一条非空 assistant 正文
      current.reply = message.content;
    }
  }
  return rounds;
}

export function mergeTopicRounds(lists: NeoTopicRound[][]): NeoTopicRound[] {
  return lists.flat().sort((a, b) => a.at - b.at);
}

/** 卡参与过的会话集合：源会话在前，delta 归属去重在后（老 delta 无归属 → 自动回退源会话行为）。 */
export function topicConversationIds(detail: {
  workCard: { sourceConversationId: string };
  deltas: Array<Pick<NeoWorkCardDelta, 'conversationId'>>;
}): string[] {
  const ids = [detail.workCard.sourceConversationId];
  for (const delta of detail.deltas) {
    if (delta.conversationId && !ids.includes(delta.conversationId)) {
      ids.push(delta.conversationId);
    }
  }
  return ids;
}
