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
    // 默认归因（ADR-071 D2）：跟着最高优先码走，报告里单独一栏，不进聚合口径。
    ...(classified.attribution ? { attribution: classified.attribution } : {}),
  };
  try {
    assertFailureDispositionConsistency(result.status, failure.dispositions);
  } catch {
    const message = '失败原因分类与统计状态不一致，已将本题归入未归类，本轮继续执行。';
    result.failureReason = result.failureReason
      ? `${result.failureReason}; ${message}`
      : message;
    return {
      ...failure,
      code: 'unknown',
      attribution: undefined,
      symptoms: [...new Set([...failure.symptoms, 'disposition_inconsistent'])],
    };
  }
  return failure;
}
