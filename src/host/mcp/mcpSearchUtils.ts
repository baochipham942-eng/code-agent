// ============================================================================
// MCP Search & Batch Helpers（mcpClient 专用）
// ============================================================================

export const CUA_SEARCH_KEYWORDS = new Set(['computer', 'desktop', 'screen', 'cursor', 'cua', 'driver']);

export function extractMcpSearchKeywords(query: string): string[] {
  const normalized = query
    .replace(/^select:/i, '')
    .replace(/^mcp__/i, '')
    .toLowerCase();

  const rawTokens = normalized
    .split(/[^a-z0-9_-]+/)
    .map((token) => token.trim())
    .filter((token) => token.length >= 3 && token !== 'mcp');

  const expanded = new Set<string>();
  for (const token of rawTokens) {
    expanded.add(token);
    for (const part of token.split(/[-_]+/)) {
      if (part.length >= 3) expanded.add(part);
    }
  }

  return Array.from(expanded);
}

/** Process items in batches with concurrency control. */
export async function processBatched<T>(
  items: T[],
  batchSize: number,
  processor: (item: T) => Promise<void>,
): Promise<void> {
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    await Promise.allSettled(batch.map(processor));
  }
}
