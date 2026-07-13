// ============================================================================
// Tool name helpers
// ============================================================================

/**
 * Normalize semantic aliases used by different protocol surfaces.
 *
 * The protocol schema exposes `Bash`, while older permission paths and tests
 * still use `bash`. Keep this helper deliberately narrow so unrelated tool names
 * remain case-sensitive.
 */
export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  return trimmed.toLowerCase() === 'bash' ? 'bash' : trimmed;
}

const CANONICAL_TOOL_ALIASES: Record<string, string> = {
  agentspawn: 'spawn_agent',
  spawn_agent: 'spawn_agent',
  websearch: 'web_search',
  web_search: 'web_search',
  webfetch: 'web_fetch',
  web_fetch: 'web_fetch',
};

/**
 * Collapse protocol-era aliases for downstream policy/citation code.
 *
 * Keep this intentionally smaller than a general case-insensitive normalizer:
 * only names with a proven compatibility contract are folded.
 */
export function canonicalToolName(toolName: string): string {
  const normalized = normalizeToolName(toolName);
  return CANONICAL_TOOL_ALIASES[normalized.toLowerCase()] ?? normalized;
}

export function isBashToolName(toolName: string): boolean {
  return normalizeToolName(toolName) === 'bash';
}

export function sameToolName(left: string, right: string): boolean {
  return normalizeToolName(left) === normalizeToolName(right);
}
