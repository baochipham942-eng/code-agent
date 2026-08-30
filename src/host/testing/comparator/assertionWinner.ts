import type { ExpectationResult, TestResult, TestStatus } from '../types';
import { aggregateTrials } from '../trialAggregation';
import { mergeSkillActivations } from '../skillSelection';

export interface AssertionWinnerDecision {
  winner: 'baseline' | 'candidate' | 'tie';
  passRateA: number;
  passRateB: number;
  assertionCount: number;
}

const EXCLUDED_STATUSES = new Set<TestStatus>([
  'infra_excluded',
  'not_run',
  'cost_exceeded',
]);

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

  // invalid 判废优先（FAKECLOSED 语义，与 testRunner 代表试次同口径）：不看试次顺序，
  // 只要有一次没调真模型就按无效题排除，不让先到的 infra 试次把它遮掉。
  const excluded = results.find((result) => result.invalid)
    ?? results.find((result) => EXCLUDED_STATUSES.has(result.status));
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
    skillActivations: mergeSkillActivations(results),
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
  };
}
