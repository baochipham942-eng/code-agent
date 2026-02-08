// ============================================================================
// Glob Summarizer - Smart summaries for glob search results
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeGlob(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return 'No matches';

  // Handle array output
  if (Array.isArray(output)) {
    if (output.length === 0) return 'No matches';
    if (output.length === 1) {
      return `Found 1 file: ${shortenPath(output[0])}`;
    }
    return `Found ${output.length} files`;
  }

  // Handle string output (newline separated)
  const outputStr = String(output).trim();
  if (!outputStr) return 'No matches';

  const lines = outputStr.split('\n').filter(Boolean);
  if (lines.length === 0) return 'No matches';

  if (lines.length === 1) {
    return `Found 1 file: ${shortenPath(lines[0])}`;
  }
  return `Found ${lines.length} files`;
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}
