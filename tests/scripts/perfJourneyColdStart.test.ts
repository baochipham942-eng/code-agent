import { describe, expect, it } from 'vitest';
import { journeyRule, runJourneyRatchet, shouldRunJourneyProbe } from '../../scripts/perf/journey-probe-test-support.ts';

describe('perf-journey cold-start slot', () => {
  it('occupies exactly one gates:fast file slot', () => {
    expect(journeyRule('perf-journey-cold-start').files).toEqual([
      'tests/scripts/perfJourneyColdStart.test.ts',
    ]);
  });

  it.skipIf(!shouldRunJourneyProbe())('commit count holds the baseline', () => {
    const result = runJourneyRatchet('cold-start');
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('cold-start commitCount current=');
  }, 90_000);
});
