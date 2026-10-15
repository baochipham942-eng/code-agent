/** Milliseconds in one civil day. Age is floor(elapsed / this); there is no threshold. */
const MS_PER_DAY = 86_400_000;

/**
 * Model-visible age line for one memory.
 * Days = floor((nowMs - writtenAtMs) / 86_400_000), clamped at 0
 * (future or non-finite timestamps read as today). Every age gets a line.
 * N >= 1 uses "N 天前"; N = 0 uses today wording. The trailing clause tells
 * the model to verify before stating the memory as current fact.
 */
export function formatMemoryAgeLine(writtenAtMs: number, nowMs: number): string {
  const elapsed = nowMs - writtenAtMs;
  const days = Number.isFinite(elapsed) ? Math.max(0, Math.floor(elapsed / MS_PER_DAY)) : 0;
  const when = days === 0 ? '今天' : ` ${days} 天前`;
  return `写于${when}，记录的是当时的状态，作为当前事实陈述前请先核对。`;
}

/** Insert `written:` immediately under the `source:` line. No age line leaves the block unchanged. */
export function withPackedWrittenLine(lines: readonly string[], ageLine: string | undefined): string[] {
  if (!ageLine) return [...lines];
  const sourceAt = lines.findIndex((line) => line.startsWith('  source:'));
  const at = sourceAt >= 0 ? sourceAt + 1 : lines.length;
  return [...lines.slice(0, at), `  written: ${ageLine}`, ...lines.slice(at)];
}
