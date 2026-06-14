import { describe, expect, it } from 'vitest';
import {
  inferConversationTurnNumbers,
  searchSessions,
} from '../../../src/main/session/search';
import { SessionLocalCache } from '../../../src/main/session/localCache';

describe('session search', () => {
  it('infers conversation turn numbers from cached message order', () => {
    expect(inferConversationTurnNumbers([
      { id: 'system-1', role: 'system', content: 'Boot', timestamp: 1 },
      { id: 'user-1', role: 'user', content: 'First task', timestamp: 2 },
      { id: 'assistant-1', role: 'assistant', content: 'First answer', timestamp: 3 },
      { id: 'system-2', role: 'system', content: 'Notice', timestamp: 4 },
      { id: 'user-2', role: 'user', content: 'Second task', timestamp: 5 },
      { id: 'assistant-2', role: 'assistant', content: 'Second answer', timestamp: 6 },
    ])).toEqual([
      undefined,
      1,
      1,
      1,
      2,
      2,
    ]);
  });

  it('includes inferred turn numbers in search results', () => {
    const cache = new SessionLocalCache();
    cache.setSession({
      sessionId: 'session-1',
      startedAt: 1,
      lastActivityAt: 6,
      totalTokens: 0,
      messages: [
        { id: 'user-1', role: 'user', content: 'First task', timestamp: 1 },
        { id: 'assistant-1', role: 'assistant', content: 'No match here', timestamp: 2 },
        { id: 'user-2', role: 'user', content: 'Second task', timestamp: 3 },
        { id: 'assistant-2', role: 'assistant', content: 'Needle appears here', timestamp: 4 },
      ],
    });

    const result = searchSessions('Needle', { sessionIds: ['session-1'] }, cache);

    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      sessionId: 'session-1',
      messageIndex: 3,
      turnNumber: 2,
    });
  });

  it('keeps runtime supplements inside the current renderer turn', () => {
    const messages = [
      { id: 'user-1', role: 'user' as const, content: 'First task', timestamp: 1 },
      { id: 'assistant-1', role: 'assistant' as const, content: 'First answer', timestamp: 2 },
      {
        id: 'user-supplement-1',
        role: 'user' as const,
        content: 'Needle supplement',
        timestamp: 3,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
          },
        },
      },
      { id: 'assistant-2', role: 'assistant' as const, content: 'Supplement handled', timestamp: 4 },
      {
        id: 'user-queued-1',
        role: 'user' as const,
        content: 'Queued next task',
        timestamp: 5,
        metadata: {
          workbench: {
            runtimeInputMode: 'supplement',
            runtimeInputDelivery: 'queued_next_turn',
          },
        },
      },
    ];

    expect(inferConversationTurnNumbers(messages)).toEqual([1, 1, 1, 1, 2]);
  });
});
