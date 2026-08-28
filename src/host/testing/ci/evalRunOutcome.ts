import type { BaselineDelta, TestRunSummary } from '../types';

/** 0=跑满且无回归，1=回归，2=未跑满或存在无效题。 */
export function getEvalProcessExitCode(
  summary: TestRunSummary,
  delta?: BaselineDelta,
): 0 | 1 | 2 {
  if (!summary.completed || summary.notRun > 0 || summary.invalidCases > 0) return 2;
  if (delta?.comparable === true && delta.isRegression) return 1;
  return 0;
}
