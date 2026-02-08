// ============================================================================
// Grep Summarizer - Smart summaries for grep search results
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeGrep(toolCall: ToolCall): string | null {
  const output = toolCall.result?.output;
  if (!output) return 'No matches';

  // Handle structured output format (files array)
  if (typeof output === 'object' && output !== null && 'files' in output) {
    const files = (output as { files: string[] }).files;
    if (files.length === 0) return 'No matches';

    const firstFile = shortenPath(files[0]);
    if (files.length === 1) {
      return `Found 1 result in ${firstFile}`;
    }
    return `Found ${files.length} results`;
  }

  // Handle text output
  const outputStr = String(output).trim();
  if (!outputStr) return 'No matches';

  const lines = outputStr.split('\n').filter(Boolean);
  if (lines.length === 0) return 'No matches';

  // Extract file path from first match (format: file:line:content)
  const firstMatch = lines[0];
  const colonIndex = firstMatch.indexOf(':');

  if (colonIndex > 0) {
    const filePath = firstMatch.slice(0, colonIndex);
    const lineNum = extractLineNumber(firstMatch.slice(colonIndex + 1));

    if (lines.length === 1) {
      return `Found 1 result in ${shortenPath(filePath)}${lineNum ? `:${lineNum}` : ''}`;
    }
    return `Found ${lines.length} results`;
  }

  // If no file path pattern, just count matches
  if (lines.length === 1) {
    return `Found 1 result`;
  }
  return `Found ${lines.length} results`;
}

function shortenPath(path: string): string {
  const parts = path.split('/');
  if (parts.length <= 3) return path;
  return '.../' + parts.slice(-2).join('/');
}

function extractLineNumber(str: string): string | null {
  const match = str.match(/^(\d+):/);
  return match ? match[1] : null;
}
