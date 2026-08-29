import {
  assertFailureDispositionConsistency,
  classifyFailure,
  type FailureCodebook,
} from './failureCodes';
import type { TestResult } from './types';

export function classifyTestResultFailure(
  result: TestResult,
  codebook: FailureCodebook,
): TestResult['failure'] {
  if (!['failed', 'partial', 'infra_excluded', 'cost_exceeded'].includes(result.status)) {
    return undefined;
  }
  const classified = classifyFailure({
    failureReason: result.failureReason,
    failureStage: result.failureStage,
    status: result.status,
    stderr: [
      ...result.errors,
      ...result.toolExecutions.flatMap((execution) => execution.error ? [execution.error] : []),
    ],
  }, codebook);
  const failure = {
    code: classified.primaryFailureCode,
    dispositions: classified.dispositions,
    symptoms: classified.matched,
  };
  assertFailureDispositionConsistency(result.status, failure.dispositions);
  return failure;
}
