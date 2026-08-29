import type { TestResult, TestStatus } from './types';

interface AggregatedTrials {
  status: TestStatus;
  passCount: number;
  trialCount: number;
  passAtK: number;
  passCaretK: number;
  unstable: boolean;
}

type TrialLike = Pick<TestResult, 'status' | 'score' | 'invalid' | 'telemetryGate'>;

function validateK(k: number): void {
  if (!Number.isInteger(k) || k < 1) {
    throw new Error(`k must be a positive integer, received ${k}`);
  }
}

/** C(successes, k) / C(total, k), evaluated as a product to avoid factorial overflow. */
function combinationRatio(successes: number, total: number, k: number): number {
  if (successes < k) return 0;
  let ratio = 1;
  for (let index = 0; index < k; index += 1) {
    ratio *= (successes - index) / (total - index);
  }
  return Math.max(0, Math.min(1, ratio));
}

function isPassingTrial(trial: TrialLike): boolean {
  return trial.status === 'passed'
    && trial.invalid === undefined
    && trial.telemetryGate?.passed !== false;
}

/**
 * Aggregate repeated attempts using the combination estimators used by Cline/HumanEval:
 * pass@k asks whether at least one of k sampled attempts succeeds; pass^k asks whether all do.
 * Infrastructure-only attempts carry no capability observation and therefore do not enter n.
 */
export function aggregateTrials(trials: TrialLike[], k: number): AggregatedTrials {
  validateK(k);
  const observed = trials.filter((trial) => trial.status !== 'infra_excluded');
  // All requested attempts completed, so an n < k gap here can only come from infra exclusions.
  // The case carries no comparable capability result; an actually short run still throws below.
  if (observed.length < k && trials.length >= k) {
    const passCount = observed.filter(isPassingTrial).length;
    return {
      status: 'infra_excluded',
      passCount,
      trialCount: observed.length,
      passAtK: 0,
      passCaretK: 0,
      unstable: false,
    };
  }
  if (observed.length < k) {
    throw new Error(`Cannot aggregate k=${k} from only n=${observed.length} observed trials`);
  }

  const passCount = observed.filter(isPassingTrial).length;
  const trialCount = observed.length;
  const passAtK = 1 - combinationRatio(trialCount - passCount, trialCount, k);
  const passCaretK = combinationRatio(passCount, trialCount, k);
  const statuses = new Set(observed.map((trial) => isPassingTrial(trial)));

  return {
    status: passCaretK === 1 ? 'passed' : 'failed',
    passCount,
    trialCount,
    passAtK: Math.max(0, Math.min(1, passAtK)),
    passCaretK,
    unstable: statuses.size > 1,
  };
}

/**
 * Small-K correction from Wang, "Measuring all the noises of LLM Evals"
 * (arXiv:2512.21326, Appendix A.2): add b = populationVariance / (K - 1).
 * This is algebraically the sample variance with denominator K - 1. The correction is per
 * question, so its 1/(K - 1) bias does not disappear merely by evaluating more questions.
 */
export function correctedSampleStats(values: number[]): { variance: number; stdDev: number } | undefined {
  if (values.length < 2) return undefined;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const populationVariance = values.reduce(
    (sum, value) => sum + (value - mean) ** 2,
    0,
  ) / values.length;
  const variance = populationVariance + populationVariance / (values.length - 1);
  return { variance, stdDev: Math.sqrt(variance) };
}
