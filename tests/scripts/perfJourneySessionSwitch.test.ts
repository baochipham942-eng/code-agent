import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey session-switch slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-session-switch').files).toEqual([
      'tests/scripts/perfJourneySessionSwitch.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('session-switch');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('session-switch commitCount current=');
  }, 90_000);
});
