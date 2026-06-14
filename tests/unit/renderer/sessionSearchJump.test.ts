import { describe, expect, it } from 'vitest';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import {
  createPendingSearchJumpFromCrossSessionResult,
  findSearchMatchForPendingJump,
} from '../../../src/renderer/utils/sessionSearchJump';

function projection(): TraceProjection {
  return {
    sessionId: 'session-1',
    activeTurnIndex: -1,
    turns: [
      {
        turnNumber: 1,
        turnId: 'turn-1',
        status: 'completed',
        startTime: 1,
        nodes: [
          {
            id: 'user-1',
            type: 'user',
            content: 'Start the project',
            timestamp: 1,
          },
          {
            id: 'assistant-1-text',
            messageId: 'assistant-1',
            type: 'assistant_text',
            content: 'First part mentions artifacts but has no target.',
            timestamp: 2,
          },
          {
            id: 'assistant-1-text-2',
            messageId: 'assistant-1',
            type: 'assistant_text',
            content: 'Second part contains needle here.',
            timestamp: 2,
          },
        ],
      },
      {
        turnNumber: 2,
        turnId: 'turn-2',
        status: 'completed',
        startTime: 3,
        nodes: [
          {
            id: 'user-2',
            type: 'user',
            content: 'Follow up on artifacts',
            timestamp: 3,
          },
        ],
      },
    ],
  };
}

describe('sessionSearchJump', () => {
  it('builds a pending jump from a cross-session search result', () => {
    expect(createPendingSearchJumpFromCrossSessionResult({
      sessionId: 'session-2',
      sessionTitle: 'Prior work',
      messageId: 'message-9',
      messageIndex: 8,
      turnNumber: 4,
      role: 'assistant',
      snippet: 'matched text',
      timestamp: 123,
      matchOffset: 17,
      matchCount: 2,
      relevance: 0.8,
    }, '  Needle  ', 999)).toEqual({
      sessionId: 'session-2',
      messageId: 'message-9',
      messageIndex: 8,
      turnNumber: 4,
      matchOffset: 17,
      query: 'Needle',
      createdAt: 999,
    });
  });

  it('finds the node containing the query inside a split assistant message', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      matchOffset: 42,
      query: 'needle',
      createdAt: 10,
    })).toEqual({ turnIndex: 0, nodeIndex: 2, offset: 21 });
  });

  it('falls back to the matching message node when the query is unavailable', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'assistant-1',
      query: 'missing',
      createdAt: 10,
    })).toEqual({ turnIndex: 0, nodeIndex: 1, offset: 0 });
  });

  it('uses message id lookup before query-only lookup', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      messageId: 'user-2',
      query: 'artifacts',
      createdAt: 10,
    })).toEqual({ turnIndex: 1, nodeIndex: 0, offset: 13 });
  });

  it('uses the searched turn number before global query lookup when message id is unavailable', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'session-1',
      turnNumber: 2,
      query: 'artifacts',
      createdAt: 10,
    })).toEqual({ turnIndex: 1, nodeIndex: 0, offset: 13 });
  });

  it('rejects jumps for a different session', () => {
    expect(findSearchMatchForPendingJump(projection(), {
      sessionId: 'other-session',
      query: 'needle',
      createdAt: 10,
    })).toBeNull();
  });
});
