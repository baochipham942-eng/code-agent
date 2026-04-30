import { describe, expect, it } from 'vitest';
import type { TraceProjection, TraceTurn } from '../../../src/shared/contract/trace';
import {
  getFocusedTurnIndex,
  shouldFollowTurnOutput,
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
});
