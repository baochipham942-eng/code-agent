// ============================================================================
// Default Summarizer - Fallback summaries for other tools
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeDefault(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;

  // No output
  if (!output) return 'Done';

  // Object type
  if (typeof output === 'object') {
    // Check for common message fields
    if ('message' in output) {
      return String((output as Record<string, unknown>).message).slice(0, 60);
    }
    // Check for count field
    if ('count' in output) {
      return `${(output as Record<string, unknown>).count} items`;
    }
    // Check for files field
    if ('files' in output && Array.isArray((output as Record<string, unknown>).files)) {
      const files = (output as Record<string, unknown>).files as unknown[];
      return `${files.length} files`;
    }
    return 'Done';
  }

  // String type
  const str = String(output).trim();
  if (str.length === 0) return 'Done';

  // Short single-line output - display directly
  if (str.length < 60 && !str.includes('\n')) {
    return str;
  }

  // Multi-line - just say Done
  return 'Done';
}
