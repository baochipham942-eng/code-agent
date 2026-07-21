export function nearestRankPercentile(values: readonly number[], percentile: number): number {
  if (values.length === 0) throw new Error('Percentile requires at least one sample.');
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 1) {
    throw new Error('Percentile must be greater than 0 and at most 1.');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil(percentile * sorted.length));
  return sorted[rank - 1];
}
