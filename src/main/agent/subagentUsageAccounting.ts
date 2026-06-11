export interface SubagentUsage {
  cost: number;
  tokensUsed: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

export function extractSubagentUsage(metadata: unknown): SubagentUsage {
  if (!isRecord(metadata)) {
    return { cost: 0, tokensUsed: 0 };
  }

  const result = isRecord(metadata.result) ? metadata.result : undefined;
  const source = result ?? metadata;

  return {
    cost: finiteNumber(source.cost),
    tokensUsed: finiteNumber(source.tokensUsed),
  };
}

export function addSubagentUsage(
  current: SubagentUsage,
  next: unknown,
): SubagentUsage {
  const usage = isRecord(next) && (typeof next.cost === 'number' || typeof next.tokensUsed === 'number')
    ? { cost: finiteNumber(next.cost), tokensUsed: finiteNumber(next.tokensUsed) }
    : extractSubagentUsage(next);

  return {
    cost: current.cost + usage.cost,
    tokensUsed: current.tokensUsed + usage.tokensUsed,
  };
}
