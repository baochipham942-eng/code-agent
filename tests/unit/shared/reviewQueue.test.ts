import { describe, expect, it } from 'vitest';
import {
  buildReviewQueueItemId,
  buildSessionTraceIdentity,
} from '../../../src/shared/contract/reviewQueue';

describe('review queue trace identity', () => {
  it('builds a stable session trace identity for replay and review', () => {
    const trace = buildSessionTraceIdentity('session-42');

    expect(trace).toEqual({
      traceId: 'session:session-42',
      source: 'session_replay',
      sessionId: 'session-42',
      replayKey: 'session-42',
    });
  });

  it('derives a deterministic review item id from the trace identity', () => {
    const trace = buildSessionTraceIdentity('session-42');

    expect(buildReviewQueueItemId(trace)).toBe('review:session:session-42');
    expect(buildReviewQueueItemId(trace)).toBe(buildReviewQueueItemId(buildSessionTraceIdentity('session-42')));
  });
});
