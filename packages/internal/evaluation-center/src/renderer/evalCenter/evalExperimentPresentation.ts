import type {
  EvalCompareArm,
  EvalExperimentListItem,
  EvalRunEventSummary,
  EvalShipGateVerdict,
} from '@shared/contract/evaluation';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function getExperimentCompareSummary(item: EvalExperimentListItem): NonNullable<EvalRunEventSummary['compare']> | null {
  const compare = item.summary?.compare;
  return compare?.shipGate ? compare : null;
}

export function getExperimentCompareConfig(item: EvalExperimentListItem): {
  baseline: EvalCompareArm;
  candidate: EvalCompareArm;
  diff: string[];
} | null {
  const compare = item.config?.compare;
  if (!isRecord(compare) || !isRecord(compare.baseline) || !isRecord(compare.candidate) || !Array.isArray(compare.diff)) return null;
  return {
    baseline: compare.baseline as unknown as EvalCompareArm,
    candidate: compare.candidate as unknown as EvalCompareArm,
    diff: compare.diff.filter((value): value is string => typeof value === 'string'),
  };
}

export function getExperimentCost(item: EvalExperimentListItem): number | undefined {
  const raw = item.config?.estimatedCostUsd;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw * 2 : undefined;
}

export function failingSafetyCount(verdict: EvalShipGateVerdict): number {
  return verdict.hardGate.items
    .filter((item) => item.status === 'fail')
    .reduce((total, item) => total + (item.count ?? 1), 0);
}

export function stateClasses(state: EvalShipGateVerdict['state']): string {
  if (state === 'candidate_better') return 'border-badge-success bg-badge-success text-badge-success';
  if (state === 'non_inferior') return 'border-badge-info bg-badge-info text-badge-info';
  if (state === 'candidate_worse') return 'border-badge-danger bg-badge-danger text-badge-danger';
  return 'border-zinc-700 bg-zinc-800 text-zinc-300';
}
