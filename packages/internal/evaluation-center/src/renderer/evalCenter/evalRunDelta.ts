import type { EvalBaselineCaseResult } from '@shared/contract/evaluationBaseline';

export interface EvalRunTransition {
  caseId: string;
  kind: 'regressed' | 'fixed';
  from: string;
  to: string;
}

function side(status: string): 'pass' | 'fail' | null {
  if (status === 'passed') return 'pass';
  if (status === 'failed' || status === 'error') return 'fail';
  return null;
}

export function computeDeltaPp(currentRate: number | undefined, baselineRate: number): number | null {
  if (currentRate === undefined || Number.isNaN(currentRate)) return null;
  return (currentRate - baselineRate) * 100;
}

export function regressionsAgainstBaseline(
  baseline: Record<string, EvalBaselineCaseResult>,
  current: Record<string, EvalBaselineCaseResult>,
): { transitions: EvalRunTransition[]; uniqueCaseCount: number } {
  const transitions: EvalRunTransition[] = [];
  for (const [caseId, currentResult] of Object.entries(current)) {
    const baselineResult = baseline[caseId];
    if (!baselineResult) continue;
    const from = side(baselineResult.status);
    const to = side(currentResult.status);
    if (!from || !to || from === to) continue;
    transitions.push({
      caseId,
      kind: to === 'fail' ? 'regressed' : 'fixed',
      from: baselineResult.status,
      to: currentResult.status,
    });
  }
  transitions.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'regressed' ? -1 : 1;
    return a.caseId.localeCompare(b.caseId);
  });
  const ids = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  const shared = Object.keys(baseline).filter((id) => id in current).length;
  return { transitions, uniqueCaseCount: ids.size - shared };
}

export function comparabilityTag(input: {
  baselineAggregationRuleVersion: number;
  runAggregationRuleVersion?: number;
  baselineCaseBankSha: string;
  runCaseBankSha: string;
}): 'comparable' | 'case-bank-updated' | 'old-rule' {
  if (input.runAggregationRuleVersion === undefined
    || input.runAggregationRuleVersion !== input.baselineAggregationRuleVersion) return 'old-rule';
  return input.runCaseBankSha !== input.baselineCaseBankSha ? 'case-bank-updated' : 'comparable';
}
