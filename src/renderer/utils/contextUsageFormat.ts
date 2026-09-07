import { ESTIMATE_DEVIATION_DISPLAY_PERCENT } from '@shared/contract/contextHealth';

export function clampUsagePercent(percent: number): number {
  return Math.min(100, Math.max(0, percent));
}

export function formatContextUsagePercent(percent: number): string {
  const normalizedPercent = clampUsagePercent(percent);
  if (normalizedPercent > 0 && normalizedPercent < 10) {
    return normalizedPercent.toFixed(1);
  }
  return String(Math.round(normalizedPercent));
}

export function isContextWindowKnown(health: { windowKnown?: boolean } | null | undefined): boolean {
  return health?.windowKnown !== false;
}

export function shouldShowEstimateDeviation(deviationPercent: number | null): boolean {
  return deviationPercent !== null && Math.abs(deviationPercent) >= ESTIMATE_DEVIATION_DISPLAY_PERCENT;
}

/** 桶占比 / 分桶条共用的分母：展示桶合计，不拿窗口上限或预算周期冒充。 */
export function bucketSharePercent(tokens: number, denominator: number): number {
  if (denominator <= 0) return 0;
  return (tokens / denominator) * 100;
}
