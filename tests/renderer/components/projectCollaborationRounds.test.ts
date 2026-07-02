import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract/message';
import {
  extractNeoTopicRounds,
  mergeTopicRounds,
  topicConversationIds,
} from '../../../src/renderer/components/features/projectCollaboration/projectCollaborationData';
import { isInternalRuntimeText } from '../../../src/renderer/components/features/chat/neoWorkCardPhase';

function msg(over: Partial<Message> & Pick<Message, 'id' | 'role' | 'content'>): Message {
  return { timestamp: 0, ...over } as Message;
}

describe('extractNeoTopicRounds（topic 详情的多轮执行结果）', () => {
  const messages: Message[] = [
    msg({ id: 'u0', role: 'user', content: '普通聊天', timestamp: 1 }),
    msg({ id: 'a0', role: 'assistant', content: '普通回复', timestamp: 2 }),
    msg({ id: 'u1', role: 'user', content: '第一轮请求', timestamp: 3, metadata: { neoTag: { workCardId: 'nwc_1', runId: 'run_1' } } }),
    msg({ id: 'a1', role: 'assistant', content: '', timestamp: 4 }),
    msg({ id: 'a2', role: 'assistant', content: '第一轮中间说明', timestamp: 5 }),
    msg({ id: 'a3', role: 'assistant', content: '第一轮最终结论', timestamp: 6 }),
    msg({ id: 'u2', role: 'user', content: '第二轮请求', timestamp: 7, metadata: { neoTag: { workCardId: 'nwc_1', runId: 'run_2' } } }),
    msg({ id: 'a4', role: 'assistant', content: '第二轮结论', timestamp: 8 }),
    msg({ id: 'u3', role: 'user', content: '别的卡的请求', timestamp: 9, metadata: { neoTag: { workCardId: 'nwc_other' } } }),
    msg({ id: 'a5', role: 'assistant', content: '别的卡回复', timestamp: 10 }),
  ];

  it('groups rounds by this card\'s tagged user turns and keeps the final reply per round', () => {
    const rounds = extractNeoTopicRounds(messages, 'nwc_1');
    expect(rounds).toHaveLength(2);
    expect(rounds[0]).toMatchObject({ request: '第一轮请求', reply: '第一轮最终结论', at: 3 });
    expect(rounds[1]).toMatchObject({ request: '第二轮请求', reply: '第二轮结论', at: 7 });
  });

  it('leaves reply null for a round still running (无回复)', () => {
    const running = [
      msg({ id: 'u1', role: 'user', content: '在跑的请求', timestamp: 1, metadata: { neoTag: { workCardId: 'nwc_1' } } }),
    ];
    expect(extractNeoTopicRounds(running, 'nwc_1')).toEqual([
      { request: '在跑的请求', reply: null, at: 1 },
    ]);
  });

  it('ignores other cards and plain conversation turns', () => {
    expect(extractNeoTopicRounds(messages, 'nwc_none')).toEqual([]);
  });
});

describe('isInternalRuntimeText（运行时记账文案不进用户视野）', () => {
  it('flags runtime bookkeeping strings', () => {
    for (const text of [
      'Review the result and accept, revise, or archive the work card.',
      'Start local runtime execution.',
      'Approved work card entered the local Neo runtime queue.',
      'Runtime result is ready for work card review.',
      'Fix the runtime/provider error before retrying the approved work card.',
      'Answer the pending runtime request before continuing this work card.',
      'Check provider credentials/model availability, then revise or retry this work card.',
      'Runtime paused for user input or approval.',
      'Queued approved revision nwcr_abc',
      'Local Neo runtime run finished.',
      'Context audit: pack=x strategy=y',
    ]) {
      expect(isInternalRuntimeText(text), text).toBe(true);
    }
  });

  it('keeps real agent-written progress untouched', () => {
    expect(isInternalRuntimeText('接好清单入口')).toBe(false);
    expect(isInternalRuntimeText('查完了上海FDE薪资，结果在会话里')).toBe(false);
  });
});

describe('多会话轮聚合（ADR-033）', () => {
  it('aggregates rounds across the topic conversation set, ordered by time, each tagged with its conversation', () => {
    const messagesInConvA: Message[] = [
      msg({ id: 'u1', role: 'user', content: '@neo 整理竞品', timestamp: 10, metadata: { neoTag: { workCardId: 'nwc_1' } } }),
      msg({ id: 'a1', role: 'assistant', content: '第一轮结论', timestamp: 11 }),
    ];
    const messagesInConvB: Message[] = [
      msg({ id: 'u2', role: 'user', content: '补上定价维度', timestamp: 20, metadata: { neoTag: { workCardId: 'nwc_1' } } }),
      msg({ id: 'a2', role: 'assistant', content: '第二轮结论', timestamp: 21 }),
    ];
    const merged = mergeTopicRounds([
      extractNeoTopicRounds(messagesInConvA, 'nwc_1', 'conv_A'),
      extractNeoTopicRounds(messagesInConvB, 'nwc_1', 'conv_B'),
    ]);
    expect(merged.map((r) => r.conversationId)).toEqual(['conv_A', 'conv_B']);
    expect(merged.map((r) => r.reply)).toEqual(['第一轮结论', '第二轮结论']);
  });

  it('topicConversationIds derives the conversation set from source + delta ownership', () => {
    const ids = topicConversationIds({
      workCard: { sourceConversationId: 'conv_A' },
      deltas: [{ conversationId: 'conv_B' }, { conversationId: undefined }],
    } as never);
    expect(ids).toEqual(['conv_A', 'conv_B']);
  });
});
