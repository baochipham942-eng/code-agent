export interface EvalStatusLabels {
  passed: string;
  failed: string;
  infra: string;
  invalid: string;
  skipped: string;
  costExceeded: string;
  notRun: string;
  partial: string;
  error: string;
}

export type EvalDisplayStatus =
  | 'pending'
  | 'running'
  | 'passed'
  | 'failed'
  | 'skipped'
  | 'partial'
  | 'infra_excluded'
  | 'invalid'
  | 'cost_exceeded'
  | 'not_run'
  | 'error';

export function getEvalStatusLabel(status: EvalDisplayStatus, labels: EvalStatusLabels): string {
  if (status === 'passed') return labels.passed;
  if (status === 'failed') return labels.failed;
  if (status === 'partial') return labels.partial;
  if (status === 'infra_excluded') return labels.infra;
  if (status === 'invalid') return labels.invalid;
  if (status === 'cost_exceeded') return labels.costExceeded;
  if (status === 'skipped') return labels.skipped;
  if (status === 'not_run' || status === 'pending' || status === 'running') return labels.notRun;
  return labels.error;
}
