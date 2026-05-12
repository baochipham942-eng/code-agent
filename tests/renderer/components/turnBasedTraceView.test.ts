import { describe, expect, it } from 'vitest';
import type { TraceProjection, TraceTurn } from '../../../src/shared/contract/trace';
import {
  getActiveAssistantTextAnchor,
  getFocusedTurnIndex,
  getTurnOutputRevision,
  getTraceNodeSelector,
  shouldFollowTurnOutput,
  shouldShowTurnTimeSeparator,
} from '../../../src/renderer/components/features/chat/TurnBasedTraceView';

function makeTurn(index: number): TraceTurn {
  return {
    turnNumber: index + 1,
    turnId: `turn-${index + 1}`,
    nodes: [],
    status: 'completed',
    startTime: 100 + index,
  };
}

function makeProjection(activeTurnIndex: number, turnCount = 3): TraceProjection {
  return {
    sessionId: 'session-1',
    turns: Array.from({ length: turnCount }, (_, index) => makeTurn(index)),
    activeTurnIndex,
  };
}

describe('TurnBasedTraceView focus helpers', () => {
  it('focuses the active turn while a run is streaming', () => {
    expect(getFocusedTurnIndex(makeProjection(1))).toBe(1);
  });

  it('falls back to the latest turn when no turn is active', () => {
    expect(getFocusedTurnIndex(makeProjection(-1))).toBe(2);
  });

  it('returns -1 when there are no turns', () => {
    expect(getFocusedTurnIndex(makeProjection(-1, 0))).toBe(-1);
  });

  it('does not force bottom-follow when the viewport is away from the bottom', () => {
    expect(shouldFollowTurnOutput(false)).toBe(false);
    expect(shouldFollowTurnOutput(true)).toBe('smooth');
  });

  it('keeps the active output visible after the view programmatically focused a new turn', () => {
    expect(shouldFollowTurnOutput(false, true)).toBe('auto');
    expect(shouldFollowTurnOutput(true, true)).toBe('auto');
  });

  it('only shows turn time separators for the first turn or meaningful gaps', () => {
    expect(shouldShowTurnTimeSeparator(null, { startTime: 1_000 })).toBe(true);
    expect(shouldShowTurnTimeSeparator({ startTime: 1_000 }, { startTime: 60_000 })).toBe(false);
    expect(shouldShowTurnTimeSeparator({ startTime: 1_000 }, { startTime: 301_000 })).toBe(true);
  });

  it('finds the first assistant text node in the active turn', () => {
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
            { id: 'assistant-1', type: 'assistant_text', content: 'answer', timestamp: 120 },
          ],
        },
      ],
    };

    expect(getActiveAssistantTextAnchor(projection)).toEqual({
      turnIndex: 0,
      nodeId: 'assistant-1',
      nodeType: 'assistant_text',
    });
  });

  it('changes the active output revision when streaming text grows', () => {
    const baseTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        { id: 'assistant-1', type: 'assistant_text', content: 'short answer', timestamp: 120 },
      ],
    };
    const nextTurn: TraceTurn = {
      ...baseTurn,
      nodes: [
        baseTurn.nodes[0],
        {
          ...baseTurn.nodes[1],
          content: 'short answer with more streamed content',
        },
      ],
    };

    expect(getTurnOutputRevision(nextTurn)).not.toBe(getTurnOutputRevision(baseTurn));
  });

  it('builds a selector for trace node anchors', () => {
    expect(getTraceNodeSelector('assistant-1', 'assistant_text')).toBe(
      '[data-trace-node-id="assistant-1"][data-trace-node-type="assistant_text"]',
    );
  });
});
