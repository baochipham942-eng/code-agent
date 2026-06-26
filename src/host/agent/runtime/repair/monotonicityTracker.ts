export type MonotonicityVerdictKind = 'improved' | 'regressed' | 'same';

export interface MonotonicityVerdict {
  roundN: number;
  verdict: MonotonicityVerdictKind;
  passCount: number;
  previousPassCount?: number;
  failures: string[];
  regressedFailures: string[];
  keep: boolean;
  revert: boolean;
  warn: boolean;
  reason: string;
}

interface MonotonicityRound {
  roundN: number;
  passCount: number;
  failures: string[];
}

export class MonotonicityTracker {
  private baseline: MonotonicityRound | null = null;

  recordRound(roundN: number, passCount: number, failures: string[]): MonotonicityVerdict {
    const current: MonotonicityRound = {
      roundN,
      passCount,
      failures: [...failures],
    };

    if (!this.baseline) {
      this.baseline = current;
      return {
        roundN,
        verdict: 'same',
        passCount,
        failures: current.failures,
        regressedFailures: [],
        keep: true,
        revert: false,
        warn: false,
        reason: 'initial baseline recorded',
      };
    }

    const previous = this.baseline;
    if (passCount > previous.passCount) {
      this.baseline = current;
      return {
        roundN,
        verdict: 'improved',
        passCount,
        previousPassCount: previous.passCount,
        failures: current.failures,
        regressedFailures: [],
        keep: true,
        revert: false,
        warn: false,
        reason: `pass count improved from ${previous.passCount} to ${passCount}`,
      };
    }

    if (passCount < previous.passCount) {
      const regressedFailures = current.failures.filter((failure) => !previous.failures.includes(failure));
      return {
        roundN,
        verdict: 'regressed',
        passCount,
        previousPassCount: previous.passCount,
        failures: current.failures,
        regressedFailures,
        keep: false,
        revert: true,
        warn: true,
        reason: `pass count regressed from ${previous.passCount} to ${passCount}`,
      };
    }

    this.baseline = current;
    return {
      roundN,
      verdict: 'same',
      passCount,
      previousPassCount: previous.passCount,
      failures: current.failures,
      regressedFailures: [],
      keep: true,
      revert: false,
      warn: false,
      reason: `pass count stayed at ${passCount}`,
    };
  }
}
