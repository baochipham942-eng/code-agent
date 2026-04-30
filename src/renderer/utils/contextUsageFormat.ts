export function formatContextUsagePercent(percent: number): string {
  const normalizedPercent = Math.min(100, Math.max(0, percent));
  if (normalizedPercent > 0 && normalizedPercent < 10) {
    return normalizedPercent.toFixed(1);
  }
  return String(Math.round(normalizedPercent));
}
