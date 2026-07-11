import { describe, expect, it } from 'vitest';
import type { TraceProjection, TraceTurn } from '../../../src/shared/contract/trace';
import {
  ACTIVE_DISPLAY_SCROLL_INTERVAL_MS,
  USER_SCROLL_PROGRAMMATIC_PAUSE_MS,
  getActiveDisplayScrollDelay,
  getActiveAssistantTextAnchor,
  getFocusedTurnIndex,
  getOutputFollowTurnIndex,
  getTurnOutputRevision,
  getTraceNodeSelector,
  getTraceTurnSelector,
  getUserScrollSuppressionUntil,
  isProgrammaticScrollSuppressed,
  isScrollerNearBottom,
  shouldStopFollowingForKeyboardScroll,
  shouldStopFollowingForTouchMove,
  shouldStopFollowingForWheel,
  shouldFollowTurnOutput,
  shouldShowTurnTimeSeparator,
  getPrependedTurnCount,
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
  it('counts only leading history turns inserted before the previous first turn', () => {
    expect(getPrependedTurnCount('turn-1', [makeTurn(-2), makeTurn(-1), makeTurn(0)]))
      .toBe(2);
    expect(getPrependedTurnCount('turn-1', [makeTurn(0), makeTurn(1)]))
      .toBe(0);
    expect(getPrependedTurnCount('missing', [makeTurn(0), makeTurn(1)]))
      .toBe(0);
  });

  it('focuses the active turn while a run is streaming', () => {
    expect(getFocusedTurnIndex(makeProjection(1))).toBe(1);
  });

  it('falls back to the latest turn when no turn is active', () => {
    expect(getFocusedTurnIndex(makeProjection(-1))).toBe(2);
  });

  it('returns -1 when there are no turns', () => {
    expect(getFocusedTurnIndex(makeProjection(-1, 0))).toBe(-1);
  });

  it('uses the active turn as the output follow target while streaming', () => {
    expect(getOutputFollowTurnIndex(makeProjection(1), null, false)).toBe(1);
  });

  it('keeps following the completed turn after streaming finishes', () => {
    expect(getOutputFollowTurnIndex(makeProjection(-1), 'turn-2', true)).toBe(1);
  });

  it('stops following completed output after the user leaves the bottom', () => {
    expect(getOutputFollowTurnIndex(makeProjection(-1), 'turn-2', false)).toBe(-1);
  });

  it('does not force bottom-follow when the viewport is away from the bottom', () => {
    expect(shouldFollowTurnOutput(false)).toBe(false);
    expect(shouldFollowTurnOutput(true)).toBe('auto');
  });

  it('treats short or near-bottom scrollers as bottom anchored', () => {
    expect(isScrollerNearBottom({ scrollHeight: 400, scrollTop: 0, clientHeight: 700 })).toBe(true);
    expect(isScrollerNearBottom({ scrollHeight: 900, scrollTop: 120, clientHeight: 700 })).toBe(true);
    expect(isScrollerNearBottom({ scrollHeight: 1200, scrollTop: 200, clientHeight: 700 })).toBe(false);
  });

  it('keeps the active output visible after the view programmatically focused a new turn', () => {
    expect(shouldFollowTurnOutput(false, true)).toBe('auto');
    expect(shouldFollowTurnOutput(true, true)).toBe('auto');
  });

  it('pauses programmatic follow while the user is actively scrolling', () => {
    expect(shouldFollowTurnOutput(true, false, true)).toBe(false);
    expect(shouldFollowTurnOutput(true, true, true)).toBe(false);
  });

  it('suppresses programmatic scroll briefly after a user scroll gesture', () => {
    const now = 1_000;
    const until = getUserScrollSuppressionUntil(now);

    expect(until).toBe(now + USER_SCROLL_PROGRAMMATIC_PAUSE_MS);
    expect(isProgrammaticScrollSuppressed(until, until - 1)).toBe(true);
    expect(isProgrammaticScrollSuppressed(until, until)).toBe(false);
  });

  it('only stops output following for gestures that move toward older content', () => {
    expect(shouldStopFollowingForWheel(-1)).toBe(true);
    expect(shouldStopFollowingForWheel(1)).toBe(false);
    expect(shouldStopFollowingForTouchMove(100, 104)).toBe(true);
    expect(shouldStopFollowingForTouchMove(100, 97)).toBe(false);
    expect(shouldStopFollowingForTouchMove(null, 104)).toBe(false);
    expect(shouldStopFollowingForKeyboardScroll('ArrowUp')).toBe(true);
    expect(shouldStopFollowingForKeyboardScroll('PageDown')).toBe(false);
    expect(shouldStopFollowingForKeyboardScroll(' ', true)).toBe(true);
    expect(shouldStopFollowingForKeyboardScroll(' ', false)).toBe(false);
  });

  it('throttles active display scroll scheduling within the display interval', () => {
    expect(getActiveDisplayScrollDelay(0, 1_000)).toBe(0);
    expect(getActiveDisplayScrollDelay(1_000, 1_020)).toBe(
      ACTIVE_DISPLAY_SCROLL_INTERVAL_MS - 20,
    );
    expect(getActiveDisplayScrollDelay(1_000, 1_200)).toBe(0);
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

  it('can ignore streaming assistant text length so display pacing drives scroll', () => {
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

    expect(
      getTurnOutputRevision(nextTurn, { includeAssistantContentLength: false }),
    ).toBe(getTurnOutputRevision(baseTurn, { includeAssistantContentLength: false }));
  });

  it('can ignore hidden thinking length so collapsed reasoning does not drive scroll', () => {
    const baseTurn: TraceTurn = {
      turnNumber: 1,
      turnId: 'turn-1',
      status: 'streaming',
      startTime: 100,
      nodes: [
        { id: 'user-1', type: 'user', content: 'question', timestamp: 100 },
        {
          id: 'assistant-1',
          type: 'assistant_text',
          content: '',
          reasoning: 'thinking',
          timestamp: 120,
        },
      ],
    };
    const nextTurn: TraceTurn = {
      ...baseTurn,
      nodes: [
        baseTurn.nodes[0],
        {
          ...baseTurn.nodes[1],
          reasoning: 'thinking with more streamed hidden reasoning',
        },
      ],
    };

    expect(getTurnOutputRevision(nextTurn)).not.toBe(getTurnOutputRevision(baseTurn));
    expect(
      getTurnOutputRevision(nextTurn, { includeThinkingLength: false }),
    ).toBe(getTurnOutputRevision(baseTurn, { includeThinkingLength: false }));
  });

  it('builds a selector for trace node anchors', () => {
    expect(getTraceNodeSelector('assistant-1', 'assistant_text')).toBe(
      '[data-trace-node-id="assistant-1"][data-trace-node-type="assistant_text"]',
    );
  });

  it('builds a selector for trace turn anchors', () => {
    expect(getTraceTurnSelector('turn-"1"')).toBe(
      '[data-trace-turn-id="turn-\\"1\\""]',
    );
  });
});
