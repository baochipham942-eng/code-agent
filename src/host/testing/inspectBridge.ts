import { runAssertions, runExpectations } from './assertionEngine';
import type {
  ExpectationResult,
  TestCase,
  ToolExecutionRecord,
} from './types';

export interface InspectAssertionContext {
  toolExecutions: ToolExecutionRecord[];
  responses: string[];
  errors: string[];
  turnCount: number;
  workingDirectory: string;
}

export interface InspectCaseScore {
  testId: string;
  status: 'passed' | 'partial' | 'failed';
  score: number;
  failureReason?: string;
  legacy: Awaited<ReturnType<typeof runAssertions>>;
  expectationResults?: ExpectationResult[];
  hasCriticalFailure: boolean;
}

/**
 * Inspect scorer adapter for the existing eval assertion engine.
 *
 * Keep the precedence identical to TestRunner: legacy `expect` is evaluated
 * first, then P1 `expectations` replaces the final score when present.
 */
export async function scoreInspectCase(
  testCase: TestCase,
  context: InspectAssertionContext,
): Promise<InspectCaseScore> {
  const legacy = await runAssertions(testCase.expect, context);
  let score = legacy.score;
  let status: InspectCaseScore['status'] = legacy.passed
    ? 'passed'
    : legacy.score > 0
      ? 'partial'
      : 'failed';
  let failureReason = legacy.passed
    ? undefined
    : legacy.failures.map((failure) => failure.message).join('; ');
  let expectationResults: ExpectationResult[] | undefined;
  let hasCriticalFailure = legacy.hasCriticalFailure;

  if (testCase.expectations && testCase.expectations.length > 0) {
    const expectationScore = await runExpectations(testCase.expectations, context);
    score = expectationScore.overallScore;
    expectationResults = expectationScore.results;
    hasCriticalFailure = expectationScore.hasCriticalFailure;
    status = expectationScore.passed
      ? 'passed'
      : expectationScore.overallScore > 0 && !expectationScore.hasCriticalFailure
        ? 'partial'
        : 'failed';
    failureReason = expectationScore.passed
      ? undefined
      : expectationScore.results
        .filter((result) => !result.passed)
        .map((result) => `[${result.expectation.type}] ${result.evidence.details ?? 'failed'}`)
        .join('; ');
  }

  return {
    testId: testCase.id,
    status,
    score,
    ...(failureReason ? { failureReason } : {}),
    legacy,
    ...(expectationResults ? { expectationResults } : {}),
    hasCriticalFailure,
  };
}
