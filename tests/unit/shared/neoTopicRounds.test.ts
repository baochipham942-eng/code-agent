import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import {
  extractNeoTopicRounds,
  mergeTopicRounds,
  topicConversationIds,
} from '../../../src/shared/neoTag/topicRounds';

function msg(over: Partial<Message>): Message {
  return { id: 'm', role: 'user', content: 'x', timestamp: 0, ...over } as Message;
}

describe('shared topicRounds', () => {
  it('extractNeoTopicRounds annotates rounds with conversationId when provided', () => {
    const rounds = extractNeoTopicRounds([
      msg({ id: 'u1', role: 'user', content: '@neo 整理竞品', timestamp: 10, metadata: { neoTag: { workCardId: 'nwc_1' } } as Message['metadata'] }),
      msg({ id: 'a1', role: 'assistant', content: '第一轮回复', timestamp: 11 }),
    ], 'nwc_1', 'conv_A');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].conversationId).toBe('conv_A');
    expect(rounds[0].reply).toBe('第一轮回复');
  });

  it('extractNeoTopicRounds without conversationId keeps legacy shape (undefined annotation)', () => {
    const rounds = extractNeoTopicRounds([
      msg({ id: 'u1', role: 'user', content: '@neo 干活', timestamp: 10, metadata: { neoTag: { workCardId: 'nwc_1' } } as Message['metadata'] }),
    ], 'nwc_1');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].conversationId).toBeUndefined();
    expect(rounds[0].reply).toBeNull();
  });

  it('other user messages terminate the current round (no reply bleed-through)', () => {
    const rounds = extractNeoTopicRounds([
      msg({ id: 'u1', role: 'user', content: '@neo 干活', timestamp: 10, metadata: { neoTag: { workCardId: 'nwc_1' } } as Message['metadata'] }),
      msg({ id: 'u2', role: 'user', content: '普通聊天', timestamp: 11 }),
      msg({ id: 'a1', role: 'assistant', content: '这是普通聊天的回复', timestamp: 12 }),
    ], 'nwc_1', 'conv_A');
    expect(rounds).toHaveLength(1);
    expect(rounds[0].reply).toBeNull();
  });

  it('mergeTopicRounds interleaves by timestamp across conversations', () => {
    const merged = mergeTopicRounds([
      [{ request: 'r1', reply: 'a1', at: 10, conversationId: 'conv_A' }],
      [{ request: 'r2', reply: 'a2', at: 5, conversationId: 'conv_B' }],
    ]);
    expect(merged.map((r) => r.request)).toEqual(['r2', 'r1']);
  });

  it('topicConversationIds = source ∪ distinct delta conversations, source first, deduped', () => {
    const ids = topicConversationIds({
      workCard: { sourceConversationId: 'conv_A' },
      deltas: [
        { conversationId: 'conv_B' }, { conversationId: 'conv_A' },
        { conversationId: undefined }, { conversationId: 'conv_B' },
      ],
    } as never);
    expect(ids).toEqual(['conv_A', 'conv_B']);
  });
});
