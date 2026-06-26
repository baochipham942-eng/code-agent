import { describe, expect, it } from 'vitest';
import { MonotonicityTracker } from '../../../src/host/agent/runtime/repair/monotonicityTracker';

describe('MonotonicityTracker', () => {
  it('keeps improved rounds and warns on regressions', () => {
    const tracker = new MonotonicityTracker();

    expect(tracker.recordRound(0, 3, ['combo failed'])).toMatchObject({
      verdict: 'same',
      keep: true,
      revert: false,
      warn: false,
    });

    expect(tracker.recordRound(1, 5, [])).toMatchObject({
      verdict: 'improved',
      previousPassCount: 3,
      keep: true,
      revert: false,
    });

    expect(tracker.recordRound(2, 2, ['stomp regressed'])).toMatchObject({
      verdict: 'regressed',
      previousPassCount: 5,
      keep: false,
      revert: true,
      warn: true,
      regressedFailures: ['stomp regressed'],
    });
  });

  it('can score repair patches by using negative problem counts', () => {
    const tracker = new MonotonicityTracker();
    tracker.recordRound(0, -4, ['four failures']);

    expect(tracker.recordRound(1, -2, ['two failures'])).toMatchObject({
      verdict: 'improved',
      keep: true,
    });
  });
});
