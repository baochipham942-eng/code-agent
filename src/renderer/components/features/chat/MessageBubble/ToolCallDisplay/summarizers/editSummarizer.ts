// ============================================================================
// Edit Summarizer - Smart summaries for edit_file and write_file results
// ============================================================================

import type { ToolCall } from '@shared/types';

export function summarizeEdit(toolCall: ToolCall): string | null {
  // For successful edit_file, show Done or line change info
  if (toolCall.result?.success) {
    // Try to calculate line diff from arguments
    const oldString = toolCall.arguments?.old_string as string | undefined;
    const newString = toolCall.arguments?.new_string as string | undefined;

    if (oldString && newString) {
      const oldLines = oldString.split('\n').length;
      const newLines = newString.split('\n').length;
      const diff = newLines - oldLines;

      if (diff > 0) {
        return `+${diff} lines`;
      } else if (diff < 0) {
        return `${diff} lines`;
      }
      return 'Modified';
    }

    return 'Done';
  }

  return null;
}

export function summarizeWrite(toolCall: ToolCall): string | null {
  // For successful write_file, show Done or content info
  if (toolCall.result?.success) {
    const content = toolCall.arguments?.content as string | undefined;
    if (content) {
      const lines = content.split('\n').length;
      return `${lines} lines`;
    }
    return 'Done';
  }

  return null;
}
