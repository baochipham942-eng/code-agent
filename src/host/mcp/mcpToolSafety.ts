import type { MCPToolAnnotations } from './types';

export type MCPToolReplaySafety = 'automatic' | 'unknown' | 'forbidden';

/** Shared conservative read-only test used by scheduling, permissions, and replay. */
export function isMcpToolReadOnly(annotations?: MCPToolAnnotations): boolean {
  return annotations?.readOnlyHint === true && annotations.destructiveHint !== true;
}

/**
 * Classify whether an interrupted tools/call may be replayed with a new MCP request id.
 * Destructive always wins when annotations conflict; missing hints fail closed.
 */
export function classifyMcpToolReplaySafety(
  annotations?: MCPToolAnnotations,
): MCPToolReplaySafety {
  if (annotations?.destructiveHint === true) return 'forbidden';
  if (isMcpToolReadOnly(annotations) || annotations?.idempotentHint === true) {
    return 'automatic';
  }
  return 'unknown';
}
