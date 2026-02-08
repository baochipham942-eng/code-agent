// ============================================================================
// Read Summarizer - Smart summaries for read_file results
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeRead(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return null;

  const content = String(output);
  const lines = content.split('\n').length;

  // Add file size estimate for context
  const charCount = content.length;
  if (charCount > 10000) {
    return `Read ${lines} lines (~${Math.round(charCount / 1024)}KB)`;
  }

  return `Read ${lines} lines`;
}
