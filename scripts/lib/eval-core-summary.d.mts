/** eval-ci 报告 JSON（generateJsonReport 产物）里摘要用到的子集 */
export interface CoreReport {
  total?: number;
  passed?: number;
  skipped?: number;
  infraExcluded?: number;
  costExceeded?: number;
  results?: Array<{ testId: string; status: string; costUsd?: number }>;
  environment?: { model?: string; provider?: string; endpoint?: string };
  stamp?: { scorers?: { judgeModel?: string } };
}
export function reportIdentity(report: CoreReport | undefined): { subject: string; judge: string };
export function detectModelDrift(previous: CoreReport | undefined, current: CoreReport): string | null;
export function capabilityPassRate(report: CoreReport): number;
export function actualCostUsd(report: CoreReport): number | null;
export function regressedCases(previous: CoreReport | undefined, current: CoreReport): string[];
export function buildCoreSummary(input: {
  current: CoreReport;
  previous?: CoreReport;
  exitCode: number;
  reportPath?: string;
}): string;
