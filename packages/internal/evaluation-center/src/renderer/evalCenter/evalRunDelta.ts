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

/** 连续几轮全过就视为零区分度；只标不动统计。 */
export const ALWAYS_PASSED_WINDOW = 5;

/** 最近 window 轮（newest-first）里每轮都 passed 的题；不足 window 轮返回空集（没资格说「全过」）。 */
export function alwaysPassedCaseIds(
  runs: Array<Record<string, EvalBaselineCaseResult>>,
  window = ALWAYS_PASSED_WINDOW,
): Set<string> {
  const recent = runs.slice(0, window);
  if (recent.length < window) return new Set();
  return new Set(Object.keys(recent[0]).filter((caseId) => recent.every((run) => run[caseId]?.status === 'passed')));
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
