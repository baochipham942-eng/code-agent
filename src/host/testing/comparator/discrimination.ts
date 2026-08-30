import type { EvalBaseline } from '../types';

export interface DiscriminationEstimate {
  totalCases: number;
  discriminatingCases: number;
  ratio: number;
  shouldWarn: boolean;
}

/** Baseline score is the available per-case historical pass-rate proxy. */
export function estimateDiscrimination(
  caseIds: readonly string[],
  baseline: EvalBaseline | null,
): DiscriminationEstimate {
  const discriminatingCases = caseIds.filter((caseId) => {
    const passRate = baseline?.caseResults[caseId]?.score;
    return passRate !== undefined && passRate >= 0.2 && passRate <= 0.8;
  }).length;
  const ratio = caseIds.length > 0 ? discriminatingCases / caseIds.length : 0;
  return {
    totalCases: caseIds.length,
    discriminatingCases,
    ratio,
    shouldWarn: caseIds.length > 0 && ratio < 0.3,
  };
}
