import type { ExpectationResult, TestResult, TestStatus } from '../types';
import { aggregateTrials } from '../trialAggregation';

export interface AssertionWinnerDecision {
  winner: 'baseline' | 'candidate' | 'tie';
  passRateA: number;
  passRateB: number;
  assertionCount: number;
  excludedReason?: string;
}

const EXCLUDED_STATUSES = new Set<TestStatus>([
  'infra_excluded',
  'not_run',
  'cost_exceeded',
]);

function excludedStatusReason(role: 'baseline' | 'candidate', result: TestResult): string | null {
  if (!EXCLUDED_STATUSES.has(result.status)) return null;
  return `${role}: ${result.status}${result.failureReason ? `（${result.failureReason}）` : ''}`;
}

/** Only deterministic assertion rows can participate in the experiment conclusion. */
function deterministicAssertionResults(result: TestResult): ExpectationResult[] {
  if (result.scoreAuthority !== 'deterministic_assertion') return [];
  return result.expectationResults ?? [];
}

/**
 * Collapse k raw trials with pass^k semantics at assertion-row granularity.
 * One failed/missing row in any trial makes that row fail for the case.
 */
export function aggregateAssertionTrials(results: TestResult[]): TestResult {
  const [first] = results;
  if (!first) throw new Error('aggregateAssertionTrials requires at least one trial');
  if (results.length === 1) return first;

  const excluded = results.find((result) => EXCLUDED_STATUSES.has(result.status) || result.invalid);
  const rows = deterministicAssertionResults(first).map((row, index) => ({
    ...row,
    passed: results.every((result) => deterministicAssertionResults(result)[index]?.passed === true),
  }));
  const passedRows = rows.filter((row) => row.passed).length;
  const score = rows.length > 0 ? passedRows / rows.length : 0;
  const aggregate = aggregateTrials(results, results.length);
  const status: TestStatus = excluded?.status ?? aggregate.status;

  return {
    ...first,
    status,
    score,
    duration: results.reduce((sum, result) => sum + result.duration, 0),
    endTime: Math.max(...results.map((result) => result.endTime)),
    expectationResults: rows,
    trialAggregate: {
      n: aggregate.trialCount,
      c: aggregate.passCount,
      passAtK: aggregate.passAtK,
      passCaretK: aggregate.passCaretK,
      rule: 'pass_caret_k',
    },
    ...(excluded?.invalid ? { invalid: excluded.invalid } : {}),
    ...(excluded?.failureReason ? { failureReason: excluded.failureReason } : {}),
    trials: results.map((result) => ({
      score: result.score,
      status: result.status,
      duration_ms: result.duration,
      ...(result.sessionId ? { sessionId: result.sessionId } : {}),
      ...(result.replayKey ? { replayKey: result.replayKey } : {}),
      ...(result.failureStage ? { failureStage: result.failureStage } : {}),
      ...(result.failureReason ? { failureReason: result.failureReason } : {}),
      ...(result.errors.length > 0 ? { errors: result.errors } : {}),
      ...(result.usageStatus ? { usageStatus: result.usageStatus } : {}),
      ...(result.mockExcluded ? { mockExcluded: result.mockExcluded } : {}),
      ...(result.invalid ? { invalid: result.invalid } : {}),
    })),
  };
}

/** Inputs A/B are baseline/candidate respectively; ABGrader output is intentionally ignored. */
export function decideCaseWinner(
  baseline: TestResult,
  candidate: TestResult,
): AssertionWinnerDecision {
  const excludedReason = [
    excludedStatusReason('baseline', baseline),
    excludedStatusReason('candidate', candidate),
  ].filter((reason): reason is string => Boolean(reason)).join('; ');

  const assertionsA = deterministicAssertionResults(baseline);
  const assertionsB = deterministicAssertionResults(candidate);
  const passRateA = assertionsA.length > 0
    ? assertionsA.filter((result) => result.passed).length / assertionsA.length
    : 0;
  const passRateB = assertionsB.length > 0
    ? assertionsB.filter((result) => result.passed).length / assertionsB.length
    : 0;
  const winner = passRateA > passRateB
    ? 'baseline'
    : passRateB > passRateA
      ? 'candidate'
      : 'tie';

  return {
    winner,
    passRateA,
    passRateB,
    assertionCount: Math.max(assertionsA.length, assertionsB.length),
    ...(excludedReason ? { excludedReason } : {}),
  };
}
