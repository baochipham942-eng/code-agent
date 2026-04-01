// ============================================================================
// Cache Break Detection - Detects when prompt caching would be invalidated
// ============================================================================
// Used by M4-S4 request normalizer to decide whether to set cache_control.
// The key insight: only static prefix changes invalidate the cache.
// Dynamic section changes (memory, rules, reminders) should not count.
// ============================================================================

export interface CacheBreakResult {
  broken: boolean;
  reason: string;
}

export interface CacheBreakOptions {
  prevModel?: string;
  currModel?: string;
  dynamicBoundary?: string;
}

export const DYNAMIC_BOUNDARY_MARKER = '\n<!-- DYNAMIC_SECTION -->\n';

/**
 * Detects whether the prompt cache would be broken between two turns.
 *
 * Returns broken=true if:
 * 1. The model changed (different tokenizer → different cache key)
 * 2. The static prefix (before DYNAMIC_BOUNDARY_MARKER) changed
 *
 * Dynamic section changes after the boundary marker are ignored.
 */
export function detectCacheBreak(
  prevPrompt: string,
  currPrompt: string,
  options?: CacheBreakOptions,
): CacheBreakResult {
  // Check model change
  if (options?.prevModel && options?.currModel && options.prevModel !== options.currModel) {
    return { broken: true, reason: `model changed: ${options.prevModel} → ${options.currModel}` };
  }

  const boundary = options?.dynamicBoundary ?? DYNAMIC_BOUNDARY_MARKER;

  const [prevPrefix] = splitAtBoundary(prevPrompt, boundary);
  const [currPrefix] = splitAtBoundary(currPrompt, boundary);

  if (prevPrefix !== currPrefix) {
    return { broken: true, reason: 'static prefix changed' };
  }

  return { broken: false, reason: 'cache stable' };
}

/**
 * Splits a prompt at the DYNAMIC_BOUNDARY_MARKER.
 *
 * Returns [prefix, dynamic]:
 * - prefix: everything before the marker (the cacheable stable section)
 * - dynamic: everything after the marker (per-turn content)
 * - If no marker is found, returns [fullPrompt, '']
 */
export function splitAtDynamicBoundary(prompt: string): [string, string] {
  return splitAtBoundary(prompt, DYNAMIC_BOUNDARY_MARKER);
}

// Internal helper that accepts a custom boundary string
function splitAtBoundary(prompt: string, boundary: string): [string, string] {
  const idx = prompt.indexOf(boundary);
  if (idx === -1) {
    return [prompt, ''];
  }
  return [prompt.slice(0, idx), prompt.slice(idx + boundary.length)];
}
