// ============================================================================
// Tool name helpers
// ============================================================================

/**
 * Normalize semantic aliases used by different protocol generations.
 *
 * The protocol schema exposes `Bash`, while older permission paths and tests
 * still use `bash`. Keep this helper deliberately narrow so unrelated tool names
 * remain case-sensitive.
 */
export function normalizeToolName(toolName: string): string {
  const trimmed = toolName.trim();
  return trimmed.toLowerCase() === 'bash' ? 'bash' : trimmed;
}

export function isBashToolName(toolName: string): boolean {
  return normalizeToolName(toolName) === 'bash';
}

export function sameToolName(left: string, right: string): boolean {
  return normalizeToolName(left) === normalizeToolName(right);
}
