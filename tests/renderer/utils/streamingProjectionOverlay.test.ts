import { describe, expect, it } from 'vitest';
import type { Message } from '../../../src/shared/contract';
import type { TraceProjection } from '../../../src/shared/contract/trace';
import { applyStreamingMessageDeltasToProjection } from '../../../src/renderer/utils/streamingProjectionOverlay';

describe('applyStreamingMessageDeltasToProjection', () => {
  it('overlays accumulator deltas onto an existing assistant text node', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          nodes: [
            { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
            { id: 'assistant-1-text', type: 'assistant_text', content: 'hello', timestamp: 120, reasoning: 'r1' },
          ],
        },
      ],
    };

    const next = applyStreamingMessageDeltasToProjection(
      projection,
      [],
      {
        'assistant-1': {
          contentDelta: ' world',
          reasoningDelta: 'r2',
          updatedAt: 200,
        },
      },
    );

    expect(next.turns[0].nodes[1]).toMatchObject({
      content: 'hello world',
      reasoning: 'r1r2',
    });
    expect(next).not.toBe(projection);
  });

  it('synthesizes an assistant text node for an empty base assistant message', () => {
    const messages: Message[] = [
      { id: 'user-1', role: 'user', content: 'question', timestamp: 100 },
      { id: 'assistant-1', role: 'assistant', content: '', timestamp: 120, toolCalls: [] },
    ];
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: 0,
      turns: [
        {
          turnNumber: 1,
          turnId: 'turn-1',
          status: 'streaming',
          startTime: 100,
          nodes: [
            { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
          ],
        },
      ],
    };

    const next = applyStreamingMessageDeltasToProjection(
      projection,
      messages,
      {
        'assistant-1': {
          contentDelta: 'streamed answer',
          reasoningDelta: '',
          updatedAt: 200,
        },
      },
    );

    expect(next.turns[0].nodes).toHaveLength(2);
    expect(next.turns[0].nodes[1]).toMatchObject({
      id: 'assistant-1-text',
      type: 'assistant_text',
      content: 'streamed answer',
    });
  });

  it('returns the original projection when there are no active deltas', () => {
    const projection: TraceProjection = {
      sessionId: 'session-1',
      activeTurnIndex: -1,
      turns: [],
    };

    expect(applyStreamingMessageDeltasToProjection(projection, [], {})).toBe(projection);
  });
});
