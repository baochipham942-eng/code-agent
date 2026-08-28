import type { TestCase, TestResult } from './types';

export interface CompletedPlannedResults {
  results: TestResult[];
  completed: boolean;
  notRun: number;
}

export function createNotRunResult(testCase: TestCase, reason?: string): TestResult {
  const now = Date.now();
  return {
    testId: testCase.id,
    description: testCase.description,
    prompt: testCase.prompt,
    followUpPrompts: testCase.follow_up_prompts,
    status: 'not_run',
    duration: 0,
    startTime: now,
    endTime: now,
    toolExecutions: [],
    responses: [],
    errors: [],
    turnCount: 0,
    score: 0,
    failureReason: `轮次中断：${reason || '计划题集未执行完'}`,
  };
}

/** 按计划顺序补齐未执行题，并在补齐前判断本轮是否真正跑满。 */
export function completePlannedResults(
  plannedCases: TestCase[],
  executedResults: TestResult[],
  aborted: boolean,
  abortReason?: string,
): CompletedPlannedResults {
  const resultById = new Map(executedResults.map((result) => [result.testId, result]));
  const completedBeforeFill = plannedCases.every((testCase) => resultById.has(testCase.id));
  const results = plannedCases.map(
    (testCase) => resultById.get(testCase.id) ?? createNotRunResult(testCase, abortReason),
  );
  const notRun = results.filter((result) => result.status === 'not_run').length;
  return {
    results,
    completed: !aborted && completedBeforeFill && notRun === 0,
    notRun,
  };
}

export function markInvalidResultWithoutModel(result: TestResult, isMockRun: boolean): void {
  if (
    !isMockRun
    && result.status !== 'not_run'
    && (result.mockExcluded !== undefined || result.usageStatus === 'usage_unavailable')
  ) {
    result.invalid = {
      reason: result.mockExcluded !== undefined ? 'mock_excluded' : 'usage_unavailable',
    };
  }
}
