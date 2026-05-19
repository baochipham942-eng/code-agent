import { describe, expect, it } from 'vitest';
import { buildSessionTraceIdentity } from '../../../src/shared/contract/reviewQueue';

describe('review queue trace identity', () => {
  it('builds a stable session trace identity for replay and review', () => {
    const trace = buildSessionTraceIdentity('session-42');

    expect(trace).toEqual({
      traceId: 'session:session-42',
      traceSource: 'session_replay',
      source: 'session_replay',
      sessionId: 'session-42',
      replayKey: 'session-42',
    });
  });

});
